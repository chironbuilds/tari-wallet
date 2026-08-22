# Transaction Lifecycle

This page covers what actually happens between "a dApp wants to submit a transaction" and "the
result comes back" — both the client-side substate-resolution problem `OotleAccount.execute()`
solves, and the create → approve → submit flow that wraps it for anything a dApp asks for.

## `OotleAccount.execute()`: build, resolve, sign, retry

Neither the TypeScript SDK nor the indexer this wallet talks to directly does automatic
dependency-graph discovery ("want-derivation") the way the Rust `ootle_sdk_core` does server-side.
Concretely: if an instruction touches a component whose vaults aren't known yet, the engine simply
rejects the transaction naming the missing substate — it doesn't resolve it for you. `execute()`
handles this with a **reactive retry loop**:

```
loop (up to maxRetries, default 30):
  build a TransactionBuilder from instructions + whatever inputs are known so far
  try to submit
  on success: return
  on "SubstateNotFound: X" (a specific address named in the rejection):
    resolve X's current version, add it to inputs, retry
  on "Lock failure: Substate X:N is DOWN":
    the next version is deterministically N+1 — compute it locally, retry
    (re-querying the indexer here can hand back the same stale version; this wallet's own prior
    attempt can have advanced the real version further still if it reached and paid the fee phase
    before the main instructions failed)
  on "InsufficientFeesPaid"/"insufficient...":
    fail immediately — no amount of retrying fixes an empty fee vault
```

A first-time transaction into brand-new resources can need several retries — each pool, each pool's
own internal vaults, and any new vault the account itself needs created to hold a token it's never
held before are each discovered one rejection at a time. A multi-hop swap touches roughly double
the substates a direct one does.

A dApp can shortcut some of this by passing `inputs` — substates it already knows are needed (see
[Provider API Reference](../integration/provider-api.md)) — but it's always an optimization, never
required for correctness; the retry loop discovers whatever's left.

**Dry runs** (`dryRun: true`) go through the identical build/resolve pipeline but post to a
separate `/transactions/dry-run` endpoint and return synchronously with the full simulated result —
no polling, and no approval popup (see below).

## Approval: the human-only gate

Anything that isn't a dry run needs the user's explicit sign-off before it signs or spends
anything. `background/approvals.ts` owns this: given a request, it opens a small popup window
(`popup.html#/approve/<id>`) and returns a promise that resolves once the user clicks Approve or
Reject (or closes the window, treated as a rejection). The popup fetches the request's details back
via `popup-get-pending-approval` and reports the click via `popup-resolve-approval` — there is no
way for a dApp to click this button itself; only the popup, driven by the human, ever resolves it.

## The create → approve → submit flow

As of this wallet's current version, the dApp-facing transaction surface is built around a
three-step flow that mirrors `tari_ootle_walletd`'s own `transaction_requests.create/approve/submit`
(tari-project/tari-ootle#2348) — adapted for a browser extension, where the *approver* is always
the human via the popup, never a dApp. There is deliberately no dApp-facing "approve" method: a
dApp that could approve its own request would defeat the entire point of asking.

```
tari_createTransactionRequest ──▶ [pending]   (returns a requestId immediately, doesn't block)
                                      │
                    human approves/rejects via the popup (unchanged mechanism above)
                                      │
                         ┌────────────┴────────────┐
                    [approved]                 [rejected]
                         │
           tari_submitTransactionRequest ──▶ executes, returns the result
```

The record backing this (`TransactionRequestRecord`, `src/lib/storage.ts`) is **persisted** in
`chrome.storage.local`, not held only in an in-memory map — the actual reason for this design isn't
just matching walletd's shape, it fixes a real robustness gap. The old flow's pending-approval state
lived only in memory; if the service worker restarted (Chrome tears MV3 workers down after ~30s
idle) while an approval popup sat open, the popup's eventual click had nothing left to resolve, and
the whole flow silently died. With a persisted request, a dApp can poll `tari_getTransactionRequest`
after a page reload or a service-worker restart and pick the flow back up from wherever it left off.

A request's `operation` is one of three shapes — the same three the deprecated single-call methods
below cover — and status moves through `pending → approved|rejected`, then (once submitted)
`→ submitting → submitted|failed`. The `submitting` hop is claimed atomically in the same
serialized storage write that validates the request is still approved and unexpired, immediately
before execution: two racing submits cannot both pass the gate (exactly one wins; the loser sees a
`wrong-status` rejection instead of double-executing), and a service worker killed mid-execution
leaves a permanently-unresubmittable record rather than one that could re-submit an
already-landed transaction. Expiry is derived lazily on read (a stale pending/approved request
reads back as rejected with an explanatory error), never written back — the same "expired,
derived on read" design walletd itself uses, rather than a background sweep.

**The older single-call methods are still fully supported**, implemented as thin wrappers over
exactly these same primitives (create, wait for the approval promise directly instead of polling,
submit) — so existing dApp integrations don't break. See
[Transaction Requests](../integration/transaction-requests.md) for the practical migration guidance
and [Provider API Reference](../integration/provider-api.md) for the full method list.

## The three operation kinds

- **`instructions`** — a raw `Instruction[]`, the generic case. Executed via
  `WalletAccountApi.execute()`.
- **`withdrawStealthAndExecute`** — reveals Stealth-typed funds into a bucket and feeds it into
  caller-supplied follow-up instructions, all in one signed transaction. See
  [Stealth Balances and HTLCs](stealth-and-htlc.md) for why this needs to be its own operation kind
  rather than expressible as plain instructions.
- **`htlcFund`** — creates an HTLC-locked stealth output. Also covered in
  [Stealth Balances and HTLCs](stealth-and-htlc.md).

Each operation kind has its own account-side method (`execute`, `withdrawStealthAndExecute`,
`htlcFund`) and its own popup-approval summary text, computed once at request-creation time and
shown identically whether the request came in through the new create/submit path or one of the
deprecated single-call wrappers.
