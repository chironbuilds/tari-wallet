// Thin wrapper around chrome.storage.local for everything the wallet persists between browser
// restarts. The encrypted vault blob and every daemon connection's API key are the sensitive
// pieces here — see vault.ts and secretAtRest.ts respectively for how each is protected;
// everything else in this file is plain metadata.
import type { EncryptedVault } from "./vault";
import type { EncryptedSecret } from "./secretAtRest";
import { DEFAULT_AUTO_LOCK_MINUTES } from "./autoLock";

export interface ConnectedSite {
  origin: string;
  /** Stable account id this site is bound to — see `localAccountId`/`daemonAccountId`. */
  accountId: string;
  connectedAt: number;
}

/**
 * A daemon this extension has connected to as a JRPC client — the "hardware wallet" analog of a
 * seed. Authenticated with a long-lived **API key** the user mints from the daemon's own web UI
 * (which has a real browser session there), not a session token this extension logs into itself —
 * confirmed with the tari-ootle maintainers that a `chrome-extension://` origin can't hold a
 * daemon browser session at all (session refresh needs an HttpOnly cookie this origin never gets;
 * WebAuthn's RP origin is locked to `http://localhost:{port}` regardless). See `DaemonAccount`.
 *
 * `encryptedApiKey` (not a plain `apiKey: string`) -- this key carries the daemon's `admin`
 * permission (see README "Daemon-relayed accounts"), the same severity of credential as the
 * wallet seed itself, so it gets the same "unreadable without the unlocked wallet" protection
 * via secretAtRest.ts rather than sitting in chrome.storage.local as plain text.
 */
export interface DaemonConnectionConfig {
  id: string;
  url: string;
  encryptedApiKey: EncryptedSecret;
  label: string;
}

/** One account on a connected daemon that the user has added to this wallet's account list. */
export interface DaemonAccountRef {
  connectionId: string;
  componentAddress: string;
  label: string;
}

export interface WalletState {
  vault: EncryptedVault | null;
  accountCount: number; // how many *local* (seed-derived) accounts have been derived/revealed
  /** Stable id of whichever account (local or daemon) is currently active — see
   * `localAccountId`/`daemonAccountId`/`parseAccountId`. */
  activeAccountId: string;
  network: "esmeralda" | "igor";
  connectedSites: ConnectedSite[];
  daemonConnections: DaemonConnectionConfig[];
  daemonAccounts: DaemonAccountRef[];
  /** Minutes of inactivity before the wallet auto-locks; 0 = never. See src/lib/autoLock.ts. */
  autoLockMinutes: number;
}

const DEFAULTS: WalletState = {
  vault: null,
  accountCount: 1,
  activeAccountId: "local:0",
  network: "esmeralda",
  connectedSites: [],
  daemonConnections: [],
  daemonAccounts: [],
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
};

export function localAccountId(index: number): string {
  return `local:${index}`;
}

export function daemonAccountId(connectionId: string, componentAddress: string): string {
  return `daemon:${connectionId}:${componentAddress}`;
}

export type AccountId = { type: "local"; index: number } | { type: "daemon"; connectionId: string; componentAddress: string };

export function parseAccountId(id: string): AccountId {
  if (id.startsWith("local:")) return { type: "local", index: Number(id.slice("local:".length)) };
  if (id.startsWith("daemon:")) {
    const rest = id.slice("daemon:".length);
    const sep = rest.indexOf(":");
    return { type: "daemon", connectionId: rest.slice(0, sep), componentAddress: rest.slice(sep + 1) };
  }
  throw new Error(`Malformed account id: ${id}`);
}

export async function getState(): Promise<WalletState> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored } as WalletState;
}

export async function setState(patch: Partial<WalletState>): Promise<void> {
  await chrome.storage.local.set(patch);
}

export async function hasWallet(): Promise<boolean> {
  const { vault } = await getState();
  return vault !== null;
}

export async function getConnectedSite(origin: string): Promise<ConnectedSite | undefined> {
  const { connectedSites } = await getState();
  return connectedSites.find((s) => s.origin === origin);
}

export async function addConnectedSite(origin: string, accountId: string): Promise<void> {
  const state = await getState();
  const withoutExisting = state.connectedSites.filter((s) => s.origin !== origin);
  await setState({
    connectedSites: [...withoutExisting, { origin, accountId, connectedAt: Date.now() }],
  });
}

export async function removeConnectedSite(origin: string): Promise<void> {
  const state = await getState();
  await setState({ connectedSites: state.connectedSites.filter((s) => s.origin !== origin) });
}

/** Disconnects every connected site. Each connection is pinned to the account id active at the
 * time it was made (see `addConnectedSite`), so switching accounts without this would leave sites
 * silently talking to the account the user just switched away from — clearing them forces every
 * site to reconnect via `tari_requestAccounts`, which then binds to the newly active account. */
export async function removeAllConnectedSites(): Promise<void> {
  await setState({ connectedSites: [] });
}

export async function addDaemonConnection(config: DaemonConnectionConfig): Promise<void> {
  const state = await getState();
  await setState({ daemonConnections: [...state.daemonConnections, config] });
}

export async function removeDaemonConnection(id: string): Promise<void> {
  const state = await getState();
  await setState({
    daemonConnections: state.daemonConnections.filter((c) => c.id !== id),
    daemonAccounts: state.daemonAccounts.filter((a) => a.connectionId !== id),
  });
}

export async function addDaemonAccount(ref: DaemonAccountRef): Promise<void> {
  const state = await getState();
  const withoutExisting = state.daemonAccounts.filter(
    (a) => !(a.connectionId === ref.connectionId && a.componentAddress === ref.componentAddress)
  );
  await setState({ daemonAccounts: [...withoutExisting, ref] });
}

export async function removeDaemonAccount(connectionId: string, componentAddress: string): Promise<void> {
  const state = await getState();
  await setState({
    daemonAccounts: state.daemonAccounts.filter((a) => !(a.connectionId === connectionId && a.componentAddress === componentAddress)),
  });
}

export async function wipeWallet(): Promise<void> {
  await chrome.storage.local.clear();
}
