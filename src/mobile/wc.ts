// WalletConnect v2 wallet side. Every dApp request goes through the same handlePageRequest the
// extension's window.tari uses, under the origin "wc:<session topic>" -- so connection, view
// access, transaction-request ownership and approval caps all apply per session, unchanged.
import { App } from "@capacitor/app";
import { Core } from "@walletconnect/core";
import { WalletKit, type WalletKitTypes } from "@reown/walletkit";
import { getSdkError } from "@walletconnect/utils";
import { checkAutoLock, handlePageRequest, sanitizeForMessage } from "../background/core";
import { requestApproval } from "../background/approvals";
import { getAccountById } from "../background/accounts";
import { isUnlocked } from "../background/session";
import { addConnectedSite, getConnectedSite, getState, removeConnectedSite } from "../lib/storage";
import { classifyProviderError, type ProviderMethod } from "../lib/messages";
import { removeOriginLabel, sanitizeDappName, setOriginLabel, type VerifyStatus } from "../lib/originLabels";
import { networkFromWcChainId, wcChainId, wcOrigin } from "../lib/wcNamespace";
import { approvedNamespaces, checkRequest, evaluateProposal } from "./wcPolicy";
import { platform } from "../platform";
import type { AndroidPlatform } from "./platform";
import { installPairingUi, showPairingNotice } from "./pairUi";
import { requestNotificationPermissionIfUndecided } from "./notifications";

type Kit = Awaited<ReturnType<typeof WalletKit.init>>;

const VERIFY_KEY = "wcSessionVerify";

let kit: Kit | null = null;
let host: AndroidPlatform | null = null;

/** WalletConnect request ids this wallet is handling right now (delivered, not yet answered). */
const handling = new Set<number>();

/** WalletConnect hands requests over one at a time and holds the rest until the current one is
 * answered; this is how many are still waiting there, beyond those already being handled. */
export function queuedWcRequestCount(): number {
  if (!kit) return 0;
  try {
    return kit.getPendingSessionRequests().filter((r) => !handling.has(r.id)).length;
  } catch {
    return 0;
  }
}

/** Rejects every request WalletConnect is still holding (the "Reject all" shortcut). Requests
 * already on screen are rejected through the app's own approval queue. */
export async function rejectQueuedWcRequests(): Promise<void> {
  if (!kit) return;
  for (const r of kit.getPendingSessionRequests()) {
    if (handling.has(r.id)) continue;
    try {
      await kit.respondSessionRequest({ topic: r.topic, response: { id: r.id, jsonrpc: "2.0", error: { code: 4001, message: "Request rejected by the user" } } });
    } catch {
      // Already answered or the session ended.
    }
  }
}

/** After a decision made for a dApp that opened us from this phone, hand the screen back to it.
 * Called only once the reply is on its way, so backgrounding can't cut it off. */
function returnToCallerIfDone(): void {
  if (!host?.takeReturnToCaller()) return;
  showPairingNotice("Done — returning to the dApp…", "ok");
  setTimeout(() => void App.minimizeApp(), 900);
}

/** Session updates/events still being sent. A request's response waits for these, so e.g. a
 * tari_switchNetwork reply only reaches the dApp after its session has moved to the new chain. */
const inFlightForwards = new Set<Promise<void>>();

/** Runs the auto-lock check; if it locked the wallet, re-renders so the UI shows the unlock screen. */
async function lockIfDue(): Promise<void> {
  if (await checkAutoLock()) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function track(p: Promise<void>): void {
  inFlightForwards.add(p);
  void p.finally(() => inFlightForwards.delete(p));
}

/** Reown Verify's verdict on a peer: whether its claimed domain checked out, the origin it was
 * attested from, and whether that origin is on the scam list. */
interface VerifyVerdict {
  validation: VerifyStatus;
  isScam?: boolean;
  origin?: string;
}

function verdictOf(ctx: { verified: { validation: VerifyStatus; isScam?: boolean; origin: string } } | undefined): VerifyVerdict {
  const v = ctx?.verified;
  return v ? { validation: v.validation, isScam: v.isScam, origin: v.origin } : { validation: "UNKNOWN" };
}

/** Verify verdicts per session topic, kept so labels survive an app restart. */
async function loadVerify(): Promise<Record<string, VerifyVerdict>> {
  return ((await platform().local.get(VERIFY_KEY))[VERIFY_KEY] as Record<string, VerifyVerdict>) ?? {};
}

async function saveVerify(topic: string, v: VerifyVerdict | null): Promise<void> {
  const all = await loadVerify();
  if (v) all[topic] = v;
  else delete all[topic];
  await platform().local.set({ [VERIFY_KEY]: all });
}

function labelSession(topic: string, metadata: { name?: string; url?: string }, verify: VerifyVerdict): void {
  setOriginLabel(wcOrigin(topic), {
    name: metadata.name ?? "",
    url: metadata.url ?? "",
    verify: verify.validation,
    isScam: verify.isScam,
    verifiedOrigin: verify.origin,
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
  const verify = verdictOf(verifyContext);
  // An app resumed past its auto-lock deadline locks before acting on anything that arrived.
  await lockIfDue();
  const { network, activeAccountId } = await getState();

  const verdict = evaluateProposal(params, verify, network);
  if (!verdict.ok) {
    await k.rejectSession({ id, reason: getSdkError("UNSUPPORTED_CHAINS", verdict.reason) });
    showPairingNotice(verdict.reason.slice(0, 200), "err");
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
    returnToCallerIfDone();
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
  showPairingNotice(`Connected to ${sanitizeDappName(session.peer.metadata.name ?? "")}.`, "ok");
  // Now that a dApp can reach the wallet, approvals may arrive while it is in the background.
  void requestNotificationPermissionIfUndecided();
  returnToCallerIfDone();
}

async function onRequest(k: Kit, event: WalletKitTypes.SessionRequest): Promise<void> {
  handling.add(event.id);
  try {
    await handleRequest(k, event);
  } finally {
    handling.delete(event.id);
  }
}

async function handleRequest(k: Kit, event: WalletKitTypes.SessionRequest): Promise<void> {
  const { id, topic, params, verifyContext } = event;
  const origin = wcOrigin(topic);
  const send = async (response: { result: unknown } | { error: { code: number; message: string } }) => {
    try {
      await k.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", ...response } });
    } catch {
      // The session ended while this request was being handled; there is no one left to tell.
    }
  };

  // Scam status can change after a session was approved: check every request, and end the session.
  if (verdictOf(verifyContext).isScam) {
    await send({ error: { code: 4100, message: "This site is flagged as a known scam." } });
    await removeConnectedSite(origin);
    await reconcile(k);
    return;
  }
  // A request that waited in the relay while the app was backgrounded must not be served after the
  // auto-lock deadline: lock first, and the core then treats it as a locked-wallet request.
  await lockIfDue();

  const { network } = await getState();
  const verdict = checkRequest(params.request.method, params.chainId, network);
  if (!verdict.ok) {
    await send({ error: { code: 4200, message: verdict.reason } });
    return;
  }

  let response: { result: unknown } | { error: { code: number; message: string } };
  try {
    const result = await handlePageRequest({
      kind: "tari-page-request",
      origin,
      id: String(id),
      method: params.request.method as ProviderMethod,
      params: params.request.params,
    });
    response = { result: sanitizeForMessage(result) ?? null };
  } catch (err) {
    response = { error: classifyProviderError(String((err as Error)?.message ?? err)) };
  }
  await Promise.allSettled([...inFlightForwards]);
  await send(response);
  returnToCallerIfDone();
  // tari_disconnect (or any request that dropped the site) ends the transport session too.
  if (!(await getConnectedSite(origin))) await reconcile(k);
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

export async function startWalletConnect(androidHost: AndroidPlatform): Promise<void> {
  host = androidHost;
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
  k.on("session_request", (r) => void onRequest(k, r).catch(() => {}));
  k.on("session_delete", ({ topic }) => void forgetSession(topic));

  androidHost.onBroadcast((m) => track(forward(k, m)));
  androidHost.onSitesChanged(() => void reconcile(k));

  // Restore labels for sessions that survived a restart, then drop anything stale.
  const verify = await loadVerify();
  for (const [topic, session] of Object.entries(k.getActiveSessions())) {
    labelSession(topic, session.peer.metadata, verify[topic] ?? { validation: "UNKNOWN" });
  }
  await reconcile(k);

  const handleUrl = (url: string) => {
    const uri = wcUriFromDeepLink(url);
    if (!uri) return;
    // Opened by a dApp on this phone (to pair, or to bring us up for a request): it is waiting in
    // its own app, so return there once the user has decided.
    androidHost.expectReturnToCaller();
    void pairWithUri(uri).catch((e) => showPairingNotice(String(e?.message ?? e), "err"));
  };
  App.addListener("appUrlOpen", ({ url }) => handleUrl(url));
  const launch = await App.getLaunchUrl();
  if (launch?.url) handleUrl(launch.url);
}
