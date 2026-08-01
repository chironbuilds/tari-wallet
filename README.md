# Tari Ootle Wallet (Chrome extension)

A self-custody Chrome extension wallet for [Tari Ootle](https://github.com/tari-project/tari-ootle)
(L2 — not the Minotari L1 base layer). It generates and holds its own 24-word recovery phrase,
derives keys, and signs and submits transactions **directly to the network** — no
`tari_ootle_walletd` daemon required for its own accounts. Pages get a MetaMask-style injected
provider (`window.tari`), not the WalletConnect relay protocol — see "Design notes" below for why.

It can **also** connect to a running `tari_ootle_walletd` and relay to it — the same "self-custody
accounts + hardware-wallet-style external accounts, side by side" split MetaMask uses for Ledger.
See "Daemon-relayed accounts" below.

## Status: tested end-to-end in a live browser

Loaded as an unpacked extension in real Chrome and exercised against a live Ootle testnet indexer
(esmeralda), not just unit-tested in isolation. Confirmed working live:

- Wallet creation and import (24-word recovery phrase), password unlock/lock, multiple accounts
  per wallet with switching
- Claiming testnet XTR from the network's builtin faucet, including the self-funding
  first-transaction path for a brand-new account
- Balances rendered with each token's **real on-chain divisibility and symbol** (not guessed
  constants) — confirmed against tokens with different divisibility (XTR = 6, a custom
  DemoToken = 8)
- **Send** (to any `component_…` address, for any held token) and **Receive** (address display +
  copy-to-clipboard), both in the popup UI
- The `window.tari` injected-provider flow end-to-end against a real third-party page: connect
  request → approval popup → account access, and transaction build → approval popup → sign →
  submit → on-chain confirmation
- A full DEX built against this wallet (`../tari-dex/swap-ui`) exercising it for token creation,
  liquidity-pool creation, adding liquidity, and swaps — including the multi-instruction,
  multi-retry transactions those flows require

**Not yet exercised in the browser: daemon-relayed accounts.** The underlying relay logic is
verified end-to-end against a live `tari_ootle_walletd` (see "Daemon-relayed accounts" below), but
that was driven from Node directly, not by clicking through the popup's Connect-daemon UI in Chrome.

See "Design notes" below for the architectural decisions (own seed scheme, `window.tari` instead
of WalletConnect) and their trade-offs.

## Recent additions (typecheck/test/build verified; not yet exercised live)

- **Address book** (Settings → Address book): saved `component_…`/`otl_…` recipients, offered as a
  picker in both Send and Send-privately without replacing manual entry.
- **Network switching** (Settings → Network): esmeralda/igor, with an inline confirmation before
  switching (the storage field and read path already existed; this wires up the write path + UI).
  Clears the account cache on switch so a stale daemon-relayed account can't keep talking to the
  old network — see `background/index.ts`'s `popup-set-network` handler.
- **Transaction history** (home screen → History): client-recorded from here forward, covering
  Send, Shield, Unshield, Send-privately, testnet-XTR claims, claimed private payments, and
  dApp-submitted transactions (labeled structurally via `instructionSummary.ts`, never decoding
  instruction args — same policy as the approval screen). **Not** a retroactive reconstruction of
  on-chain history; see `TransactionHistoryEntry`'s doc comment in `storage.ts` for why.
- **Memo support** on Shield/Unshield/Send-privately: an optional encrypted note attached to a
  stealth output (`{ Message: text }` — see `toMemo()` in `wallet.ts` for why this isn't a plain
  string at the SDK boundary). For Send-privately it's attached to the recipient's output only, not
  the sender's own change output.
- Fixed a `getBalances()` gap where a resource whose *only* balance came from redeeming someone
  else's shared stealth commitment (no on-chain vault ever created) showed as absent entirely.
- `scripts/local-unshield-test.ts`: a live-verification script mirroring `local-shield-test.ts`,
  since unshield shares shield's fixes but was never explicitly re-verified live after them.
  **Run this yourself** (it needs your real mnemonic) before trusting unshield in production.

**`OotleAccount.getComponentAddress()` (`src/lib/wallet.ts`) derives the on-chain component
address client-side**, via `deriveAccountComponentAddress()` in `src/lib/componentAddress.ts`. This
reproduces `derive_component_address_from_public_key` (`crates/engine_types/src/component.rs`,
tari-project/tari-ootle) — a domain-separated Blake2b-256 hash of
(`ACCOUNT_TEMPLATE_ADDRESS`, `owner_public_key`) — byte-for-byte in TypeScript, since neither
`@tari-project/ootle` nor `@tari-project/ootle-wasm` expose this computation. Getting the
domain-separation/Borsh-framing bytes even slightly wrong would produce a wrong-but-plausible
address silently, so this was verified against all three of the golden test vectors committed
upstream in `crates/ootle_sdk_core/fixtures/address_derive/*.json` (generated by the real Rust
engine) — see the `component address matches golden vector` assertions in
`scripts/test-crypto.ts`. One byte-level detail worth flagging for a future reviewer: the public
key is Borsh **slice**-encoded (4-byte LE length prefix + 32 bytes), not raw-array-encoded like
`template_address` — `RistrettoPublicKeyBytes`'s manual `BorshSerialize` impl delegates to
`self.as_bytes(): &[u8]`, which Borsh treats as a dynamically-sized slice. Missing that prefix is
the one way this silently produces a wrong-but-plausible address instead of failing loudly.

## Design notes

**Seed & derivation use Tari's official CipherSeed format (implemented 2026-07-23).** The 24-word
recovery phrase is a real `CipherSeed` (`src/lib/cipherSeed.ts`, reproducing
`base_layer/common_types/src/seeds/cipher_seed.rs` byte-for-byte: version‖birthday‖16-byte
entropy‖MAC, ChaCha20-encrypted with a key derived via Argon2d — 46 MiB memory cost — and CRC32
checksummed) and account keys are derived with Ootle's own `derive_ristretto_key`
(`src/lib/derivation.ts`, reproducing `tari-ootle`'s `crates/wallet/crypto/src/derive.rs`: a
domain-separated Blake2b-512 hash under `KeyManagerDomain`, wide-reduced to a Ristretto scalar).
**Practical consequence:** a recovery phrase created here imports into the official wallet
daemon/Aurora/desktop wallet, and phrases from those import here — verified byte-exact against the
real `tari_common_types`/`tari_crypto`/`tari_hashing` crates (see `scripts/test-crypto.ts`'s golden
vectors, generated via a throwaway `cargo` harness against those crates at tari-ootle's exact pinned
versions, since no known-answer vectors exist upstream for this format).

**Scope limit: no separate seed passphrase.** Tari's CipherSeed supports an optional passphrase
distinct from whatever encrypts the wallet at rest (like BIP-39's optional 25th word). This
extension doesn't expose that as a feature — it always enciphers/deciphers with the documented
default (`None` → `"TARI_CIPHER_SEED"`), same as the official console wallet's own default when the
user hasn't set one. Importing a phrase that was created elsewhere *with* a custom seed passphrase
will fail to decrypt here with a clear error, not silently derive the wrong keys.

**`window.tari`, not WalletConnect v2.** Real WalletConnect requires registering a project with
Reown's relay network and implementing the wallet side of that pairing protocol (which,
per research at the time this was built, doesn't exist yet anywhere in the Tari ecosystem — only
the dApp-consumer side, `@tari-project/wallet-connect-signer`, does). This extension instead
injects a MetaMask-style provider object into every page — same spirit (a page requests accounts
and signatures from a wallet the user controls), much smaller surface area, no external relay
dependency, works with pages coded against it (e.g. `../tari-dex/swap-ui`) but isn't interoperable
with arbitrary WalletConnect-speaking dApps.

## Daemon-relayed accounts

**Core relay path verified against a live `tari_ootle_walletd` (esmeralda) from Node — connect,
authenticate, list accounts, read balances, and both dry-run and real transaction submission all
confirmed working end-to-end.** The popup UI itself (Connect daemon wallet screen, account picker,
Send/Receive/balances rendering for a daemon-backed active account) has not yet been clicked through
in Chrome — only the underlying `DaemonAccount` class has been exercised directly.

One real bug was caught and fixed during that verification: a locally-built unsigned transaction
defaults `is_seal_signer_authorized: false`, which the engine's `TransactionSignatureValidator`
rejects with "has no main signer" for a single-signer request (the shape every daemon-relayed
transaction here uses) — `DaemonAccount.execute()` now sets it explicitly. See the comment at its
call site in `daemonAccount.ts` for the full explanation; this is exactly the kind of silent,
plausible-looking failure mode the "Design notes" section above warns about elsewhere in this
codebase, and worth knowing about if you extend this class.

Local (seed-derived) and daemon-relayed accounts coexist in the same wallet, switchable from the
same account list — Settings → "+ Connect daemon wallet", or straight from the account switcher.
Connecting asks for the daemon's URL (`http://127.0.0.1:5100`-style) and an **API key**, then lists
that daemon's accounts so you pick which ones to add — the same "connect, then choose accounts to
import" shape as a hardware-wallet flow.

**Why an API key, not a login.** The first version of this connected via the daemon's normal
session flow (`auth.request` + silent `auth.refresh`) — this was wrong, and broke as soon as a
token actually expired. Per the tari-ootle maintainers (confirmed in review of the fix this section
used to describe, [PR #2375](https://github.com/tari-project/tari-ootle/pull/2375)):
`auth.refresh` reads an HttpOnly, `SameSite=Strict` session cookie set on browser login — a
`chrome-extension://` origin can never hold that cookie, by design, not a bug. WebAuthn (the
daemon's actual default auth method — this project's earlier testing only worked because the local
test daemon was deliberately misconfigured with `authentication=none`) locks its RP origin to
`http://localhost:{json_rpc_port}` regardless, which a Chrome extension page never runs on either
way. Neither session-auth path can work from here, full stop. The supported way for an external
client like this extension to authenticate is a long-lived **API key**, minted once from the
daemon's own web UI (which *does* have a real Admin browser session) and pasted into the connect
screen here — no refresh needed, ever, since it isn't a session token. Verified end-to-end against
a live daemon: minted a real API key, connected with it exclusively (no session at all), listed
accounts, read balances, and confirmed an invalid key gets rejected with a clear message rather
than a raw RPC error.

The connect screen has an **"Open API Keys page ↗"** button that opens the daemon's own web UI
("Tari Asset Vault") directly to `/api-keys` in a new tab — confirmed that route works as a direct
deep link, not just in-app client-side navigation, so this doesn't just dump the user on the
homepage to go find it themselves. Since opening a new tab steals focus and an extension popup
closes the instant it loses focus, the URL/label fields (not the API key itself) are drafted to
`chrome.storage.session` on every keystroke and restored the next time this screen renders, so
going to mint a key and coming back doesn't lose what was already typed.

**Expiry, revocation, and insufficient permissions are all handled explicitly**, not just left to
surface as raw RPC errors:

- `connectClient()` requires the key to carry the **`admin`** permission, checked *at connect time*
  — confirmed empirically that this wallet's own daemon-relayed "Claim testnet XTR" feature
  (`accounts.create_free_test_coins`) hard-rejects a narrower key with "Insufficient permissions.
  Required 'Admin'" verbatim, not a finer per-resource grant, so nothing less will do. There's no
  direct "what does this key grant" introspection available to API-key auth at all —
  `auth.list_api_keys` explicitly refuses it ("requires an interactive user session, not an API
  key") — so the check instead probes `settings.get`: a harmless read nothing else in this wallet
  ever calls, gated on `Settings(Read)` specifically, which only an admin-scoped key would satisfy
  in practice.
- Every daemon call distinguishes **expired/invalid/revoked** from **insufficient permission** —
  confirmed empirically that the daemon reports both as the *same* 401, distinguishable only by
  message text (`"Access denied. ..."` vs `"Insufficient permissions. Required '...'"`) — and
  rewrites each into an actionable message pointing at the right fix (mint a fresh key vs. mint one
  with broader permissions), instead of a raw `RPC Error 401: ...` either way.
- Verified all of this against a live daemon: an admin key connects cleanly, a narrowly-scoped key
  is rejected at connect time with the permission message, and both a garbage key and a freshly
  revoked (formerly valid) key are correctly classified as expired/invalid rather than a permission
  problem.

A daemon-relayed account (`src/lib/daemonAccount.ts`, `DaemonAccount`) never signs or derives
anything client-side — the daemon holds the real key material. Two consequences that make this a
genuinely different code path from `OotleAccount`, not just a swapped-in signer:

- **No client-side retry loop.** `OotleAccount.execute()`'s whole reason for existing is that
  neither this TS SDK nor the indexer this extension talks to directly does automatic
  dependency-graph discovery ("want-derivation") the way Rust's `ootle_sdk_core` does, so it has to
  retry reactively off rejection messages (see that method's own doc comment). The daemon's
  `transactions.submit` JRPC takes a `detect_inputs: true` flag that asks the daemon to do that
  discovery itself, server-side, in one round trip — so `DaemonAccount.execute()` just builds the
  unsigned transaction and submits it once.
- **Deliberately does not use `WalletDaemonSigner`** (the higher-level signer class the same npm
  package exports). Its own doc comment flags that its `signTransaction`'s handling of
  `seal_public_key` is unverified against a real daemon and can fail late and opaquely if the
  daemon doesn't honor it. `DaemonAccount` sidesteps that entirely by calling the daemon's own
  account/balance/submit JRPC methods directly (`accountsGetBalances`, `submitTransaction`,
  `createFreeTestCoins`, ...) rather than composing this extension's own `TransactionBuilder` with
  a borrowed `Signer` — the daemon does its own signing internally, out of band from this class.

**Known limitation:** stealth/confidential operations aren't wired up for daemon accounts (XTR's
native container type is `Stealth`, but everything this extension actually does with it — claim,
send, swap — moves it through revealed `withdraw`/`deposit`, which needs no stealth signing). The
daemon's own stealth JRPC (`stealthTransfer`, `stealthUtxosList`, ...) exists but isn't called here.

**Known limitation:** `host_permissions` in `manifest.json` currently only covers `localhost` and
`127.0.0.1` — a daemon on a remote host will hit CORS unless that origin is added.

## Integrating a dApp

Once loaded, the extension injects a MetaMask-style provider at `window.tari` into every page —
EIP-1193-shaped (`request({ method, params })`), not the WalletConnect relay protocol (see "Design
notes"). `../tari-dex/swap-ui/index.html` is a complete, real working example of everything below.

```js
// Detect the wallet. It may not exist yet at page-load time, so also listen for its ready event.
if (!window.tari?.isTariWallet) {
  window.addEventListener("tari#initialized", () => console.log("Tari wallet ready"), { once: true });
}

// Connect — prompts the user with an approval popup the first time; a no-op afterwards.
const [accountAddress] = await window.tari.request({ method: "tari_requestAccounts" });

// Read-only calls — no approval popup.
await window.tari.request({ method: "tari_getAccounts" });   // -> string[] (already-connected accounts)
await window.tari.request({ method: "tari_getNetwork" });    // -> "esmeralda" | "igor"
await window.tari.request({ method: "tari_getBalances" });   // -> { resourceAddress, kind, amount, divisibility, symbol }[]
await window.tari.request({
  method: "tari_getSubstate",
  params: { substateId: "resource_...", version: null },     // -> raw Substate (e.g. to read a resource's divisibility/metadata)
});

// Build and submit a transaction — prompts an approval popup unless dryRun is true.
const result = await window.tari.request({
  method: "tari_signAndSubmitTransaction",
  params: {
    instructions: [ /* raw Instruction[] from @tari-project/ootle-ts-bindings */ ],
    maxFee: "5000",       // optional, string (µT)
    dryRun: false,        // true = simulate only, no approval popup, nothing spent
    inputs: [],            // optional: substates you already know are needed; the wallet
                            // auto-resolves anything else missing via its own retry loop
  },
});

await window.tari.request({ method: "tari_disconnect" });

// Fires (mirroring EIP-1193's accountsChanged) whenever the wallet drops this page's connection
// out from under it — e.g. the user switched the active account in the extension. `detail` is
// always `[]`; treat it purely as a signal to re-run `tari_requestAccounts` before the next call.
window.addEventListener("tari#accountsChanged", (e) => {
  console.log("accounts changed:", e.detail); // []
});
```

Notes for dApp authors, learned building `tari-dex/swap-ui` against this wallet:

- **CBOR-encode instruction args yourself.** `instructions` are the raw `Instruction[]` shape from
  `@tari-project/ootle-ts-bindings` — numeric/address/string args need `InstructionArg::Literal`
  CBOR encoding (see `amountLiteral`/`resourceAddressLiteral`/`componentAddressLiteral`/
  `stringLiteral` exported by `@tari-project/ootle` if you can depend on it directly).
- **You don't need to know every substate your instructions touch.** The wallet's own auto-retry
  (`OotleAccount.execute()`) discovers and pins whatever's still missing by parsing the engine's
  rejection messages and resubmitting — `inputs` is purely an optimization, never required for
  correctness.
- **Dry-run calls skip the approval popup**, real submissions don't — so it's safe to dry-run on
  every keystroke (e.g. for a live price quote) without spamming the user with popups.
- Resource decimal precision (`divisibility`) and display names (`symbol`) are real on-chain data
  (`Resource.divisibility` / `Resource.metadata.SYMBOL`) fetched via `tari_getSubstate` or returned
  directly by `tari_getBalances` — don't hardcode a decimals constant per token.
- Switching the active account inside the extension disconnects every connected site (each
  connection is pinned to whichever account was active when it was made) and fires
  `tari#accountsChanged` on every open tab — listen for it rather than caching the account address
  from `tari_requestAccounts` indefinitely.

## Architecture

```
src/
  lib/
    domainHash.ts    DomainSeparatedHasher<Blake2b> byte-exact port (tari_crypto's hashing.rs)
    crc32.ts         standalone CRC-32 (IEEE 802.3), CipherSeed's checksum
    mnemonic.ts      33 bytes <-> 24 words, Tari's radix-2048 codec (not BIP-39)
    cipherSeed.ts    Tari's official CipherSeed format: encipher/decipher, mnemonic <-> seed
    derivation.ts    entropy + account index -> (owner, view) Ristretto scalars (Ootle's own scheme, byte-exact)
    componentAddress.ts  owner public key -> on-chain component_<hex> address (Tari's own scheme, byte-exact)
    vault.ts         password -> AES-256-GCM encrypt/decrypt of the seed (WebCrypto, PBKDF2 600k)
    wallet.ts         OotleAccount: wraps SecretKeyWallet (signing) + IndexerProvider (network)
    daemonAccount.ts  DaemonAccount: relays to a connected tari_ootle_walletd instead of signing locally
    accountApi.ts      WalletAccountApi: the shared surface OotleAccount and DaemonAccount both implement
    storage.ts        chrome.storage.local wrapper (encrypted vault + local/daemon accounts + connected sites)
    messages.ts        shared message shapes across all contexts
  background/
    index.ts           service worker: message router, page-request + popup-request handling
    session.ts          unlocked seed cache, in chrome.storage.session (survives SW restarts)
    accounts.ts          resolves an account id (local or daemon) to a WalletAccountApi, cached
    approvals.ts          pending connect/sign requests + approval popup windows
  content/
    inject.ts             MAIN-world script; defines window.tari
    content-script.ts       ISOLATED-world relay: page <-postMessage-> here <-runtime.sendMessage-> background
  popup/
    main.ts                vanilla-TS UI: onboarding, unlock, home, send, receive, settings,
                            connect-daemon-wallet, approvals (routed via location.hash)
```

Manifest V3 service workers are ephemeral — Chrome can kill and restart the background script at
any time. The unlocked seed lives in `chrome.storage.session` (in-memory only, cleared when the
browser fully closes) specifically so a SW restart mid-session doesn't silently re-lock the wallet;
a plain module variable would not have survived that.

## Building

Uses [pnpm](https://pnpm.io) (see "Supply chain" below for why), not npm/yarn:

```
pnpm install
pnpm run build      # -> dist/
```

Wasm handling needs `vite-plugin-wasm` + `vite-plugin-top-level-await` — `@tari-project/ootle-wasm`
ships as `import * as wasm from "./x.wasm"` (the still-not-natively-supported-in-Chrome "ESM
integration for WebAssembly" pattern; verified empirically against a real browser during
development, not assumed), which only a bundler with a dedicated transform can handle. Plain esbuild
cannot; that's why this project uses Vite specifically.

## Supply chain

Package installs go through **pnpm**, not npm, specifically for one property npm can't give you:
pnpm blocks every dependency's install-time (`preinstall`/`install`/`postinstall`) scripts by
default — the single most common real-world npm supply-chain attack vector, since a compromised
package's postinstall script runs with full filesystem/network access at install time, no
different from executing arbitrary code. `pnpm-workspace.yaml`'s `allowBuilds` is the explicit,
committed allowlist of the only two dependencies that legitimately need one (`@swc/core` and
`esbuild`, both downloading their own platform-specific native binary — confirmed by inspecting
every installed package's own `package.json` for a lifecycle script before allowing it, not
assumed). Anything else pulled in later that tries to run an install script stays blocked until
someone deliberately adds it here — that's a deliberate speed bump, not an oversight.

Also: `pnpm-lock.yaml` is the only lockfile (no `package-lock.json` — having both invites
installing with whichever tool someone has handy, silently drifting from what CI actually
verified), CI runs `pnpm install --frozen-lockfile` (fails outright on any lockfile drift, never
silently re-resolves) followed by `pnpm audit`, and a known vulnerability in a transitive,
build-time-only dependency (`uuid`, pulled in by `vite-plugin-top-level-await`) is pinned to a
patched version via `pnpm-workspace.yaml`'s `overrides` rather than by changing the wasm build
plugin itself, which this project is deliberately pinned to (see above).

## Loading it in Chrome

1. `pnpm run build`
2. Open `chrome://extensions`, enable **Developer mode** (top right)
3. **Load unpacked** → select the `dist/` folder
4. Click the extension icon to open the popup and create or import a wallet

## Testing

```
pnpm test              # unit tests (vitest) — pure logic: parsing, validation, error classification
pnpm run test:watch    # same, in watch mode
pnpm run test:crypto   # scripts/test-crypto.ts — see below
```

`pnpm test` covers the pieces that are easy to get subtly wrong and hard to notice when they are:
`parseDecimalToRaw`/`normalizeDaemonUrl`/`isValidComponentAddress` (`src/popup/format.ts`),
`extractMissingSubstateAddress`/`extractStaleLockVersion` (the regexes `OotleAccount.execute()`'s
retry loop depends on), `isDaemonUnreachable`/`toIndexerResultShape` (`DaemonAccount`'s error
classification and result-shape normalization), and the account-id encode/decode round-trip
(`storage.ts`). Runs against plain Node (`vitest.config.ts` deliberately skips the CRX/wasm/
top-level-await plugins `vite.config.ts` needs for packaging — the tests don't need them).

Pure display/validation logic that a popup screen needs is kept in a plain module (e.g.
`src/popup/format.ts`) separate from the screen's own render function, specifically so it stays
importable in a test file without pulling in `main.ts`'s side effects (it calls `main()` — which
touches `document` — at module load).

`pnpm run test:crypto` verifies CipherSeed enciphering/deciphering and mnemonic encoding against
golden vectors generated from the real `tari_common_types`/`tari_crypto`/`tari_hashing` crates,
account-key derivation against golden vectors from the same run (derivation determinism: same
entropy+index always derives the same keys; different index/seed always derives different keys;
derived scalars are correctly reduced mod the Ristretto group order), and component-address
derivation against three golden vectors generated by the real upstream Rust engine. This doesn't
touch the `@tari-project/ootle-wasm` module (Node needs `--experimental-wasm-modules`-style native
support for that, which is a separate concern from whether Chrome's bundler-target import works —
see Design notes) — it does exercise `hash-wasm`'s Argon2d WASM, which loads fine under plain Node.
