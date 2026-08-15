# Provider API Reference

Every method is called the same way: `window.tari.request({ method, params })`. Methods marked
**approval** pop the wallet's own confirmation window and wait on the human; everything else
resolves immediately (subject to the account being connected/unlocked).

## Connection

| Method | Params | Returns | Notes |
|---|---|---|---|
| `tari_requestAccounts` | none | `string[]` | **Approval** the first time per origin; a no-op afterward. |
| `tari_getAccounts` | none | `string[]` | Already-connected accounts for this origin, `[]` if none. |
| `tari_disconnect` | none | `null` | Drops this origin's connection. |
| `tari_getNetwork` | none | `"esmeralda" \| "igor"` | Never touches activity/auto-lock — safe to poll. |

## Reading state

| Method | Params | Returns | Notes |
|---|---|---|---|
| `tari_getBalances` | none | `TokenBalance[]` | See shape below. Requires a connected, unlocked account. |
| `tari_getSubstate` | `{ substateId, version? }` | raw `Substate` | General-purpose; not tied to the connected account. |
| `tari_getCapabilities` | none | `WalletCapabilities` | See shape below. Reflects the *connected account*, not just the codebase. |
| `tari_getTransactionResult` | `{ transactionId }` | indexer result | Look up a past transaction's on-chain result by id. |

```ts
interface TokenBalance {
  resourceAddress: string;
  kind: string; // "Fungible" | "NonFungible" | "Confidential" | "Stealth"
  amount: bigint;              // plain, public (revealed) amount
  confidentialAmount: bigint;  // decrypted with this account's own view key; 0n unless Confidential
  confidentialDecryptFailures: number;
  divisibility: number;        // real on-chain Resource.divisibility, e.g. 6 for XTR
  symbol: string | null;       // Resource.metadata.SYMBOL, if set
  name: string | null;         // Resource.metadata.name, if set
}

interface WalletCapabilities {
  exactInputSelection: boolean;   // always true today
  stealthWithdraw: boolean;       // tari_withdrawStealthAndExecute -- local accounts only
  htlcFund: boolean;               // tari_htlcFund -- local accounts only
  scriptPathSpend: boolean;        // spending a script-locked output -- always false today
  transactionResultLookup: boolean; // always true today
  transactionRequests: boolean;    // create/approve/submit flow -- always true today
  dryRunIsLocal: boolean;          // always false today -- dry runs round-trip to the indexer
}
```

## Submitting transactions

Prefer the create/approve/submit trio for anything new — see
[Transaction Requests](transaction-requests.md) for the full flow, polling pattern, and why it's
worth adopting over the single-call methods below.

| Method | Params | Returns | Notes |
|---|---|---|---|
| `tari_createTransactionRequest` | `TransactionRequestOperation` | `{ requestId }` | **Approval** (opens the popup, doesn't block on it). |
| `tari_getTransactionRequest` | `{ requestId }` | `TransactionRequestSummary` | Poll this until `status !== "pending"`. Works after a reload. |
| `tari_submitTransactionRequest` | `{ requestId }` | the operation's result | Throws unless `status === "approved"`. |

```ts
type TransactionRequestOperation =
  | { kind: "instructions"; instructions: Instruction[]; maxFee?: string; inputs?: SubstateRequirement[] }
  | {
      kind: "withdrawStealthAndExecute";
      resourceAddress: string;
      amount: string;
      workspaceVarName: string;
      followUpInstructions: Instruction[];
      relatedComponents?: string[];
      maxFee?: string;
    }
  | {
      kind: "htlcFund";
      resourceAddress: string;
      amount: string;
      claimantWalletAddress: string;
      hashLockHex: string;
      refundEpoch: string;
      maxFee?: string;
    };

interface TransactionRequestSummary {
  requestId: string;
  status: "pending" | "approved" | "rejected" | "submitted" | "failed";
  note: string;       // human-readable summary, the same text shown on the popup
  createdAt: number;
  expiresAt: number;
  result?: unknown;   // set once status === "submitted"
  error?: string;     // set once status === "rejected" | "failed"
}
```

### Deprecated single-call methods

Still fully supported — implemented as thin wrappers over the create/submit primitives above, so
existing integrations keep working unchanged. New integrations should prefer the trio above.

| Method | Params | Returns | Equivalent to |
|---|---|---|---|
| `tari_signAndSubmitTransaction` | `{ instructions, maxFee?, dryRun?, inputs? }` | execution result | `{ kind: "instructions", ... }` (or a direct dry-run call, unaffected either way) |
| `tari_withdrawStealthAndExecute` | `{ resourceAddress, amount, workspaceVarName, followUpInstructions, relatedComponents?, maxFee? }` | execution result | `{ kind: "withdrawStealthAndExecute", ... }` |
| `tari_htlcFund` | `{ resourceAddress, amount, claimantWalletAddress, hashLockHex, refundEpoch, maxFee? }` | `{ transactionId, conditions, ownCommitment }` | `{ kind: "htlcFund", ... }` |

`tari_signAndSubmitTransaction`'s `dryRun: true` path is a **direct, synchronous call** in every
case — it never needed approval, and never goes through the request-tracking system at all,
regardless of which method you use for the real submission afterward.

## Events

| Event | Detail | Fires when |
|---|---|---|
| `tari#initialized` | none | The provider has finished injecting — listen for this if `window.tari` isn't present yet at your load time. |
| `tari#accountsChanged` | `[]` | The wallet drops this page's connection out from under it (e.g. the user switched accounts). Treat as a signal to re-run `tari_requestAccounts`, not as carrying the new account list. |
