// The handful of host capabilities the wallet core and popup UI need, abstracted so the same code
// runs as a Chrome MV3 extension (chrome.ts) and inside the Android app (mobile/platform.ts).
// Everything else -- keys, signing, the SDK, every RPC handler -- is host-independent.
import type { AccountsChangedBroadcast, NetworkChangedBroadcast, PopupRequest } from "../lib/messages";

/** The subset of `chrome.storage.StorageArea` the wallet uses. Values are structured (not strings). */
export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

export type WalletBroadcast = AccountsChangedBroadcast | NetworkChangedBroadcast;

export interface PopupResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

export type BiometricUnlockResult = "unlocked" | "cancelled" | "lockout" | "invalidated" | "unavailable";

/** Hardware-backed biometric unlock (Android only). */
export interface BiometricSupport {
  /** `available`: a strong biometric is enrolled on the device; `enabled`: the wallet has it on. */
  status(): Promise<{ available: boolean; enabled: boolean }>;
  /** Turns it on for the unlocked wallet (shows the biometric prompt). */
  enable(): Promise<void>;
  disable(): Promise<void>;
  /** Shows the biometric prompt and, on a match, unlocks the wallet. */
  unlock(): Promise<BiometricUnlockResult>;
}

export interface Platform {
  readonly kind: "extension" | "android";
  /** Persistent storage (survives restarts). */
  readonly local: StorageArea;
  /** Memory-only storage for the unlocked seed and other session secrets -- never written to disk. */
  readonly session: StorageArea;

  // --- background/core side ---
  /** Shows the approval UI for pending approval `id` (popup.html#/approve/<id>). */
  openApproval(id: string): Promise<void>;
  /** Hides the approval UI for `id` once it has been resolved. */
  closeApproval(id: string): void;
  /** Registers the callback the host calls when the user dismisses an approval without deciding. */
  onApprovalDismissed(handler: (id: string) => void): void;
  /** Called after connected sites were removed (disconnect, reset, network switch), so a host with
   * its own session layer (WalletConnect) can end sessions whose site is gone. */
  sitesChanged?(): void;
  /** Pushes an accounts/network change to every connected dApp. */
  broadcast(message: WalletBroadcast): Promise<void>;
  /** The running app/extension version. */
  appVersion(): string;
  /** Reloads the app to apply a downloaded update. */
  reload(): void;

  // --- popup/UI side ---
  /** Sends a popup request to the wallet core and returns its response envelope. */
  sendPopupRequest<T>(message: PopupRequest): Promise<PopupResponse<T>>;
  /** URL for a bundled static asset (e.g. "icons/icon48.png"). */
  assetUrl(path: string): string;
  /** Asks for network access to `originPattern` (e.g. "https://host:port/*"). */
  requestHostPermission(originPattern: string): Promise<boolean>;
  /** Keeps the core alive while an approval is showing (MV3 worker idle-kill); no-op elsewhere. */
  keepAliveWhileApproving(): void;
  /** Leaves the approval screen after a decision. */
  closeApprovalView(): void;
  /** Biometric unlock, where the host supports it. */
  readonly biometric?: BiometricSupport;
}
