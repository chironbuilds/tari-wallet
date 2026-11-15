// What the WalletConnect bridge accepts, as pure functions (no WalletKit, no I/O) so every rule is
// unit-tested. wc.ts applies these before anything reaches the wallet core.
import type { NetworkName } from "@chironbuilder/ootle-sdk";
import { isWcMethod, networkFromWcChainId, TARI_WC_EVENTS, TARI_WC_METHODS, TARI_WC_NAMESPACE, wcChainId } from "../lib/wcNamespace";

interface NamespaceRequest {
  chains?: string[];
  methods?: string[];
  events?: string[];
}

export interface ProposalShape {
  requiredNamespaces: Record<string, NamespaceRequest>;
  optionalNamespaces?: Record<string, NamespaceRequest>;
}

export interface VerifyShape {
  validation: "UNKNOWN" | "VALID" | "INVALID";
  isScam?: boolean;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Chains a namespace entry asks for. A namespace key may itself be a chain ("tari:mainnet"). */
function chainsOf(key: string, ns: NamespaceRequest): string[] {
  if (key.includes(":")) return [key];
  return ns.chains ?? [];
}

/**
 * Whether a session proposal can be offered to the user at all. The wallet serves exactly one
 * chain -- the network it is on -- so a dApp that *requires* anything else (another namespace, or
 * another Tari network) is refused with a reason it can show, rather than approved with a session
 * that would then fail every request.
 */
export function evaluateProposal(proposal: ProposalShape, verify: VerifyShape, network: NetworkName): Verdict {
  if (verify.isScam) return { ok: false, reason: "This site is flagged as a known scam." };
  const ourChain = wcChainId(network);

  for (const [key, ns] of Object.entries(proposal.requiredNamespaces ?? {})) {
    const nsName = key.split(":")[0];
    if (nsName !== TARI_WC_NAMESPACE) return { ok: false, reason: `Sapient only supports Tari; the site requires "${nsName}".` };
    for (const chain of chainsOf(key, ns)) {
      const net = networkFromWcChainId(chain);
      if (!net) return { ok: false, reason: `Unknown Tari network "${chain}".` };
      if (net !== network) return { ok: false, reason: `The site requires ${net}; Sapient is on ${network}. Switch network and try again.` };
    }
  }

  const offered = [...Object.entries(proposal.requiredNamespaces ?? {}), ...Object.entries(proposal.optionalNamespaces ?? {})]
    .filter(([key]) => key.split(":")[0] === TARI_WC_NAMESPACE)
    .flatMap(([key, ns]) => chainsOf(key, ns));
  if (!offered.includes(ourChain)) {
    return { ok: false, reason: `The site didn't ask for ${network}, the network Sapient is on.` };
  }
  return { ok: true };
}

/** The namespaces to approve the session with: our one chain, every method, the active account. */
export function approvedNamespaces(network: NetworkName, address: string) {
  const chain = wcChainId(network);
  return {
    [TARI_WC_NAMESPACE]: {
      chains: [chain],
      methods: [...TARI_WC_METHODS],
      events: [...TARI_WC_EVENTS],
      accounts: [`${chain}:${address}`],
    },
  };
}

/** Whether one session request may be passed to the core. */
export function checkRequest(method: unknown, chainId: string, network: NetworkName): Verdict {
  if (!isWcMethod(method)) return { ok: false, reason: `Unsupported method: ${String(method)}` };
  const net = networkFromWcChainId(chainId);
  if (!net) return { ok: false, reason: `Unknown chain: ${chainId}` };
  // Never silently act on a different network than the one the request names: the dApp built its
  // request (addresses, resources, fees) for that chain.
  if (net !== network) return { ok: false, reason: `Request is for ${net}, but Sapient is on ${network}.` };
  return { ok: true };
}
