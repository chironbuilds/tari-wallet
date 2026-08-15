# Transaction Requests

This is the recommended way to submit any real (non-dry-run) transaction, and the shape every
future dApp-facing transaction method will follow. It mirrors `tari_ootle_walletd`'s own
`transaction_requests.create/approve/submit` flow, so an adapter built for one is close to
compatible with the other.

## Why this exists over a single blocking call

The older `tari_signAndSubmitTransaction`-style methods block on one promise for the entire
approval-and-submit round trip. That's fine while the page stays open and focused, but if the page
reloads (or the user navigates away and back) while the wallet's approval popup is still open,
that promise — and everything waiting on it — is just gone. There's no way to recover.

The create/approve/submit split fixes this because the three steps are independent calls, and the
request itself is persisted on the wallet's side, not tied to the lifetime of any one call:

```
tari_createTransactionRequest ──▶ { requestId }         (returns immediately)
                                        │
                    human clicks Approve/Reject in the wallet's popup
                                        │
tari_getTransactionRequest ──▶ { status: "approved" }   (poll this; works after a reload)
                                        │
tari_submitTransactionRequest ──▶ result
```

If your page reloads after creating a request but before submitting it, just resume polling
`tari_getTransactionRequest` with the same `requestId` — you don't need to keep it in memory only;
persist it yourself (e.g. `localStorage`) if you want a reload to actually resume instead of
starting over.

## A reusable helper

This is the exact pattern used in `tari-dex`'s own dApps:

```js
async function createAndSubmit(operation, pollIntervalMs = 700) {
  const { requestId } = await window.tari.request({ method: "tari_createTransactionRequest", params: operation });
  for (;;) {
    const record = await window.tari.request({ method: "tari_getTransactionRequest", params: { requestId } });
    switch (record.status) {
      case "approved":
        return window.tari.request({ method: "tari_submitTransactionRequest", params: { requestId } });
      case "submitted":
        return record.result; // resuming an already-finished request
      case "rejected":
      case "failed":
        throw new Error(record.error ?? `Transaction ${record.status}.`);
      case "pending":
        await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}

// Usage:
const result = await createAndSubmit({ kind: "instructions", instructions, maxFee: "50000" });
```

Note the `"submitted"` case: calling `tari_getTransactionRequest` (or even
`tari_createTransactionRequest` again, though you should reuse the returned `requestId` instead)
against a request that's already gone all the way through is not an error — you just get its
stored result back, which is exactly what makes resuming after a reload work.

## Migrating from the single-call methods

There is no forced migration — `tari_signAndSubmitTransaction`,
`tari_withdrawStealthAndExecute`, and `tari_htlcFund` all remain fully supported. If you're
migrating anyway:

| Old call | New equivalent |
|---|---|
| `tari_signAndSubmitTransaction({ instructions, maxFee, inputs })` | `createAndSubmit({ kind: "instructions", instructions, maxFee, inputs })` |
| `tari_withdrawStealthAndExecute({ ... })` | `createAndSubmit({ kind: "withdrawStealthAndExecute", ... })` |
| `tari_htlcFund({ ... })` | `createAndSubmit({ kind: "htlcFund", ... })` |
| `tari_signAndSubmitTransaction({ ..., dryRun: true })` | unchanged -- dry runs never go through this flow either way |

The result shape each operation resolves to is unchanged — only how you get there changed.

## What you can't do

There is no `tari_approveTransactionRequest`. Approval is exclusively a human action taken in the
wallet's own popup UI. This isn't an oversight — a dApp that could approve its own request would
make the entire approval step meaningless, since the "only a human can authorize spending" property
is the actual security boundary the whole flow exists to protect.
