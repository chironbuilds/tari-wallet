# Patched `@tari-project/ootle` (temporary, remove once upstream releases a fix)

The published `@tari-project/ootle@0.1.0` (frozen since 2026-06-01 — see
[tari-project/ootle.ts#117](https://github.com/tari-project/ootle.ts/issues/117)) sends a
`StealthTransferStatement` missing the `covenant_claims` field, which the current protocol's
wire struct requires. Omitting it makes the whole transaction fail server-side deserialization
with a generic `"data did not match any variant of untagged enum TransactionInput"` — the
missing-field error on the deeply-nested statement isn't surfaced directly.

This is a locally-built `dist/` from `tari-project/ootle.ts`'s `main` branch (commit
`2bc5e93e`) with two changes on top of upstream:

1. One line changed in `packages/ootle/src/stealth/statements.ts`:
   `StealthTransferStatement.toCompactJson()` now always includes `"covenant_claims":[]` (correct
   for every transfer this wallet builds, since none of them spend an input gated by a `Script`
   spend condition). Built against `@tari-project/ootle-wasm@0.37.0` (via a local
   `pnpm-workspace.yaml` catalog override), not the `^0.32.0` the published package pins
   internally — see the same issue thread for why that version gap mattered too (a JSON wrapper
   key inside stealth output witnesses renamed `spend_condition` -> `auth` between those
   versions).
2. `packages/ootle/src/stealth/transfer.ts`'s `StealthTransfer` builder gained two new public
   methods, `toRevealedOutputAsBucket(amount, workspaceVarName)` and `andThen(instructions)`.
   Upstream's `toRevealedOutput()` always auto-deposits the revealed change back into the
   source account — there's no way to get it as a bucket a caller can route elsewhere. The new
   methods leave it on the workspace instead and let extra instructions run in the *same* signed
   transaction, consuming that bucket. This exists because a third-party dApp calling
   `tari_signAndSubmitTransaction` cannot move Stealth-typed funds (e.g. XTR) into its own
   contract call at all otherwise — a plain `CallMethod withdraw` on a Stealth vault is not a
   standalone-valid instruction (confirmed: fails identically, client-side, with the exact same
   `TransactionInput` error below, even with zero custom-contract involvement); moving Stealth
   funds anywhere always requires the native `StealthTransfer` instruction, paired with
   `WalletStealthAuthorizer` to sign it — which `account.execute()` never invokes. See
   `withdrawStealthAndExecute` in `src/lib/wallet.ts` for the wallet-side method that uses this.
   **`toRevealedOutputAsBucket` callers must still include ≥1 real `toStealthOutput`** (a small
   dust self-output is enough, exactly what `withdrawStealthAndExecute` does) — a statement with
   *zero* stealth outputs at all is not a shape the bundled `ootle-wasm@0.37.0` signer can parse,
   confirmed live: it throws the same generic `TransactionInput` error inside `signTransaction`'s
   own WASM call regardless of how `balance_proof` is represented (present, `null`, or omitted —
   all three tried and ruled out before finding the real cause).

**CONFIRMED WORKING END-TO-END LIVE** (2026-08-06): a real sealed bid placed through
`tari-dex/dao-ui` via a connected Sapient wallet on esmeralda succeeded — `withdrawStealthAndExecute`
revealed XTR into a bucket and fed it straight into a custom DAO contract's `get_bid_credits` →
`place_bid` chain, all in one wallet-signed transaction. Getting there past this patch required
two *more* fixes that live outside this package (not part of `@tari-project/ootle` at all):

- **`WorkspaceOffsetId`/`WorkspaceId` wire format**: a dApp building raw instructions by hand
  (bypassing this SDK's own `TransactionBuilder`, which auto-resolves *name*-based
  `{Workspace:"name"}` args to real ids via `saveVar`/`resolveArgs`) must emit the real wire shape
  directly — `WorkspaceId` is a plain `u16` (`PutLastInstructionOutputOnWorkspace.key`), and
  `WorkspaceOffsetId` is `{id: u16, offset: Option<usize>}` (any `Workspace` arg) — confirmed
  against `tari_ootle_transaction`'s `args.rs`. `dao-ui/src/tari.ts` previously invented a
  name-based `{offset:[name]}` shape that happened to typecheck but was never real — it worked by
  accident as long as a dApp's instructions never mixed with this SDK's own internally-numbered
  ones, which `withdrawStealthAndExecute`'s spliced-in `andThen` instructions do. Also: ids are a
  single flat counter across the *whole* transaction, so a dApp splicing instructions in after
  `withdrawStealthAndExecute`'s internal StealthTransfer (which always claims ids 0 and 1) must
  number its own workspace vars starting from 2.
- **Missing transaction inputs**: `withdrawStealthAndExecute`'s `relatedComponents` param
  auto-registers a component + its own vaults, but not a *resource*'s own substate — a dApp
  instruction like `withdraw_confidential(someResource, ...)` needs that resource's address
  listed explicitly too (`SubstateNotFound` otherwise), same requirement `unshield()`'s own doc
  comment already calls out for the transferred resource itself.

Wired in via `pnpm-workspace.yaml`'s `overrides: '@tari-project/ootle': 'file:./vendor/ootle-patched'`
in the main project. The source clone lives at `tari-wallet-extension/vendor/ootle-src/` (gitignored
build input, not part of the published patch) — to rebuild after further edits:
`cd vendor/ootle-src/packages/ootle && npx tsc -b && npx vite build`, then copy `dist/index.js` +
`dist/index.d.ts` into this directory's `dist/`.

Delete `vendor/ootle-patched/` and `vendor/ootle-src/` and the override once `@tari-project/ootle`
publishes a release past 2026-06-01 that includes fix 1 (or once a PR upstreaming it merges) —
re-verify shield/unshield *and* the bucket-output/`andThen` capability against whatever version
ships, since fix 2 has no upstream equivalent at all yet and would need to be re-proposed.
