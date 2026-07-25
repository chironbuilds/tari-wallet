# Security Audit — Tari Ootle Wallet Extension

**Date:** 2026-07-25
**Commit audited:** `b690763` (master)
**Scope:** Self-review of the extension's own source (`src/`), its Chrome Manifest V3
configuration (`manifest.json`), and its build/supply-chain setup. This is an internal
code-level audit performed by the assistant working on this codebase, not an independent
third-party engagement — treat it as a structured self-assessment, not a substitute for a
paid external audit before handling real funds at scale.

**Method:** Every claim below was checked directly against the current source (file/line
references given) or against official Chrome extension documentation, not assumed from
general knowledge of how MV3 extensions "usually" work. Two suspected issues surfaced
during this process and were disproven on inspection; they're recorded in
[Investigated and Ruled Out](#investigated-and-ruled-out) rather than silently dropped.

## Executive Summary

No critical or high-severity findings. The extension follows the standard self-custody
wallet architecture (same shape as MetaMask/Phantom): key material never leaves the
background service worker, the page-facing provider API is a narrow, capability-scoped
surface with no path to key material, and every state-changing action requires an
explicit, unspoofable user approval. The two most consequential controls checked out:

- A malicious website cannot reach the seed or private keys through the extension's
  own message-passing surface (see [§1](#1-page--dapp-threat-model)).
- The at-rest vault uses AES-256-GCM with PBKDF2-HMAC-SHA256 at 600,000 iterations
  (OWASP's 2023 minimum), and the decrypted seed is held only in `chrome.storage.session`
  at its default, non-content-script-accessible trust level.

Residual risk is concentrated where it always is for a self-custody wallet: user-facing
phishing/social engineering, upstream supply-chain compromise, and the strength of the
user's own password. See [§7](#7-residual-risk-not-fixable-by-this-codebase).

---

## 1. Page / dApp Threat Model

**Question:** can a website the user visits use this extension to read the seed, a
private key, or otherwise act without the user's consent?

**Finding: No.** Traced the full path a page has into the extension:

1. `manifest.json` declares no `externally_connectable`. Without it, a web page has no
   `chrome.runtime` object at all for this extension — it cannot call
   `chrome.runtime.sendMessage` directly under any circumstances. Its only route in is
   the content script relay.
2. `src/content/inject.ts` runs in the page's own MAIN world and only ever
   `window.postMessage`s a `{ target, type, id, method, params }` envelope to
   `src/content/content-script.ts` (isolated world, same tab).
3. `content-script.ts:45-51` builds the actual message sent to the background:
   `kind` is **hardcoded** to `"tari-page-request"` and `origin` is read from the content
   script's own `window.location.origin` — neither field is taken from the page's
   `postMessage` payload, so a page cannot forge the separate `"popup-*"` message kind
   the extension's own UI uses for privileged operations (mnemonic reveal, wallet reset,
   daemon key management, etc.).
4. `src/background/index.ts:73-158` (`handlePageRequest`) is a fixed switch over
   `tari_getNetwork`, `tari_getAccounts`, `tari_requestAccounts`, `tari_disconnect`,
   `tari_getBalances`, `tari_getSubstate`, `tari_signAndSubmitTransaction`. None of these
   return the seed or a derived private key. Confirmed `OotleAccount.execute()`
   (`src/lib/wallet.ts:194`) returns only the transaction submission result — the
   `ownerSecret`/`viewSecret` derived at `wallet.ts:66` never leave the object that holds
   them, let alone cross back out through the page relay.
5. Connecting (`tari_requestAccounts`) and submitting a real transaction (not a dry-run
   quote) both call `requestApproval()` (`src/background/approvals.ts`), which opens a
   **separate native browser window** via `chrome.windows.create` loading the extension's
   own bundled `popup.html` — not an in-page element the site can style, overlay, or
   script. Closing that window without a click resolves as a rejection
   (`approvals.ts:65-72`), i.e. the fail-safe default is "deny," not "allow."
6. Site permissions are strictly per-origin: `getConnectedSite(origin)`
   (`src/lib/storage.ts:102-104`) does an exact string match, so one approved dApp origin
   never grants another origin anything. Users can review and revoke every connected
   site from Settings → Connected sites (`src/popup/main.ts:1022`, `removeConnectedSite`).

**Supporting control found while checking this:** `chrome.storage.session` — where the
decrypted seed lives while unlocked (`src/background/session.ts`) — defaults to
`TRUSTED_CONTEXTS_ONLY` access level. Nothing in this codebase calls
`chrome.storage.session.setAccessLevel`, so that default holds: content scripts (which
run inside every page you visit) cannot read it even if one were compromised. This was
worth checking explicitly, since it's an easy thing to accidentally widen.

## 2. Extension-to-Extension Messaging

**Question:** could a different installed extension trigger privileged operations
(`"popup-*"` messages) in this one?

**Finding: No**, verified against Chrome's own documentation
(`developer.chrome.com/docs/extensions/develop/concepts/messaging` and the `onMessage`
API reference) rather than assumed: `chrome.runtime.onMessage` — what
`src/background/index.ts:49` listens on — only ever fires for messages from the *same*
extension's own contexts. Cross-extension messages require the extension to separately
register `chrome.runtime.onMessageExternal`, which this codebase never does. This was the
first of two suspected issues that didn't survive verification (see
[§8](#8-investigated-and-ruled-out)).

## 3. At-Rest Encryption

- **Wallet vault** (`src/lib/vault.ts`): AES-256-GCM, key derived via
  PBKDF2-HMAC-SHA256 at 600,000 iterations (`PBKDF2_ITERATIONS = 600_000`, `vault.ts:8`),
  matching OWASP's 2023 minimum recommendation for PBKDF2-SHA256. Random salt and IV per
  encryption (via `crypto.subtle`, not a hand-rolled primitive).
- **Daemon API keys** (`src/lib/secretAtRest.ts`): these are a second class of secret
  (credentials for an optional external wallet-daemon connection) that were previously
  stored in plaintext in `chrome.storage.local` — the same tier as the account list, not
  the vault. Fixed this round: they're now AES-GCM encrypted with a key derived by
  domain-separated SHA-256 over the *already-unlocked seed's entropy*, not a second
  password prompt (the seed already carries enough entropy; a second KDF pass over it
  would add cost with no real security benefit). Both `popup-connect-daemon` and
  `popup-list-daemon-accounts` now require `getUnlockedSeed()` to succeed first
  (`src/background/index.ts`), and `resolveAccountId()`
  (`src/background/accounts.ts`) checks the unlocked-seed gate before touching *either*
  local or daemon account types — previously only local accounts were gated this way,
  which was the actual gap this closed.
- **Seed while unlocked**: `chrome.storage.session` only (see §1) — never written to
  `chrome.storage.local`, never persisted to disk in decrypted form.

## 4. Auto-Lock

Manifest V3 service workers are ephemeral (Chrome can kill and restart them at any idle
point), which rules out a plain `setTimeout` for auto-lock — it would silently never fire
across a worker restart. Implemented instead with `chrome.alarms`
(`manifest.json` permission `"alarms"`; `src/background/index.ts`,
`chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 })`), which is designed to
survive exactly this. Activity is timestamped on every real request handled while
unlocked (`touchActivity()` called at the top of both `handlePageRequest` and
`handlePopupRequest`), and a 1-minute alarm tick compares elapsed idle time against the
user's configured threshold (`src/lib/autoLock.ts`, options: 1/5/15/30/60 minutes or
never, default 15). Covered by 8 unit tests (`autoLock.test.ts`) including the
disabled-state and boundary cases.

## 5. Transaction Approval UX ("Blind Signing" Risk)

Before this round of work, the approval screen for a pending transaction rendered
`JSON.stringify(approval.instructions, null, 2)` — raw protocol structures, unreadable to
a non-technical user, which pushes toward reflexively clicking Approve without
understanding what's being signed ("blind signing," the single biggest real-world cause
of wallet-approval losses industry-wide).

Replaced with `src/lib/instructionSummary.ts`: a structural, per-instruction-kind summary
(`summarizeInstruction`, all 16 `Instruction` variants handled) shown as numbered cards,
with the raw JSON still available (collapsed, not deleted) for anyone who wants it. This
was deliberately built to use **only structural fields** (kind, method name, target
address) and to never decode `InstructionArg.Literal` CBOR bytes — decoding those
correctly requires knowing the callee's expected argument types, which the wallet doesn't
have; a wrong-but-plausible decode of a Literal would be worse than not showing it,
because it would look authoritative while being unverified. Args are described generically
by kind instead ("a value from earlier in this transaction," "attached data blob #N," "an
encoded value").

## 6. Manifest & CSP Review

- `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval';
  object-src 'self'`. No `unsafe-inline`, no remote script origins — the popup and any
  other extension page can only execute code shipped in the extension bundle.
  `wasm-unsafe-eval` is required for the Tari WASM SDK and is scoped to WASM execution,
  not arbitrary eval.
- `host_permissions`: `https://*.tari.com/*`, `http://localhost/*`, `http://127.0.0.1/*`
  — narrow, no `<all_urls>` host permission. (Separately, `content_scripts.matches` is
  broad — `http://*/*`, `https://*/*` — but that's the intended, MetaMask-equivalent
  scope for *offering the provider*, not for background network access, and everything
  it can do is bounded by §1 above.)
- `permissions`: `["storage", "alarms"]` only. No `tabs`, `webRequest`, `cookies`, or
  similar broad-surface permissions.

## 7. Residual Risk (Not Fixable by This Codebase)

These are named explicitly rather than left implicit, since a report that only lists
what's fixed can read as "everything is fine" when it isn't the full picture:

- **Phishing / social engineering.** A fake "restore your wallet" page that asks the
  user to type their 24-word seed phrase directly would work regardless of any code
  fix here — the only structural mitigation is that *this* extension only ever asks for
  the seed on its own onboarding screen, so "anywhere else asking for your seed is not
  this wallet" is the one durable fact worth the user knowing.
- **Supply-chain compromise.** A malicious transitive npm/pnpm dependency landing in a
  future `pnpm add` is a standing risk for any JS project; it's mitigated (allowlisted
  install scripts via `pnpm-workspace.yaml`'s `allowBuilds`, `pnpm audit` in CI, exact
  lockfile pinning) but never eliminable by configuration alone.
- **Password strength.** The vault's PBKDF2 cost protects against brute-force *speed*,
  not against a user choosing a guessable password. Current enforcement is a straight
  8–256 character length check (`src/popup/main.ts:226`) with no strength meter or
  dictionary check. Worth considering as a future improvement, not addressed this round.
- **Host OS / browser compromise.** Malware with local disk or process-memory access is
  outside any browser extension's threat model to defend against.

## 8. Investigated and Ruled Out

Recorded here so they aren't mistaken for open findings, and so this list itself
demonstrates the verification standard applied throughout: a plausible-sounding theory
was treated as a hypothesis to check, not a conclusion to report.

- **"Any other installed extension can drain the wallet via `chrome.runtime.sendMessage`."**
  Plausible on first read of the code (a listener on `onMessage` with no visible sender
  check) — disproven by checking Chrome's own documentation on `onMessage` vs.
  `onMessageExternal` (§2). Not exploitable.
- **A blank/pattern-less account avatar** was found during this round's UI work, not a
  security issue but a correctness one worth noting for the record: the original
  identicon hash had a strong bit-parity correlation specific to hex-alphabet strings
  (i.e. every real Tari address), causing ~44% of real addresses to render with no
  visible pattern at all — silently defeating the "spot a wrong address at a glance"
  purpose the feature exists for. Replaced with an FNV-1a → splitmix32 construction,
  verified bias-free (0/5000 blank grids sampled) and covered by a regression test
  (`src/lib/avatar.test.ts`).

---

*This document reflects the state of the codebase at the commit noted above. Re-verify
against current source before relying on any specific claim after further changes land.*
