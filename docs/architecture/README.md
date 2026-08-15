# Architecture Overview

Sapient is a Manifest V3 Chrome extension. Like every extension of this shape, it runs as several
separate JavaScript execution contexts that can't call each other directly — they only talk over
message-passing. Understanding this split is the foundation for everything else in this section.

```
src/
  content/
    inject.ts           MAIN-world script; defines window.tari on every page
    content-script.ts   ISOLATED-world relay: page <-postMessage-> here <-runtime.sendMessage-> background
  background/
    index.ts             service worker: message router, page-request + popup-request handling
    session.ts            unlocked seed cache, in chrome.storage.session (survives SW restarts)
    accounts.ts            resolves an account id (local or daemon) to a WalletAccountApi, cached
    approvals.ts            pending connect/sign requests + approval popup windows
  popup/
    main.ts                 vanilla-TS UI: onboarding, unlock, home, send, receive, settings,
                             connect-daemon-wallet, approvals (routed via location.hash)
  lib/
    wallet.ts                 OotleAccount: signs and submits directly, no daemon
    daemonAccount.ts           DaemonAccount: relays to a connected tari_ootle_walletd
    accountApi.ts               WalletAccountApi: the shared surface both implement
    storage.ts                  chrome.storage.local wrapper (vault, accounts, requests, history)
    messages.ts                  shared message shapes across every context
    htlc.ts                      HTLC condition-tree construction (see "Stealth Balances and HTLCs")
    cipherSeed.ts / derivation.ts / componentAddress.ts   byte-exact ports of Tari's own crypto
```

## The four contexts

**Page (`window.tari`).** `inject.ts` runs in the page's own `MAIN` world — the same JS realm the
page's own scripts execute in — and defines a single global object, `window.tari`, with one method:
`request({ method, params })`. It never touches key material; every call is a `postMessage` out to
the content script.

**Content script (isolated world).** `content-script.ts` runs in the *same tab*, but in Chrome's
separate "isolated world" — it shares the page's DOM but not its JS globals, so a malicious page
script can't reach in and call extension APIs directly. It does one job: relay. A message from the
page (`window.postMessage`) becomes a `chrome.runtime.sendMessage` to the background; the response
comes back the same way in reverse. It also retries the very first message with backoff if the
service worker is mid-cold-start (`"Receiving end does not exist"` is the tell — Chrome tears MV3
workers down after ~30s idle, so a page's first request in a while can race one waking back up).

**Background service worker.** `background/index.ts` is where everything actually happens: it
routes a `tari-page-request` (from any connected site) or a `popup-*` request (from the extension's
own UI) to the right handler, resolves which account should service it, and — for anything that
signs or spends — pops an approval window and waits on the human. This is the only context that
ever touches a decrypted seed or signs a transaction.

**Popup.** `popup/main.ts` is a plain, dependency-free TypeScript UI (no framework) — onboarding,
unlock, balances, send/receive, settings, and the approval screens themselves. It talks to the
background exclusively via `popup-*` messages defined in `messages.ts`, the same message-passing
discipline as the page side.

## Message flow, end to end

A dApp calling `tari_signAndSubmitTransaction`:

```
page                    content-script              background                  popup
 │  window.tari.request │                            │                            │
 │──────postMessage────▶│                            │                            │
 │                       │──chrome.runtime.sendMessage▶│                            │
 │                       │                            │  resolve connected site    │
 │                       │                            │  resolve account           │
 │                       │                            │──open approval window────▶ │
 │                       │                            │                            │  render + wait for click
 │                       │                            │◀───popup-resolve-approval──│
 │                       │                            │  build, sign, submit        │
 │                       │◀────────sendResponse────────│                            │
 │◀─────postMessage──────│                            │                            │
```

Every one of these hops is a serialized message, not a function call — there's no shared memory
between any two boxes in that diagram. That constraint shapes a lot of the rest of the codebase:
state that needs to survive a service-worker restart has to be persisted explicitly (see
[Accounts and Signing](accounts-and-signing.md) and [Transaction Lifecycle](transaction-lifecycle.md)),
and anything the popup needs to show has to be fetched fresh via message, not read off a shared
object.

## Manifest V3's one big consequence: the service worker is ephemeral

Chrome can kill and restart `background/index.ts` at any time — typically after ~30 seconds of
inactivity. A plain module-level variable does not survive that. Two places in this codebase deal
with it explicitly:

- **The unlocked seed** lives in `chrome.storage.session` (`background/session.ts`) — in-memory
  only, cleared when the browser fully closes, but *does* survive a service-worker restart within a
  browsing session. A plain variable would have silently re-locked the wallet on every restart.
- **Pending approvals** used to live only in an in-memory `Map` (`background/approvals.ts`) — which
  meant a service-worker restart while an approval popup sat open silently broke the whole flow
  (the popup's eventual click had nothing left to resolve). The transaction-request flow (see
  [Transaction Lifecycle](transaction-lifecycle.md)) now persists request state instead, so this
  failure mode is fixed for anything going through it.

## Where to go next

- [Accounts and Signing](accounts-and-signing.md) — the two account types, how a local account
  derives keys and signs without ever exporting them, and how a daemon-relayed account differs.
- [Transaction Lifecycle](transaction-lifecycle.md) — building, resolving, approving, signing, and
  submitting a transaction, including the auto-retry loop and the persisted request flow.
- [Stealth Balances and HTLCs](stealth-and-htlc.md) — how private (stealth) balances work, and how
  HTLC-locked outputs are built on top of the same primitives.
