// Chrome MV3 service-worker entry: wires Chrome's events to the host-independent wallet core
// (core.ts). The Android app has its own entry (src/mobile/main.ts) over the same core.
import { platform } from "../platform";
import type { PageRequestMessage, PageResponseMessage, PopupRequest } from "../lib/messages";
import { classifyProviderError } from "../lib/messages";
import {
  checkAutoLock,
  handlePageRequest,
  handlePopupRequest,
  initCore,
  onHostStartup,
  sanitizeForMessage,
  setPendingUpdateVersion,
} from "./core";

void platform(); // the default (Chrome) platform
initCore();

// The approval popup opens one of these (named "approval-keepalive") for as long as it's showing
// a pending approval, purely so this service worker has an open port to hold it awake -- MV3 tears
// a worker down after ~30s with no activity, and a human actually reading a transaction summary
// before clicking Approve routinely takes longer than that. Losing the worker mid-approval doesn't
// just fail this one approval: the deprecated blocking RPCs (`tari_signAndSubmitTransaction` and
// friends, still what most dApps call through window.tari) have their entire suspended call --
// including the `sendResponse` closure the dApp is waiting on -- torn down with it, with no way to
// recover that specific promise (see `createAndWaitToSubmit`'s own comment). The dApp then hangs
// forever awaiting a response that will never come, which for a dApp that also gates "one
// transaction at a time" on that same promise (as tari-market does) locks out every later attempt
// too. Nothing needs to happen in this listener beyond accepting the connection; the open port
// itself is what keeps the worker classified as active.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "approval-keepalive") return;
  port.onDisconnect.addListener(() => {});
});

// Chrome downloads an available update in the background but won't swap it in while the extension
// is in active use (an open popup counts) -- it waits for a natural idle reload, which for a
// wallet extension a user might open daily without ever fully quitting Chrome could be a long
// wait. Persisting the version lets the popup surface "update available, reload to apply" instead
// of the update silently sitting downloaded-but-inert; see buildStatus()'s updateAvailable field
// and popup-reload-extension's handler for the other two ends of this.
chrome.runtime.onUpdateAvailable.addListener((details) => {
  void setPendingUpdateVersion(details.version);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.kind === "tari-page-request") {
    handleExtensionPageRequest(message as PageRequestMessage, sender)
      .then((result) =>
        sendResponse({ kind: "tari-page-response", id: message.id, result: sanitizeForMessage(result) } satisfies PageResponseMessage)
      )
      .catch((err) =>
        sendResponse({
          kind: "tari-page-response",
          id: message.id,
          error: classifyProviderError(String(err?.message ?? err)),
        } satisfies PageResponseMessage)
      );
    return true;
  }
  if (message && typeof message.kind === "string" && message.kind.startsWith("popup-")) {
    // Gate on origin, not `sender.tab`: the approval window (approvals.ts's
    // `chrome.windows.create({ type: "popup", url: "popup.html#/approve/..." })`) runs this same
    // popup.html/main.ts bundle, but -- unlike the toolbar popup -- it's a real window with a real
    // tab in it, so `sender.tab` is set for it too. Checking `sender.tab` alone would reject every
    // approval-flow message (connect/approve/reject, transaction approvals, ...), not just ones
    // from a content script. `sender.origin` is what actually distinguishes "one of this
    // extension's own pages" (chrome-extension://<this-id>/...) from a content script's sender,
    // whose origin is always the *page's* origin, never the extension's -- true for the toolbar
    // popup and the approval window alike. A page can never reach this branch at all regardless
    // (chrome.runtime isn't exposed to page scripts, and externally_connectable isn't declared --
    // see inject.ts's relay design); this mainly guards a future content-script bug forwarding a
    // page-supplied `kind` straight through, or a compromised content script reaching a
    // popup-only command directly.
    if (sender.origin !== chrome.runtime.getURL("").slice(0, -1)) {
      sendResponse({ ok: false, error: "Not permitted from this context." });
      return true;
    }
    handlePopupRequest(message as PopupRequest)
      .then((result) => sendResponse({ ok: true, result: sanitizeForMessage(result) }))
      .catch((err) => {
        // Deliberately not logging the error text: a failed popup request's error can embed the
        // user-entered daemon URL, which shouldn't leak into the extension console.
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      });
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Page (dApp) requests, relayed by the content script
// ---------------------------------------------------------------------------

function handleExtensionPageRequest(message: PageRequestMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Defense in depth on the origin every permission decision in core keys off. `origin` comes from
  // the content script's message (it set it from `window.location.origin`), but `sender.origin` is
  // the origin Chrome itself stamped on the sender -- unforgeable from page JS. In the intended
  // design they always agree: a page can't reach this listener at all (chrome.runtime isn't exposed
  // to page scripts and externally_connectable isn't declared -- see inject.ts's relay), only the
  // content script can, and it reports its own frame's origin honestly. Rejecting a mismatch closes
  // off a compromised or buggy content script claiming an origin that isn't its own to borrow
  // another site's connection, view-access grant, or signing authority. Only enforced when
  // `sender.origin` is a concrete string: a sandboxed/opaque-origin frame reports "null" on both
  // sides (still matches), and the rare undefined falls back to the message origin as before.
  if (typeof sender.origin === "string" && sender.origin !== message.origin) {
    return Promise.reject(new Error("Origin mismatch: the request's origin does not match its sender."));
  }
  // A WalletConnect session origin ("wc:...") is minted only by the Android bridge; a page claiming
  // one through the extension relay is lying.
  if (message.origin.startsWith("wc:")) {
    return Promise.reject(new Error("Invalid origin."));
  }
  return handlePageRequest(message);
}


// Reset in-memory caches whenever the browser (re)starts the service worker fresh -- session
// storage already handles the seed itself (it's cleared when the browser closes).
chrome.runtime.onStartup.addListener(() => {
  onHostStartup();
});

// Auto-lock: chrome.alarms (not setInterval/setTimeout) is what actually works here -- MV3 kills
// this service worker after ~30s of inactivity, and a plain timer dies with it, while an alarm
// persists and re-fires even across a worker restart.
const AUTO_LOCK_ALARM = "tari-auto-lock-check";

chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  void checkAutoLock();
});
