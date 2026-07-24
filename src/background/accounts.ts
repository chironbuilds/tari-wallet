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
import { decryptSecret } from "../lib/secretAtRest";
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
  // Both account kinds require the wallet to be unlocked, not just local ones -- a daemon
  // account's own API key is encrypted with a key derived from the seed (see secretAtRest.ts),
  // so it's unusable without an unlocked seed anyway; checking here just turns that into a clean
  // "wallet is locked" instead of a decrypt error surfacing from somewhere deeper.
  const seed = await getUnlockedSeed();
  if (!seed) return null;
  if (id.type === "local") {
    const { network } = await getState();
    return getLocalAccount(seed, network, id.index);
  }
  return getDaemonAccount(seed, id.connectionId, id.componentAddress);
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

/** Returns the cached authenticated client (and its URL) for a connection, or connects fresh by
 * decrypting its stored API key with `seed` (see secretAtRest.ts -- the key is encrypted at rest,
 * so a live unlocked seed is required to ever use a daemon connection, same as a local account).
 * Kept separate from `getDaemonAccount` so the "connect + list accounts" flow (before any account
 * has been added yet) can reuse the exact same cached client. */
export async function getDaemonClient(connectionId: string, seed: Uint8Array): Promise<{ client: WalletDaemonClient; url: string }> {
  const { daemonConnections } = await getState();
  const config = daemonConnections.find((c) => c.id === connectionId);
  if (!config) throw new Error(`Unknown daemon connection: ${connectionId}`);

  const cached = daemonClientCache.get(connectionId);
  if (cached) return { client: cached, url: config.url };

  const apiKey = await decryptSecret(seed, config.encryptedApiKey);
  const client = await DaemonAccount.connectClient(config.url, apiKey);
  daemonClientCache.set(connectionId, client);
  return { client, url: config.url };
}

async function getDaemonAccount(seed: Uint8Array, connectionId: string, componentAddress: string): Promise<DaemonAccount> {
  const key = `${connectionId}:${componentAddress}`;
  const cached = daemonAccountCache.get(key);
  if (cached) return cached;

  const { network } = await getState();
  const { client, url } = await getDaemonClient(connectionId, seed);
  const account = await DaemonAccount.connectAccount(client, url, network, componentAddress);
  daemonAccountCache.set(key, account);
  return account;
}

export function clearAccountCache(): void {
  localCache.clear();
  daemonClientCache.clear();
  daemonAccountCache.clear();
}
