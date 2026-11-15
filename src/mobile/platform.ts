// The Android (Capacitor) host. The wallet core and the popup UI run in the same WebView, so a
// "popup request" is a direct function call and an approval is an in-app screen, not a window.
import { Preferences } from "@capacitor/preferences";
import { memoryArea } from "../platform/memoryArea";
import { createBiometric } from "./biometric";
import type { Platform, PopupResponse, StorageArea, WalletBroadcast } from "../platform/types";
import type { PopupRequest } from "../lib/messages";

declare const __APP_VERSION__: string;

/** Persistent storage: an in-memory copy of everything, loaded once at startup, written through to
 * Capacitor Preferences (Android SharedPreferences, app-private) as JSON. Reads never touch disk. */
async function preferencesArea(): Promise<StorageArea> {
  const map = new Map<string, unknown>();
  const { keys } = await Preferences.keys();
  await Promise.all(
    keys.map(async (key) => {
      const { value } = await Preferences.get({ key });
      if (value === null) return;
      try {
        map.set(key, JSON.parse(value));
      } catch {
        // A corrupt entry is dropped rather than taking the whole wallet down at startup.
      }
    })
  );
  const mem = memoryArea(map);
  return {
    get: mem.get,
    async set(items) {
      await mem.set(items);
      await Promise.all(
        Object.entries(items)
          .filter(([, v]) => v !== undefined)
          .map(([key, v]) => Preferences.set({ key, value: JSON.stringify(v) }))
      );
    },
    async remove(keys) {
      await mem.remove(keys);
      await Promise.all((typeof keys === "string" ? [keys] : keys).map((key) => Preferences.remove({ key })));
    },
    async clear() {
      await mem.clear();
      await Preferences.clear();
    },
  };
}

export interface AndroidPlatform extends Platform {
  /** Subscribes to accounts/network changes (the WalletConnect bridge forwards them to sessions). */
  onBroadcast(listener: (message: WalletBroadcast) => void): () => void;
  /** Subscribes to "connected sites were removed" (the bridge ends sessions whose site is gone). */
  onSitesChanged(listener: () => void): () => void;
  /** The approval currently on screen, if any. */
  currentApproval(): string | null;
  /** The user backed out of the approval screen without deciding. */
  dismissCurrentApproval(): void;
  /** A dApp on this phone opened the app (deep link): hand back to it once the user has decided. */
  expectReturnToCaller(): void;
  /** True once, if a deep-linked caller is waiting and the user has finished every approval since. */
  takeReturnToCaller(): boolean;
}

export interface AndroidPlatformDeps {
  handlePopupRequest(message: PopupRequest): Promise<unknown>;
  sanitize(value: unknown): unknown;
}

export async function createAndroidPlatform(deps: AndroidPlatformDeps): Promise<AndroidPlatform> {
  const local = await preferencesArea();
  const session = memoryArea();
  const broadcastListeners = new Set<(message: WalletBroadcast) => void>();
  const sitesChangedListeners = new Set<() => void>();

  // Approvals are shown one at a time, oldest first. The UI follows location.hash (popup/main.ts
  // re-renders on hashchange on Android), so showing one is just navigating to it.
  const queue: string[] = [];
  let dismissed: ((id: string) => void) | null = null;
  // Deep-link return: armed by a link, satisfied once an approval completes, stale after 2 minutes
  // (a link the user then ignored must not minimize the app on some unrelated later approval).
  const RETURN_WINDOW_MS = 120_000;
  let returnArmedAt = 0;
  let approvalDoneSinceArmed = false;

  function showHead(): void {
    const head = queue[0];
    const target = head ? `#/approve/${head}` : "";
    if (window.location.hash !== target) window.location.hash = target;
  }

  return {
    kind: "android",
    local,
    session,

    async openApproval(id) {
      if (!queue.includes(id)) queue.push(id);
      showHead();
    },
    closeApproval(id) {
      const i = queue.indexOf(id);
      if (i >= 0) {
        queue.splice(i, 1);
        approvalDoneSinceArmed = true;
      }
      showHead();
    },
    onApprovalDismissed(handler) {
      dismissed = handler;
    },
    currentApproval: () => queue[0] ?? null,
    dismissCurrentApproval() {
      const id = queue.shift();
      if (id) {
        approvalDoneSinceArmed = true;
        dismissed?.(id);
      }
      showHead();
    },
    expectReturnToCaller() {
      returnArmedAt = Date.now();
      approvalDoneSinceArmed = false;
    },
    takeReturnToCaller() {
      const ready = returnArmedAt > 0 && Date.now() - returnArmedAt < RETURN_WINDOW_MS && approvalDoneSinceArmed && queue.length === 0;
      if (ready) returnArmedAt = 0;
      return ready;
    },

    async broadcast(message) {
      for (const listener of broadcastListeners) {
        try {
          listener(message);
        } catch {
          // One failing listener must not stop the others.
        }
      }
    },
    sitesChanged() {
      for (const listener of sitesChangedListeners) {
        try {
          listener();
        } catch {
          // One failing listener must not stop the others.
        }
      }
    },
    onSitesChanged(listener) {
      sitesChangedListeners.add(listener);
      return () => sitesChangedListeners.delete(listener);
    },
    onBroadcast(listener) {
      broadcastListeners.add(listener);
      return () => broadcastListeners.delete(listener);
    },

    appVersion: () => __APP_VERSION__,
    reload: () => window.location.reload(),

    async sendPopupRequest<T>(message: PopupRequest): Promise<PopupResponse<T>> {
      try {
        return { ok: true, result: deps.sanitize(await deps.handlePopupRequest(message)) as T };
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err) };
      }
    },
    assetUrl: (path) => `/${path}`,
    // The app has the INTERNET permission; there is no per-origin grant to ask for.
    requestHostPermission: async () => true,
    // The core lives in this WebView; nothing to keep awake.
    keepAliveWhileApproving() {},
    closeApprovalView: showHead,
    biometric: createBiometric(),
  };
}
