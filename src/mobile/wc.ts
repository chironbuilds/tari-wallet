// WalletConnect v2 wallet side. Every dApp request goes through the same handlePageRequest the
// extension's window.tari uses, under the origin "wc:<session topic>" -- so connection, view
// access, transaction-request ownership and approval caps all apply per session, unchanged.
import { App } from "@capacitor/app";
import { Core } from "@walletconnect/core";
import { WalletKit, type WalletKitTypes } from "@reown/walletkit";
import { getSdkError } from "@walletconnect/utils";
import { handlePageRequest, sanitizeForMessage } from "../background/core";
import { requestApproval } from "../background/approvals";
import { getAccountById } from "../background/accounts";
import { isUnlocked } from "../background/session";
import { addConnectedSite, getConnectedSite, getState, removeConnectedSite } from "../lib/storage";
import { classifyProviderError, type ProviderMethod } from "../lib/messages";
import { removeOriginLabel, setOriginLabel, type VerifyStatus } from "../lib/originLabels";
import { networkFromWcChainId, wcChainId, wcOrigin } from "../lib/wcNamespace";
import { approvedNamespaces, checkRequest, evaluateProposal } from "./wcPolicy";
import { platform } from "../platform";
import type { AndroidPlatform } from "./platform";
import { installPairingUi, showPairingNotice } from "./pairUi";

type Kit = Awaited<ReturnType<typeof WalletKit.init>>;

const VERIFY_KEY = "wcSessionVerify";

let kit: Kit | null = null;

/** Session updates/events still being sent. A request's response waits for these, so e.g. a
 * tari_switchNetwork reply only reaches the dApp after its session has moved to the new chain. */
const inFlightForwards = new Set<Promise<void>>();

function track(p: Promise<void>): void {
  inFlightForwards.add(p);
  void p.finally(() => inFlightForwards.delete(p));
}

/** Reown Verify's verdict per session topic, kept so labels survive an app restart. */
async function loadVerify(): Promise<Record<string, { validation: VerifyStatus; isScam?: boolean }>> {
  return ((await platform().local.get(VERIFY_KEY))[VERIFY_KEY] as Record<string, { validation: VerifyStatus; isScam?: boolean }>) ?? {};
}

async function saveVerify(topic: string, v: { validation: VerifyStatus; isScam?: boolean } | null): Promise<void> {
  const all = await loadVerify();
  if (v) all[topic] = v;
  else delete all[topic];
  await platform().local.set({ [VERIFY_KEY]: all });
}

function labelSession(topic: string, metadata: { name?: string; url?: string }, verify: { validation: VerifyStatus; isScam?: boolean }): void {
  setOriginLabel(wcOrigin(topic), {
    name: metadata.name?.trim() || "Unnamed dApp",
    url: metadata.url ?? "",
    verify: verify.validation,
    isScam: verify.isScam,
  });
}

async function forgetSession(topic: string): Promise<void> {
  const origin = wcOrigin(topic);
  await removeConnectedSite(origin);
  removeOriginLabel(origin);
  await saveVerify(topic, null);
}

async function onProposal(k: Kit, proposal: WalletKitTypes.SessionProposal): Promise<void> {
  const { id, params, verifyContext } = proposal;
  const verify = { validation: verifyContext.verified.validation, isScam: verifyContext.verified.isScam };
  const { network, activeAccountId } = await getState();

  const verdict = evaluateProposal(params, verify, network);
  if (!verdict.ok) {
    await k.rejectSession({ id, reason: getSdkError("UNSUPPORTED_CHAINS", verdict.reason) });
    showPairingNotice(verdict.reason, "err");
    return;
  }

  // The session topic isn't known until approveSession returns, so the connect prompt runs under a
  // provisional origin that exists only for this prompt, labelled with the dApp's claim.
  const provisional = wcOrigin(params.pairingTopic);
  labelSession(params.pairingTopic, params.proposer.metadata, verify);
  let approved = false;
  try {
    approved = await requestApproval({ kind: "connect", origin: provisional, accountId: activeAccountId });
  } finally {
    removeOriginLabel(provisional);
  }
  if (!approved || !(await isUnlocked())) {
    await k.rejectSession({ id, reason: getSdkError("USER_REJECTED") });
    return;
  }

  const account = await getAccountById(activeAccountId);
  if (!account) {
    await k.rejectSession({ id, reason: getSdkError("USER_REJECTED", "Could not resolve account.") });
    return;
  }
  const address = await account.getComponentAddress();
  const session = await k.approveSession({ id, namespaces: approvedNamespaces(network, address) });
  await addConnectedSite(wcOrigin(session.topic), activeAccountId);
  labelSession(session.topic, session.peer.metadata, verify);
  await saveVerify(session.topic, verify);
  showPairingNotice(`Connected to ${session.peer.metadata.name || "dApp"}.`, "ok");
}

async function onRequest(k: Kit, event: WalletKitTypes.SessionRequest): Promise<void> {
  const { id, topic, params } = event;
  const respondError = (code: number, message: string) =>
    k.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", error: { code, message } } });

  const { network } = await getState();
  const verdict = checkRequest(params.request.method, params.chainId, network);
  if (!verdict.ok) {
    await respondError(4200, verdict.reason);
    return;
  }

  try {
    const result = await handlePageRequest({
      kind: "tari-page-request",
      origin: wcOrigin(topic),
      id: String(id),
      method: params.request.method as ProviderMethod,
      params: params.request.params,
    });
    await Promise.allSettled([...inFlightForwards]);
    await k.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", result: sanitizeForMessage(result) ?? null } });
  } catch (err) {
    const { code, message } = classifyProviderError(String((err as Error)?.message ?? err));
    await respondError(code, message);
  }
  // tari_disconnect (or any request that dropped the site) ends the transport session too.
  if (!(await getConnectedSite(wcOrigin(topic)))) await reconcile(k);
}

/** Brings WalletConnect sessions and connected "wc:" sites back in line after either side changed:
 * a session whose site was removed (disconnect, reset, network switch) is ended, and a site whose
 * session is gone (expired, deleted while the app was closed) is removed. */
async function reconcile(k: Kit): Promise<void> {
  const sessions = k.getActiveSessions();
  for (const topic of Object.keys(sessions)) {
    if (await getConnectedSite(wcOrigin(topic))) continue;
    try {
      await k.disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") });
    } catch {
      // Already gone on the relay side.
    }
    await forgetSession(topic);
  }
  const { connectedSites } = await getState();
  for (const site of connectedSites) {
    if (!site.origin.startsWith("wc:")) continue;
    const topic = site.origin.slice(3);
    if (!sessions[topic]) await forgetSession(topic);
  }
}

/** Forwards accounts/network changes to every live session. On a network change, a session that
 * kept its connection (the one whose tari_switchNetwork the user approved) has its namespace moved
 * to the new chain first, so its next request isn't refused for naming the old one. */
async function forward(k: Kit, message: Parameters<Parameters<AndroidPlatform["onBroadcast"]>[0]>[0]): Promise<void> {
  const { network } = await getState();
  for (const [topic, session] of Object.entries(k.getActiveSessions())) {
    const site = await getConnectedSite(wcOrigin(topic));
    if (!site) continue;
    try {
      if (message.kind === "tari-network-changed") {
        const sessionChains = session.namespaces.tari?.chains ?? [];
        if (!sessionChains.includes(wcChainId(network))) {
          const account = await getAccountById(site.accountId);
          if (!account || !(await isUnlocked())) continue;
          await k.updateSession({ topic, namespaces: approvedNamespaces(network, await account.getComponentAddress()) });
        }
        await k.emitSessionEvent({ topic, chainId: wcChainId(network), event: { name: "networkChanged", data: message.network } });
      } else {
        // Emitted on a chain the session already has: during a network switch this event goes
        // out before the session is moved to the new chain, and an event on a chain the session
        // lacks is refused by WalletConnect.
        const chains = session.namespaces.tari?.chains ?? [];
        const chainId = chains.find((c) => networkFromWcChainId(c) === network) ?? chains[0];
        if (!chainId) continue;
        await k.emitSessionEvent({ topic, chainId, event: { name: "accountsChanged", data: message.accounts } });
      }
    } catch {
      // A session that went away mid-loop is cleaned up by the next reconcile.
    }
  }
}

/** Pairs with a dApp from a "wc:" URI (scanned, pasted, or opened as a deep link). */
export async function pairWithUri(uri: string): Promise<void> {
  if (!kit) throw new Error("WalletConnect is not available in this build.");
  const trimmed = uri.trim();
  if (!trimmed.startsWith("wc:")) throw new Error("Not a WalletConnect link.");
  // A link without a symKey is a dApp's "return to wallet" nudge for an existing session: opening
  // the app was the whole point, there is nothing to pair.
  if (!trimmed.includes("symKey=")) return;
  await kit.pair({ uri: trimmed });
}

/** "wc:..." directly, or "sapient://wc?uri=<encoded wc:...>" (for dApps that can't open wc: links). */
export function wcUriFromDeepLink(url: string): string | null {
  if (url.startsWith("wc:")) return url;
  try {
    const u = new URL(url);
    if (u.protocol === "sapient:" && (u.host === "wc" || u.pathname.replace(/^\/+/, "") === "wc")) return u.searchParams.get("uri");
  } catch {
    // not a URL we handle
  }
  return null;
}

export async function startWalletConnect(host: AndroidPlatform): Promise<void> {
  const projectId = import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined;
  installPairingUi(pairWithUri, Boolean(projectId));
  if (!projectId) return;

  const core = new Core({ projectId });
  const k = await WalletKit.init({
    core,
    metadata: {
      name: "Sapient",
      description: "Self-custody wallet for Tari Ootle",
      url: "https://sapient.tari.mw",
      icons: ["https://sapient.tari.mw/icon.png"],
      redirect: { native: "sapient://" },
    },
  });
  kit = k;

  k.on("session_proposal", (p) => void onProposal(k, p).catch((e) => showPairingNotice(String(e?.message ?? e), "err")));
  k.on("session_request", (r) => void onRequest(k, r));
  k.on("session_delete", ({ topic }) => void forgetSession(topic));

  host.onBroadcast((m) => track(forward(k, m)));
  host.onSitesChanged(() => void reconcile(k));

  // Restore labels for sessions that survived a restart, then drop anything stale.
  const verify = await loadVerify();
  for (const [topic, session] of Object.entries(k.getActiveSessions())) {
    labelSession(topic, session.peer.metadata, verify[topic] ?? { validation: "UNKNOWN" });
  }
  await reconcile(k);

  const handleUrl = (url: string) => {
    const uri = wcUriFromDeepLink(url);
    if (uri) void pairWithUri(uri).catch((e) => showPairingNotice(String(e?.message ?? e), "err"));
  };
  App.addListener("appUrlOpen", ({ url }) => handleUrl(url));
  const launch = await App.getLaunchUrl();
  if (launch?.url) handleUrl(launch.url);
}
