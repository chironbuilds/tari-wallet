# Security Audit — Tari Ootle Wallet Extension (deepseek-v4-pro)

**Auditor:** Buffy (Codebuff agent, `deepseek/deepseek-v4-pro`)
**Date:** 2026-08-15
**Scope:** Full self-review of the extension's source (`src/`), `manifest.json`, and the
message-passing / crypto / storage layers. This is a code-level self-assessment, **not** an
independent third-party engagement and not a substitute for a paid external audit before handling
real funds.

**Method:** Every finding was checked directly against the current source with file/line
references. The existing `SECURITY_AUDIT.md` (dated 2026-07-25, commit `b690763`) was re-verified
against the newer code paths (transaction-request create/approve/submit flow, HTLC funding,
daemon-relayed accounts, auto-lock) rather than assumed still-correct.

---

## Executive Summary

**No critical or high-severity findings.** The core security boundaries from the prior audit still
hold:

- **Page → wallet boundary:** `src/content/content-script.ts` hardcodes `kind: "tari-page-request"`
  and reads `origin` from its own `window.location.origin` — a web page cannot forge `popup-*`
  messages or impersonate another origin's connection. `background/index.ts`'s `handlePageRequest`
  is a fixed switch that never returns the seed or derived keys.
- **Approval is human-only and unspoofable:** approval windows are real `chrome.windows.create`
  popups; the dApp knows its own `requestId` (which doubles as the approval id) but has no path to
  the `popup-resolve-approval` handler, so it cannot self-approve. Closing the window resolves as
  rejection (fail-safe deny).
- **At-rest crypto is sound:** AES-256-GCM + PBKDF2-HMAC-SHA256 at 600,000 iterations
  (`src/lib/vault.ts`); daemon API keys are AES-GCM encrypted under a domain-separated key derived
  from seed entropy (`src/lib/secretAtRest.ts`); the decrypted seed lives only in
  `chrome.storage.session` (default `TRUSTED_CONTEXTS_ONLY`, never widened).
- **XSS surface is clean:** the popup's `h()` helper uses `createElement`/`textContent`/
  `setAttribute`; the only `innerHTML` uses are fixed icon markup, the numeric-only avatar SVG, and
  the QR SVG. dApp-controlled strings (origin, instruction titles/details, notes) render as text
  nodes. No `eval` / `new Function` / `document.write`.
- **CSP/manifest tight:** `script-src 'self' 'wasm-unsafe-eval'`, no `web_accessible_resources`, no
  `externally_connectable`, narrow `host_permissions`.

---

## Findings

### 1. (Low — FIXED) Account switch did not revoke pending/approved transaction requests, and submit did not re-verify the account binding

**Location:** `src/background/index.ts` (`tari_submitTransactionRequest`, `popup-set-active-account`)

**What was wrong:** `popup-set-active-account` drops every connection (`removeAllConnectedSites`)
when the user switches accounts, but leaves `transactionRequests` untouched. The submit handler
checked `record.origin === origin` but **not** `record.accountId === site.accountId`. So this
sequence was possible:

1. dApp is connected to account **A** and creates a transaction request; the user approves it.
2. The user switches the active account to **B** in the extension (disconnects every site).
3. The dApp reconnects (now bound to **B**).
4. The dApp calls `tari_submitTransactionRequest` with the old request id, and the record spends
   from **A** via `record.accountId`.

The executed operation is exactly what the user approved, so this was an authorization-scoping /
expectation gap rather than arbitrary spend — but it undermined the "switching accounts cuts the
site off" model.

**Fix applied:** `tari_submitTransactionRequest` now rejects any request whose
`record.accountId !== site.accountId` with a clear error. The deprecated single-call RPCs
(`tari_signAndSubmitTransaction` etc.) were already consistent (they bind `record.accountId` from
`site.accountId` in the same handler) and needed no change.

**Verification:** `pnpm run typecheck` clean; `pnpm test` (20 files / 229 tests) passing.

---

### 2. (Low) `htlcFund` does not validate `hashLockHex`, and `refundEpoch` is only loosely bounded

**Location:** `src/lib/htlc.ts` (`htlcConditions`), `src/lib/wallet.ts` (`OotleAccount.htlcFund`),
`src/background/index.ts` (`tari_htlcFund`)

**What's wrong:** `htlcConditions` drops the raw `hashLockHex` string into
`HashLock: { hash: ..., alg: "Sha256" }` with no check that it is exactly 32 bytes of hex — unlike
the claimant address, which is validated via `parseOotleAddress`. `refundEpoch` is only checked for
JS-safe-integer representability, not for being a sane epoch.

**Impact:** A malformed hash produces an output whose claim path can never be satisfied; a
degenerate `refundEpoch` makes the claim path immediately unsatisfiable. There is no fund loss for
the funder (the refund leaf always recovers funds at/after `refundEpoch`), but a claimant trusting
the dApp's conditions could be unable to claim.

**Recommendation:** Validate `hashLockHex` as exactly 64 hex characters and reject degenerate
epochs before building the condition tree.

---

### 3. (Info) `recordKnownVersions` writes outside the `serialized()` queue

**Location:** `src/lib/wallet.ts` (`recordKnownVersions` / `loadKnownVersions` /
`KNOWN_VERSIONS_STORAGE_KEY`)

**What's wrong:** `recordKnownVersions` performs its own read-modify-write on the
`knownSubstateVersions` key in `chrome.storage.local`, bypassing the `serialized()` write queue that
every mutating helper in `src/lib/storage.ts` uses. Two concurrent transaction confirmations can
read the same map and lose one's version update, and the write can race
`wipeWallet`'s `chrome.storage.local.clear()` — potentially leaving prior-wallet version numbers
behind for a freshly created wallet.

**Impact:** Self-healing in practice (the `execute()` retry loop tolerates stale versions), and
cross-field clobbering is avoided because `chrome.storage.local.set` merges top-level keys. This is
the same lost-update class the prior audit fixed elsewhere; it just hasn't been fixed here.

**Recommendation:** Route `recordKnownVersions`' read-modify-write through the serialization queue
(or a per-key mutex).

---

### 4. (Info) Temporary diagnostic logging in the popup-request error path

**Location:** `src/background/index.ts` (`handlePopupRequest`'s catch →
`console.error("[popup-request:...]", err)`)

**What's wrong:** Error text is logged to the extension console on every failed popup request. This
can include the daemon URL (user-entered), but never the daemon API key, seed, or derived keys —
those are never part of an error message.

**Recommendation:** Remove before any production hardening pass (the comment already flags it as
`TEMP diagnostic`).

---

### 5. (Info) Dry-run signs the transaction without approval

**Location:** `src/lib/wallet.ts` (`OotleAccount.submitDryRun`), `src/background/index.ts`
(`tari_signAndSubmitTransaction` with `dryRun: true`)

**What's wrong:** A connected dApp's `dryRun: true` call signs the transaction with the owner key
(`signTransaction([this.signer], ...)`) and posts the signed envelope to the indexer's
`/transactions/dry-run` endpoint with no approval popup and no fund movement. This is documented
(`WalletCapabilities.dryRunIsLocal === false`) and matches the `eth_call` norm, but it means a
connected dApp can induce arbitrary signatures bound for the official indexer.

**Recommendation:** Acceptable today given the official indexer is the only recipient and dry-run
envelopes are not broadcastable; re-evaluate if the indexer is ever considered less than fully
trusted.

---

## Not Re-Verified (carried from `SECURITY_AUDIT.md` §9)

The crypto ports (`src/lib/cipherSeed.ts`, `derivation.ts`, `mnemonic.ts`, `domainHash.ts`,
`componentAddress.ts`) still lack an **end-to-end golden vector produced by the real Rust wallet**
(seed phrase in → derived keys out). Self-consistency tests and `tari-crypto`'s generic-domain
vectors pass, but that does not rule out a byte-level mismatch against `tari_ootle_walletd` that
would silently derive different keys from the same recovery phrase. Run one real phrase through both
implementations and diff the derived keys before trusting this on mainnet.

---

## Ruled Out (investigated, not exploitable)

- **"A dApp can approve its own transaction request."** The dApp does learn its own `requestId`
  (identical to the approval id), but it has no path to the `popup-resolve-approval` handler — the
  content-script relay hardcodes `kind: "tari-page-request"` and never passes a `kind` through from
  the page. Only the human, via the popup, can approve.
- **"`touchActivity` keeps the wallet unlocked while locked."** `touchActivity` only writes
  `lastActivityMs`; `checkAutoLock` returns early when locked, and `setUnlockedSeed` resets the
  timestamp on unlock. New read-only RPCs (`tari_getTransactionRequest`) correctly do **not** touch
  activity.
- **"innerHTML XSS via dApp data."** All `innerHTML` call sites consume fixed/numeric markup; all
  dApp- and indexer-derived strings render through `textContent`.
- **"Another installed extension can trigger `popup-*` messages."** `chrome.runtime.onMessage` only
  fires for the same extension's contexts; `onMessageExternal` is never registered.

---

*This document reflects the state of the codebase as of 2026-08-15. Re-verify against current
source before relying on any specific claim after further changes land.*
