// The WalletConnect v2 namespace Sapient serves: the same methods and events as window.tari, under
// CAIP-2 chains "tari:<network>". The dApp-side connector (@chironbuilder/ootle-sdk/walletconnect)
// carries an identical copy; wcNamespace.test.ts pins the two together.
import type { NetworkName } from "@chironbuilder/ootle-sdk";
import { isNetworkName } from "@chironbuilder/ootle-sdk";
import type { ProviderMethod } from "./messages";

export const TARI_WC_NAMESPACE = "tari";

export const TARI_WC_METHODS = [
  "tari_requestAccounts",
  "tari_getAccounts",
  "tari_getNetwork",
  "tari_switchNetwork",
  "tari_getWalletAddress",
  "tari_getBalances",
  "tari_getSubstate",
  "tari_getCapabilities",
  "tari_getTransactionResult",
  "tari_signAndSubmitTransaction",
  "tari_withdrawStealthAndExecute",
  "tari_htlcFund",
  "tari_createTransactionRequest",
  "tari_getTransactionRequest",
  "tari_submitTransactionRequest",
  "tari_requestViewAccess",
  "tari_getViewAccess",
  "tari_revokeViewAccess",
  "tari_getPrivateBalances",
  "tari_getShieldedOutputs",
  "tari_scanForPrivatePayments",
  "tari_scanForResourceUtxos",
  "tari_scanForOwnedUtxos",
  "tari_claimPrivatePayment",
  "tari_signOwnershipChallenge",
  "tari_signWalletOwnershipChallenge",
  "tari_disconnect",
] as const satisfies readonly ProviderMethod[];

// Compile-time check that the list above is exhaustive: adding a ProviderMethod without listing it
// here fails the typecheck instead of silently being unreachable over WalletConnect.
type Missing = Exclude<ProviderMethod, (typeof TARI_WC_METHODS)[number]>;
const _exhaustive: [Missing] extends [never] ? true : Missing = true;
void _exhaustive;

export const TARI_WC_EVENTS = ["accountsChanged", "networkChanged"] as const;

export function wcChainId(network: NetworkName): string {
  return `${TARI_WC_NAMESPACE}:${network}`;
}

/** The network a CAIP-2 chain id names, or null for anything that isn't a Tari chain we know. */
export function networkFromWcChainId(chainId: string): NetworkName | null {
  const [ns, ref, ...rest] = chainId.split(":");
  if (ns !== TARI_WC_NAMESPACE || rest.length > 0 || !isNetworkName(ref)) return null;
  return ref;
}

const METHOD_SET: ReadonlySet<string> = new Set(TARI_WC_METHODS);

export function isWcMethod(method: unknown): method is ProviderMethod {
  return typeof method === "string" && METHOD_SET.has(method);
}

/** A WalletConnect session's origin. Keyed by session topic, never by the dApp's self-reported URL,
 * so one session can never inherit another's connection, view access or transaction requests. */
export function wcOrigin(topic: string): string {
  return `wc:${topic}`;
}

export function isWcOrigin(origin: string): boolean {
  return /^wc:[0-9a-f]{64}$/.test(origin);
}
