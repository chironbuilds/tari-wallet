# Getting Started

Once loaded, Sapient injects a MetaMask-style provider at `window.tari` into every page —
`request({ method, params })`, not the WalletConnect relay protocol. `tari-dex/swap-ui` is a
complete, real working example of everything on this page.

## Detect the wallet

It may not exist yet at page-load time — the content script injects it, which happens slightly
after `document_start` — so listen for its ready event too, don't just check once:

```js
if (!window.tari?.isTariWallet) {
  window.addEventListener("tari#initialized", () => console.log("Tari wallet ready"), { once: true });
}
```

## Connect

Prompts the user with an approval popup the first time; a no-op afterward for the same origin.

```js
const [accountAddress] = await window.tari.request({ method: "tari_requestAccounts" });
```

## Read-only calls

None of these prompt an approval popup:

```js
await window.tari.request({ method: "tari_getAccounts" });   // -> string[] (already-connected accounts)
await window.tari.request({ method: "tari_getNetwork" });    // -> "esmeralda" | "igor"
await window.tari.request({ method: "tari_getBalances" });   // -> TokenBalance[]
await window.tari.request({
  method: "tari_getSubstate",
  params: { substateId: "resource_...", version: null },
});
await window.tari.request({ method: "tari_getCapabilities" }); // -> WalletCapabilities, see below
```

## Build and submit a transaction

The current recommended shape (see [Transaction Requests](transaction-requests.md) for the full
create/approve/submit flow and why it's worth using over the older single-call method):

```js
const { requestId } = await window.tari.request({
  method: "tari_createTransactionRequest",
  params: {
    kind: "instructions",
    instructions: [ /* raw Instruction[] from @tari-project/ootle-ts-bindings */ ],
    maxFee: "5000", // optional, string (µT)
  },
});

// Poll until the human responds in the wallet's own popup.
let record;
do {
  await new Promise((r) => setTimeout(r, 700));
  record = await window.tari.request({ method: "tari_getTransactionRequest", params: { requestId } });
} while (record.status === "pending");

if (record.status !== "approved") throw new Error(record.error ?? "Transaction rejected.");
const result = await window.tari.request({ method: "tari_submitTransactionRequest", params: { requestId } });
```

The older single-call shape still works — one blocking `tari_signAndSubmitTransaction` call that
handles the approval wait internally — but see
[Transaction Requests](transaction-requests.md) for why the flow above is worth adopting.

## Disconnect and account changes

```js
await window.tari.request({ method: "tari_disconnect" });

// Fires (mirroring EIP-1193's accountsChanged) whenever the wallet drops this page's connection
// out from under it -- e.g. the user switched the active account in the extension. detail is
// always [] -- treat it purely as a signal to re-run tari_requestAccounts before the next call.
window.addEventListener("tari#accountsChanged", (e) => {
  console.log("accounts changed:", e.detail); // []
});
```

## Notes from building a real dApp against this wallet

- **CBOR-encode instruction args yourself.** `instructions` are the raw `Instruction[]` shape from
  `@tari-project/ootle-ts-bindings` — numeric/address/string args need `InstructionArg::Literal`
  CBOR encoding (`amountLiteral`/`resourceAddressLiteral`/`componentAddressLiteral`/`stringLiteral`,
  exported by `@tari-project/ootle` if you can depend on it directly).
- **You don't need to know every substate your instructions touch.** The wallet's own auto-retry
  discovers and pins whatever's still missing (see
  [Transaction Lifecycle](../architecture/transaction-lifecycle.md)) — `inputs` is purely an
  optimization, never required for correctness.
- **Dry-run calls skip the approval popup**, real submissions don't — safe to dry-run on every
  keystroke (e.g. a live price quote) without spamming the user with popups. Dry runs never go
  through the transaction-request system either — they're a direct, synchronous call regardless of
  which method you use for the real submission.
- Resource decimal precision (`divisibility`) and display names (`symbol`) are real on-chain data,
  fetched via `tari_getSubstate` or returned directly by `tari_getBalances` — don't hardcode a
  decimals constant per token.
- Switching the active account inside the extension disconnects every connected site and fires
  `tari#accountsChanged` on every open tab — listen for it rather than caching the account address
  from `tari_requestAccounts` indefinitely.

Next: the [full method reference](provider-api.md), the
[transaction-request flow in depth](transaction-requests.md), or
[what to expect](what-to-expect.md) once you're live.
