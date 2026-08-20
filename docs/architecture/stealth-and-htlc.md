# Stealth Balances and HTLCs

Ootle's privacy primitive is the **Stealth** resource type — a UTXO model layered on top of the
account/vault model everything else uses, where a token's value and recipient are hidden behind
Pedersen commitments and one-time keys rather than a plain on-chain balance. This page covers how
this wallet handles Stealth balances, and how HTLC-locked outputs are built on top of the same
machinery.

## Shield / unshield: moving between revealed and private

- **Shield** takes a plain (revealed) balance and creates a new Stealth output for it, addressed to
  this account's own wallet address.
- **Unshield** does the reverse: spends one or more of this account's own Stealth outputs and
  reveals the value back into the account's plain balance.

Both go through the same underlying builder (`StealthTransfer` + `WalletStealthAuthorizer` from the
vendored `@tari-project/ootle` SDK), which:

1. builds the *outputs* side — one commitment + AEAD-encrypted value/mask per output, plus an
   aggregated bulletproof range proof;
2. resolves and unblinds any *inputs* being spent (fetching each UTXO, decrypting it with this
   account's own view key to recover its mask);
3. signs a balance proof over both sides, proving no value was created or destroyed;
4. produces a one-time Schnorr signature per spent input, derived via Diffie-Hellman between the
   owner's key and the output's sender nonce — this is what actually authorizes spending a
   key-owned Stealth output, distinct from the account's normal transaction-sealing signature.

**A plain `withdraw` CallMethod on a Stealth vault is not a standalone-valid instruction.** Moving
Stealth-typed funds always requires the native `StealthTransfer` instruction, built and signed via
this pipeline — `OotleAccount.execute()`'s generic path never invokes it. This is why
`tari_withdrawStealthAndExecute` exists as its own dedicated operation: it's the only way for a
connected dApp to move Stealth-typed funds (e.g. XTR) into its own contract call, by revealing the
funds as a workspace bucket and appending the caller's own instructions in the same signed
transaction.

## HTLC-locked outputs

An HTLC (hashed timelock contract) output is a Stealth output whose spend authority isn't a normal
one-time key at all, but a **condition tree** (TIP-0006 `PayTo::Conditions`) — a small Merkle tree
of alternative spend paths, only the root of which is committed on-chain. `src/lib/htlc.ts` builds
the specific two-leaf shape this wallet uses:

- **Claim leaf**: SHA-256 hashlock of a secret, AND before a refund epoch, AND the claimant's
  public key.
- **Refund leaf**: at/after the refund epoch, AND the refunder's (funder's own) public key.

"The claimant's/refunder's public key" is expressed as an `AccessRule` requiring proof of a
*virtual* non-fungible badge derived directly from that public key
(`PUBLIC_IDENTITY_RESOURCE_ADDRESS`, a well-known, protocol-fixed resource) — the engine
auto-populates this proof for any signer of the transaction, so it's satisfied by the claimant or
refunder simply signing normally, no extra signature dance required.

`OotleAccount.htlcFund()` creates this output — pointed at the *claimant's* wallet address (not the
funder's), so the claimant can independently decrypt and verify the funded amount themselves, the
same as any other stealth payment addressed to them. Spend authority is governed entirely
separately, by the condition tree. The funder never sees or needs the actual secret, only its hash.

### What's built, and what isn't

**Funding, claiming, and refunding all work today** at the `OotleAccount` level
(`htlcFund`/`htlcClaim`/`htlcRefund` in `src/lib/wallet.ts`). Spending a script-conditioned output
needed two things neither the published SDK nor (until recently) the wasm crypto module it wraps
could do — both now shipped in a real, officially published `@tari-project/ootle-wasm` release:

1. Building the actual **script-path witness** — revealing one leaf of the condition tree plus its
   Merkle inclusion proof and any required witness data (the preimage, for a claim). Exposed
   upstream in [tari-project/tari-ootle#2426](https://github.com/tari-project/tari-ootle/pull/2426)
   as `buildScriptPathWitness`.
2. Assembling a **complete, internally-consistent transfer statement** — inputs statement, outputs
   statement, balance proof, and a covenant balance claim per condition-root partition among the
   spent script-path inputs — from unblinded input/output witnesses, in one call. Exposed upstream
   in [tari-project/tari-ootle#2431](https://github.com/tari-project/tari-ootle/pull/2431) as
   `buildStealthTransferStatement`. (Confirmed live, via `htlc.test.ts`'s real-wasm round-trip
   test: a covenant claim gets generated *unconditionally* per partition, regardless of what the
   revealed leaf actually gates on — separate from whether the engine's `covenant_balanced` ever
   reads it back at spend time, which for every leaf this wallet's HTLCs use — `HashLock`,
   `AfterEpoch`/`BeforeEpoch`, `AccessRule` — it never does.)

`htlcClaim`/`htlcRefund` deliberately **bypass** the vendored SDK's own
`StealthTransfer`/`WalletStealthAuthorizer` builder pipeline rather than patching it to understand
script-path inputs: that pipeline is hard-wired to always derive a one-time DH signature per spent
input, which doesn't apply to a script-path spend at all (its authorization is the revealed leaf's
own `AccessRule`, satisfied by this account's *normal* transaction signature). Both build a
complete statement directly via `buildStealthTransferStatement`, then submit through the same
plain `TransactionBuilder` → `resolveTransaction` → `signTransaction` → `sealTransaction` pipeline
any ordinary `CallMethod`-only transaction uses — see `buildHtlcSpendStatement`/`submitHtlcSpend`'s
own doc comments in `wallet.ts` for the exact assembly.

**The refund side has one design wrinkle worth knowing**: `htlcFund` addresses the output to the
*claimant's* wallet address (so the claimant can independently decrypt/verify it, same as any
normal incoming payment) — which means the *funder* cannot decrypt that same output later to
recover its mask the normal way if a refund becomes necessary. `htlcFund` closes this by also
returning `outputMask` — the one point at which the funder legitimately has it, since it's the
aggregated output mask `StealthTransfer.prepare()` already computes for the single output it just
created. A caller that discards this return value has no recovery path for a future refund.

**Not yet wired**: `htlcClaim`/`htlcRefund` exist at the account level, verified by a real-wasm
test that the statements they build pass the engine's own `validateStealthTransfer`, and by the
full extension build/typecheck/test suite — but have **no live validator/indexer round trip**
behind them yet (no funded HTLC has actually been claimed or refunded end-to-end on a running
network from this environment), and are **not yet exposed** through the extension's dApp-facing
RPC surface (`tari_htlcClaim`/`tari_htlcRefund`, `tari_getCapabilities` flags, approval-popup
summaries) the way `htlcFund` is — that's a distinct, scoped follow-up mirroring `htlcFund`'s own
existing wiring in `messages.ts`/`background/index.ts`.

### `tari_getCapabilities` reflects this honestly

`scriptPathSpend` in the capabilities response is `false` today, and will stay `false` until
claim/refund are wired into the RPC surface *and* verified against a real running network — not
flipped to `true` the moment the account-level methods exist. `htlcFund` is `true` for a local
(`OotleAccount`) connection, `false` for a daemon-relayed one, matching the same key-material split
described in
[Accounts and Signing](accounts-and-signing.md).
