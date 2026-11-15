import { isWcOrigin } from "./wcNamespace";

/** https:// anywhere, http:// only on a loopback host (local dApp development), or a WalletConnect
 * session origin (end-to-end encrypted over the relay; minted only by the Android bridge -- the
 * extension entry rejects a page claiming one). */
export function isSecureDappOrigin(origin: string): boolean {
  if (isWcOrigin(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}
