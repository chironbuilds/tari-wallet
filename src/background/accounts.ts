// NOTE: `../lib/wallet` and `../lib/daemonAccount` are static imports deliberately, not dynamic
// `import()`. It was briefly lazy-loaded to keep this module's own evaluation (and thus
// chrome.runtime.onMessage.addListener in background/index.ts, which must wait for every top-level
// static import to finish) fast on a service-worker cold start — but `import()` is flatly
// disallowed inside a ServiceWorkerGlobalScope (https://github.com/w3c/ServiceWorker/issues/1356;
// Chrome enforces this even for MV3 extension service workers), so that approach doesn't run at
// all. The cold-start race this was working around is instead absorbed by the retry-with-backoff
// in content-script.ts / popup/main.ts's `send()` helpers.
import { WalletDaemonClient } from "@tari-project/ootle-wallet-daemon-signer";
import type { WalletAccountApi } from "../lib/accountApi";
import { DaemonAccount } from "../lib/daemonAccount";
import { OotleAccount } from "../lib/wallet";
import { type AccountId, getState, parseAccountId } from "../lib/storage";
import { getUnlockedSeed } from "./session";

// Cache account instances (they hold a live network connection) so repeated calls within one
// unlocked session reuse the same connection — local accounts keyed by "network:index", daemon
// clients keyed by connection id (shared across every account on that daemon), daemon accounts
// keyed by "connectionId:componentAddress".
const localCache = new Map<string, OotleAccount>();
const daemonClientCache = new Map<string, WalletDaemonClient>();
const daemonAccountCache = new Map<string, DaemonAccount>();

export async function getActiveAccount(): Promise<WalletAccountApi | null> {
  const { activeAccountId } = await getState();
  return getAccountById(activeAccountId);
}

export async function getAccountById(id: string): Promise<WalletAccountApi | null> {
  return resolveAccountId(parseAccountId(id));
}

async function resolveAccountId(id: AccountId): Promise<WalletAccountApi | null> {
  if (id.type === "local") {
    const seed = await getUnlockedSeed();
    if (!seed) return null;
    const { network } = await getState();
    return getLocalAccount(seed, network, id.index);
  }
  return getDaemonAccount(id.connectionId, id.componentAddress);
}

function getLocalAccount(seed: Uint8Array, network: "esmeralda" | "igor", index: number): OotleAccount {
  const key = `${network}:${index}`;
  let account = localCache.get(key);
  if (!account) {
    account = OotleAccount.fromSeed(seed, index, network);
    localCache.set(key, account);
  }
  return account;
}

/** Returns the cached authenticated client for a connection, or connects fresh using its stored
 * auth token. Kept separate from `getDaemonAccount` so the "connect + list accounts" flow (before
 * any account has been added yet) can reuse the exact same cached client. */
export async function getDaemonClient(connectionId: string): Promise<WalletDaemonClient> {
  const cached = daemonClientCache.get(connectionId);
  if (cached) return cached;

  const { daemonConnections } = await getState();
  const config = daemonConnections.find((c) => c.id === connectionId);
  if (!config) throw new Error(`Unknown daemon connection: ${connectionId}`);
  const client = await DaemonAccount.connectClient(config.url, config.authToken);
  daemonClientCache.set(connectionId, client);
  return client;
}

async function getDaemonAccount(connectionId: string, componentAddress: string): Promise<DaemonAccount> {
  const key = `${connectionId}:${componentAddress}`;
  const cached = daemonAccountCache.get(key);
  if (cached) return cached;

  const { network } = await getState();
  const client = await getDaemonClient(connectionId);
  const account = await DaemonAccount.connectAccount(client, network, componentAddress);
  daemonAccountCache.set(key, account);
  return account;
}

export function clearAccountCache(): void {
  localCache.clear();
  daemonClientCache.clear();
  daemonAccountCache.clear();
}
