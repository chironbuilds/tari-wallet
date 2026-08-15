# Patched `@tari-project/ootle-wasm` -- NOT CURRENTLY IN USE (see pnpm-workspace.yaml)

**This directory's override was reverted on 2026-08-15.** `pnpm-workspace.yaml` currently pins
`@tari-project/ootle-wasm` back to the published `^0.37.0`, *not* this vendored copy. Read the
"What went wrong" section below before re-enabling it.

## Why this exists

The published `@tari-project/ootle-wasm` (`0.37.0` pinned, `0.38.0` also published and checked —
byte-identical `.d.ts`, no relevant change) has no way to spend a stealth output created with
`PayTo::Conditions` (an HTLC-style hashlock/timelock condition tree). Output creation itself
already works via `createStealthOutputWitness`'s `pay_to_json` — the underlying Rust
(`pay_to_output_authorization`) already handles every `PayTo` variant, it's just undocumented in
the wasm binding's own `.d.ts` comment. But nothing exposed the *spend* side: building a
`SpendWitness::ScriptPath` (reveal one condition-tree leaf + its Merkle inclusion proof + optional
witness data, e.g. a hashlock preimage) or attaching a non-key-path witness to a `StealthInput`.

Fixed upstream, merged: [tari-project/tari-ootle#2426](https://github.com/tari-project/tari-ootle/pull/2426)
(merged 2026-08-14, commit `36f5253`), adding two purely-additive exports:
`buildScriptPathWitness(conditionsJson, leafJson, data)` and
`buildStealthInputsStatementFromInputs(inputsJson, revealedAmountMicrotari)`. A follow-up,
[tari-project/tari-ootle#2431](https://github.com/tari-project/tari-ootle/pull/2431) (open, not yet
merged as of 2026-08-15), adds `buildStealthTransferStatement` for correct covenant-claim
generation -- the piece still needed before claim/refund can be built safely. See those PRs'
descriptions and `tari_ootle_scriptpath_htlc.md` in this session's memory for the full
investigation.

This `pkg/` was built from `tari-project/tari-ootle`'s `development` branch (commit `015673116`,
which includes the merge of #2426), via `bash crates/ootle_wasm/build.sh bundler release`.

## What went wrong (read this before ever re-enabling)

**This vendored build broke real, ordinary (non-stealth) transaction signing.** Confirmed live,
twice, via `tari-dex/swap-ui`: a plain token-creation `CallMethod` transaction, submitted through
*both* the wallet's old and new dApp-facing RPC paths, was rejected server-side with `HTTP 400:
"... is invalid: Invalid transaction signature"` while this override was active. Reverting
`@tari-project/ootle-wasm` back to the published `^0.37.0` (no other change) fixed it immediately.

Root cause was never pinned down precisely, but the likely explanation is straightforward:
`development` branch HEAD had accumulated a large number of commits *unrelated* to #2426 since
`0.37.0`/`0.38.0` was cut (the workspace version alone jumped `0.37.0` → `0.39.0` across the same
build). Any one of those could have changed transaction hashing/signing wire format in a way the
live (older, stable) validator/indexer no longer accepts. The mistake was testing only the *new*
stealth/HTLC exports this build was vendored for, never a plain CallMethod transaction end-to-end
-- so a regression affecting *every* transaction, not just the new feature, shipped unnoticed.

**Before ever re-enabling this override (or re-vendoring a newer build the same way):**
1. Build from the oldest commit that has what you need (ideally the exact merge commit of the
   target PR, not whatever `development` HEAD happens to be that day) -- minimize the unrelated
   diff, don't just grab the latest tip.
2. Run a real, live, non-dry-run **plain transaction** (e.g. swap-ui's "Create Token") through the
   built extension before trusting it for anything else. Passing typecheck/test/build and even a
   live *stealth-specific* round trip (which is what happened here) is not sufficient evidence that
   ordinary signing still works.
3. Prefer waiting for a real `@tari-project/ootle-wasm` npm release over vendoring from a moving
   branch a second time, if the timeline allows it -- this class of bug is exactly what pinning to
   a tagged release protects against.

## Mechanical notes (for whenever this is revisited)

Built via the `bundler` target to match the shape of the real published package (`ootle_wasm.js` +
`ootle_wasm_bg.js` + `ootle_wasm_bg.wasm`, confirmed by inspecting the installed `0.37.0` package's
own file list before building). No source changes on top of upstream -- this vendor copy existed
purely because the fix hadn't reached an npm release, not because of any local patch. Not run
through `wasm-opt` (not installed locally), so it's larger than the real npm package's optimized
build (~1.15MB vs. the real build's `wasm-opt -Oz`-stripped size) -- a size difference only, not a
correctness one.

Once `@tari-project/ootle-wasm` publishes a real release at or past whatever commit is needed
(#2426 merged; #2431 not yet, as of this writing), prefer bumping the real dependency version over
re-vendoring. If a real release still isn't available and this must be re-vendored, follow the
three steps above first.
