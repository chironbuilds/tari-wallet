// Runs in the PAGE's own JS world (manifest.json declares this content script with
// `"world": "MAIN"`), so `window` here is the actual page window — this is what defines
// `window.tari` for dApps to call, MetaMask-`window.ethereum`-style.
//
// It never touches key material directly; every call is relayed via window.postMessage to the
// content script (isolated world) which forwards it to the background service worker.
import type { ProviderMethod } from "../lib/messages";

const PAGE_TARGET = "tari-wallet-page";
const CONTENT_TARGET = "tari-wallet-content";

type PendingResolvers = Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
const pending: PendingResolvers = new Map();

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function request(method: ProviderMethod, params?: unknown): Promise<unknown> {
  const id = randomId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ target: CONTENT_TARGET, type: "tari-request", id, method, params }, "*");
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.target !== PAGE_TARGET || data.type !== "tari-response") return;
  const entry = pending.get(data.id);
  if (!entry) return;
  pending.delete(data.id);
  if (data.error) entry.reject(new Error(data.error));
  else entry.resolve(data.result);
});

export interface TariProvider {
  isTariWallet: true;
  request(args: { method: ProviderMethod; params?: unknown }): Promise<unknown>;
}

const provider: TariProvider = {
  isTariWallet: true,
  request: ({ method, params }) => request(method, params),
};

(window as unknown as { tari: TariProvider }).tari = provider;
window.dispatchEvent(new Event("tari#initialized"));
