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

**Funding works today.** It only needed `createStealthOutputWitness`'s existing `payTo` parameter —
a capability that was already present in the published SDK, just undocumented.

**Claiming and refunding — spending an HTLC-locked output — don't exist in this wallet yet.**
Spending a script-conditioned output needs two things neither the published SDK nor (until
recently) the wasm crypto module it wraps could do:

1. Building the actual **script-path witness** — revealing one leaf of the condition tree plus its
   Merkle inclusion proof and any required witness data (the preimage, for a claim). Exposed
   upstream in [tari-project/tari-ootle#2426](https://github.com/tari-project/tari-ootle/pull/2426).
2. Generating a **covenant balance claim** — a proof that value in equals value out across the
   partition of inputs/outputs sharing a spent script-locked input's condition root. Required
   whenever a script-path input is spent; omitting it isn't a cosmetic gap, it's a real
   balance-integrity hole. Exposed upstream in
   [tari-project/tari-ootle#2431](https://github.com/tari-project/tari-ootle/pull/2431).

Both were deliberately *not* hand-rolled in TypeScript without a tested primitive backing them —
covenant-claim generation in particular is exactly the kind of thing that fails silently and
expensively if it's subtly wrong, not the kind of gap worth guessing at. The vendored SDK's own
`StealthTransfer`/`WalletStealthAuthorizer` input pipeline is also currently hard-wired to
key-path-only spends (it always derives a one-time DH signature per input), so claim/refund will
need a real patch there too, once the wasm side is safely available.

**A note on how that wasm dependency is currently pinned**: an earlier attempt to vendor a
newer `@tari-project/ootle-wasm` build (to pick up #2426's exports ahead of a real release) broke
ordinary, non-stealth transaction signing wallet-wide, because it was built from a moving branch
HEAD carrying a lot of unrelated changes. It was reverted. See `vendor/ootle-wasm-patched/README.md`
for the full story if you're the one picking this work back up — it has specific guidance on how to
do it safely next time.

### `tari_getCapabilities` reflects this honestly

`scriptPathSpend` in the capabilities response is `false` today, and will stay `false` until
claim/refund actually exist and are tested — not flipped to `true` the moment the upstream pieces
land. `htlcFund` is `true` for a local (`OotleAccount`) connection, `false` for a daemon-relayed
one, matching the same key-material split described in
[Accounts and Signing](accounts-and-signing.md).
