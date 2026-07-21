// Thin wrapper around chrome.storage.local for everything the wallet persists between browser
// restarts. Only the encrypted vault blob is sensitive; everything else here is metadata.
import type { EncryptedVault } from "./vault";

export interface ConnectedSite {
  origin: string;
  accountIndex: number;
  connectedAt: number;
}

export interface WalletState {
  vault: EncryptedVault | null;
  accountCount: number; // how many accounts have been derived/revealed to the user
  activeAccountIndex: number;
  network: "esmeralda" | "igor";
  connectedSites: ConnectedSite[];
}

const DEFAULTS: WalletState = {
  vault: null,
  accountCount: 1,
  activeAccountIndex: 0,
  network: "esmeralda",
  connectedSites: [],
};

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

export async function addConnectedSite(origin: string, accountIndex: number): Promise<void> {
  const state = await getState();
  const withoutExisting = state.connectedSites.filter((s) => s.origin !== origin);
  await setState({
    connectedSites: [...withoutExisting, { origin, accountIndex, connectedAt: Date.now() }],
  });
}

export async function removeConnectedSite(origin: string): Promise<void> {
  const state = await getState();
  await setState({ connectedSites: state.connectedSites.filter((s) => s.origin !== origin) });
}

/** Disconnects every connected site. Each connection is pinned to the account index active at the
 * time it was made (see `addConnectedSite`), so switching accounts without this would leave sites
 * silently talking to the account the user just switched away from — clearing them forces every
 * site to reconnect via `tari_requestAccounts`, which then binds to the newly active account. */
export async function removeAllConnectedSites(): Promise<void> {
  await setState({ connectedSites: [] });
}

export async function wipeWallet(): Promise<void> {
  await chrome.storage.local.clear();
}
