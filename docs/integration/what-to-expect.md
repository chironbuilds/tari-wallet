# What to Expect

Practical notes on errors, timing, and the security model — the things that are easy to get wrong
building against this wallet for the first time.

## Errors

Every `window.tari.request()` call rejects with a plain `Error` on failure — there's no structured
error-code scheme to switch on, just a message string. Common ones you'll actually hit:

- `"Site is not connected. Call tari_requestAccounts first."` — you called a connected-account
  method before connecting.
- `"Wallet is locked."` — the account resolved, but the wallet itself needs unlocking; nothing you
  can do about this from the page side except tell the user.
- `"Transaction rejected."` — the human clicked Reject in the approval popup (or closed it).
- `"Cannot submit: this request's status is \"pending\"."` — you called
  `tari_submitTransactionRequest` before the human responded. Poll `tari_getTransactionRequest`
  until `status` leaves `"pending"` first.
- `"Unknown transaction request."` — the `requestId` doesn't exist, or belongs to a different
  origin than the one asking (requests are scoped per-origin).
- A raw on-chain rejection message (fee, substate, or engine-level) for anything that made it all
  the way to submission and was rejected server-side — these come through largely unmodified from
  the indexer, so their exact wording depends on what actually went wrong on-chain.

There is no distinction in the error surface between "you called the API wrong" and "the human said
no" beyond the message text — don't try to build UX that depends on telling those apart precisely
without checking the message.

## Timing

- **Read-only calls** (`tari_getAccounts`, `tari_getNetwork`, `tari_getBalances`,
  `tari_getSubstate`, `tari_getCapabilities`) resolve as fast as the underlying network call —
  no popup, no waiting on a human.
- **Dry runs** are a single round trip to the indexer's dry-run endpoint — safe to fire on every
  keystroke for a live price quote, since they never prompt the user.
- **Real submissions** wait on a human clicking a popup, which could be seconds or could be however
  long the person takes. Don't assume any particular latency; design your UI around "waiting for
  the user," not "waiting for the network."
- **`tari_createTransactionRequest` itself is fast** (it doesn't wait for approval) — only the
  subsequent poll/submit steps depend on human timing. This is one of the practical reasons to
  prefer it over the older blocking methods: your UI thread is never stuck in one un-cancelable
  await for an indeterminate amount of time.

## The approval popup, and what it shows

The human sees, for any real submission: which site is asking, which account will sign (the site's
originally-connected account, which may not be whichever account is currently active in the
extension), the raw instructions (or a plain-language note for the stealth/HTLC operation kinds,
which don't have simple instructions to show), and the `maxFee`. There is no way for a dApp to
suppress or customize this screen — treat every real submission as something the user will
consciously see and decide on, not a background operation.

## Security boundaries worth designing around

- **The wallet's seed never leaves the extension.** There is no API that returns key material,
  signs an arbitrary message on your behalf outside of the transaction flow, or exposes the
  mnemonic to a page under any circumstance.
- **Switching accounts disconnects every site.** Don't assume a connection, once established, stays
  valid indefinitely — listen for `tari#accountsChanged` and re-request when it fires.
- **Requests are scoped per-origin.** You cannot read or submit against a `requestId` created by a
  different site, even if you somehow learned its value.
- **Dry runs are not private.** They round-trip to the indexer (`dryRunIsLocal` is `false` in
  `tari_getCapabilities`) — don't dry-run anything that would leak a secret you haven't committed
  to revealing yet. This matters specifically for future ScriptPath-spending transactions
  (see [Stealth Balances and HTLCs](../architecture/stealth-and-htlc.md)), which don't exist in the
  provider surface yet for exactly this reason.

## Check capabilities before relying on optional features

`tari_getCapabilities` reflects the **currently connected account**, not just what the extension's
code supports — `stealthWithdraw` and `htlcFund` are both `false` for a daemon-relayed account even
though the wallet has the feature for a local one. Check before calling, rather than catching the
resulting error:

```js
const caps = await window.tari.request({ method: "tari_getCapabilities" });
if (!caps.htlcFund) {
  // tell the user to switch to a local account, rather than letting tari_htlcFund fail
}
```

## Known gaps, as of this wallet's current version

- **No way to spend a script-locked (HTLC) output yet.** Funding one works; claiming or refunding
  doesn't — see [Stealth Balances and HTLCs](../architecture/stealth-and-htlc.md) for exactly what's
  missing and why it wasn't hand-rolled around the gap.
- **No local (no-egress) dry-run execution.** `dryRunIsLocal` is `false`; every dry run reaches the
  indexer.
- **Daemon-relayed accounts can't do anything stealth-related** — `tari_withdrawStealthAndExecute`
  and `tari_htlcFund` both require a local account.
