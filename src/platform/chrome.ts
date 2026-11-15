// The Chrome MV3 extension host. Every chrome.* lookup happens at call time, not at construction,
// so unit tests that stub the `chrome` global per test keep working.
import type { Platform, PopupResponse, StorageArea } from "./types";
import type { PopupRequest } from "../lib/messages";

function area(pick: () => chrome.storage.StorageArea): StorageArea {
  return {
    get: (keys) => pick().get(keys ?? null) as Promise<Record<string, unknown>>,
    set: (items) => pick().set(items),
    remove: (keys) => pick().remove(keys),
    clear: () => pick().clear(),
  };
}

// Approval id -> the popup window showing it. Lives in the service worker, like the pending map in
// approvals.ts; lost on a worker restart exactly as before.
const approvalWindows = new Map<string, number>();
let dismissedHandler: ((id: string) => void) | null = null;
let windowListenerInstalled = false;

function installWindowListener(): void {
  if (windowListenerInstalled) return;
  windowListenerInstalled = true;
  // If the user closes the approval window without clicking a button, treat it as a rejection.
  chrome.windows.onRemoved.addListener((windowId) => {
    for (const [id, wid] of approvalWindows) {
      if (wid !== windowId) continue;
      approvalWindows.delete(id);
      dismissedHandler?.(id);
    }
  });
}

async function openApprovalWindow(id: string): Promise<void> {
  installWindowListener();
  const url = chrome.runtime.getURL(`popup.html#/approve/${id}`);
  // Match the action popup's own body size (styles.css: 320x560). The height carries an extra ~40px
  // over the 560 body for the popup window's title bar (a type:"popup" window has one; the toolbar
  // action popup does not).
  const width = 320;
  const height = 600;
  // Anchor the window to the top-right of the active browser window -- where the toolbar icon and
  // the normal action popup appear -- instead of letting Chrome drop a type:"popup" window at an
  // arbitrary spot (on a multi-monitor setup, often nowhere near where the user clicked).
  let top: number | undefined;
  let left: number | undefined;
  try {
    const focused = await chrome.windows.getLastFocused();
    if (typeof focused.left === "number" && typeof focused.top === "number" && typeof focused.width === "number") {
      const margin = 16;
      // No clamp: a window on a secondary monitor can legitimately have negative or large
      // coordinates, and Chrome clips to the usable screen area on its own.
      left = Math.round(focused.left + focused.width - width - margin);
      top = Math.round(focused.top + margin);
    }
  } catch {
    // getLastFocused can reject (no open window, or it races one closing) -- fall back to Chrome's
    // default placement rather than failing the approval entirely.
  }
  let win: chrome.windows.Window | undefined;
  try {
    win = await chrome.windows.create({ url, type: "popup", width, height, top, left });
  } catch {
    // Chrome refuses bounds that aren't at least 50% on a visible screen ("Invalid value for
    // bounds") -- e.g. the focused browser window hangs partly off a monitor, or displays changed.
    // Without this retry the approval silently became an instant rejection with no prompt shown.
    win = await chrome.windows.create({ url, type: "popup", width, height });
  }
  if (win?.id !== undefined) approvalWindows.set(id, win.id);
}

async function broadcastToTabs(message: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    // Most tabs have no content script (chrome://, extension pages, other origins mid-navigation)
    // -- sendMessage rejects with "Receiving end does not exist" for those, which is expected.
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

function sendPopupRequest<T>(message: PopupRequest): Promise<PopupResponse<T>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: PopupResponse<T> | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response ?? { ok: false });
    });
  });
}

export function chromePlatform(): Platform {
  return {
    kind: "extension",
    local: area(() => chrome.storage.local),
    session: area(() => chrome.storage.session),
    openApproval: openApprovalWindow,
    closeApproval(id) {
      const windowId = approvalWindows.get(id);
      if (windowId === undefined) return;
      approvalWindows.delete(id);
      chrome.windows.remove(windowId).catch(() => {});
    },
    onApprovalDismissed(handler) {
      dismissedHandler = handler;
      // Registered here -- synchronously during the service worker's top-level startup (initCore) --
      // so MV3 keeps delivering the event after a worker restart.
      installWindowListener();
    },
    broadcast: broadcastToTabs,
    appVersion: () => chrome.runtime.getManifest().version,
    reload: () => chrome.runtime.reload(),
    sendPopupRequest,
    assetUrl: (path) => chrome.runtime.getURL(path),
    requestHostPermission: (originPattern) => chrome.permissions.request({ origins: [originPattern] }),
    keepAliveWhileApproving() {
      // An open port keeps the MV3 service worker classified as active; see background/index.ts.
      chrome.runtime.connect({ name: "approval-keepalive" });
    },
    closeApprovalView: () => window.close(),
  };
}
