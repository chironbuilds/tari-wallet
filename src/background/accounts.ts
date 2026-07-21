// NOTE: `../lib/wallet` is a static import deliberately, not a dynamic `import()`. It was briefly
// lazy-loaded to keep this module's own evaluation (and thus chrome.runtime.onMessage.addListener
// in background/index.ts, which must wait for every top-level static import to finish) fast on a
// service-worker cold start — but `import()` is flatly disallowed inside a ServiceWorkerGlobalScope
// (https://github.com/w3c/ServiceWorker/issues/1356; Chrome enforces this even for MV3 extension
// service workers), so that approach doesn't run at all. The cold-start race this was working
// around is instead absorbed by the retry-with-backoff in content-script.ts / popup/main.ts's
// `send()` helpers.
import { OotleAccount } from "../lib/wallet";
import { getState } from "../lib/storage";
import { getUnlockedSeed } from "./session";

// Cache OotleAccount instances (they hold a live IndexerProvider connection) per
// "network:index" so repeated calls within one unlocked session reuse the same connection.
const cache = new Map<string, OotleAccount>();

export async function getActiveAccount(): Promise<OotleAccount | null> {
  const seed = await getUnlockedSeed();
  if (!seed) return null;
  const { network, activeAccountIndex } = await getState();
  return getAccount(seed, network, activeAccountIndex);
}

export async function getAccountByIndex(index: number): Promise<OotleAccount | null> {
  const seed = await getUnlockedSeed();
  if (!seed) return null;
  const { network } = await getState();
  return getAccount(seed, network, index);
}

function getAccount(seed: Uint8Array, network: "esmeralda" | "igor", index: number): OotleAccount {
  const key = `${network}:${index}`;
  let account = cache.get(key);
  if (!account) {
    account = OotleAccount.fromSeed(seed, index, network);
    cache.set(key, account);
  }
  return account;
}

export function clearAccountCache(): void {
  cache.clear();
}
