// Android app entry. Sets up the Capacitor host, starts the wallet core in this same WebView, then
// loads the existing popup UI on top of it.
import "./mobile.css";
import { App } from "@capacitor/app";
import { setPlatform } from "../platform";
import { createAndroidPlatform } from "./platform";
import { closePairingSheet, openPairingSheet } from "./pairUi";
import { installNav } from "./nav";
import { installEnhancements } from "./enhance";
import { initApprovalNotifications } from "./notifications";
import { queuedWcRequestCount, rejectQueuedWcRequests, startWalletConnect } from "./wc";
import { t } from "../lib/i18n";
import { checkAutoLock, handlePopupRequest, initCore, onHostStartup, sanitizeForMessage } from "../background/core";

const AUTO_LOCK_CHECK_MS = 60_000;

async function boot(): Promise<void> {
  document.documentElement.classList.add("mobile");

  const platform = await createAndroidPlatform({ handlePopupRequest, sanitize: sanitizeForMessage });
  setPlatform(platform);
  initCore();
  onHostStartup();

  // Timers are throttled or frozen while the app is in the background, so also check the moment
  // it comes back: an app left in the background past the auto-lock window is locked before any
  // screen renders.
  // Only a lock re-renders (to the unlock screen); otherwise the user's current screen -- possibly
  // a half-filled send form they left to copy an address -- is kept.
  const lockCheck = async () => {
    if ((await checkAutoLock()) && !platform.currentApproval()) window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  setInterval(() => void lockCheck(), AUTO_LOCK_CHECK_MS);
  App.addListener("resume", () => void lockCheck());

  // Hardware back, in order: close the pairing sheet; reject an approval on screen; go back one
  // screen (or to the Home tab); from Home, background the app -- never exit it, so a WalletConnect
  // session stays reachable.
  let navBack: () => boolean = () => false;
  App.addListener("backButton", () => {
    if (closePairingSheet()) return;
    if (platform.currentApproval()) {
      platform.dismissCurrentApproval();
      return;
    }
    if (navBack()) return;
    void App.minimizeApp();
  });

  // Approval screens get their own layout (buttons at the bottom); see mobile.css.
  const markApproving = () => document.documentElement.classList.toggle("approving", window.location.hash.startsWith("#/approve/"));
  window.addEventListener("hashchange", markApproving);
  markApproving();

  const popup = await import("../popup/main");
  navBack = installNav(popup.appNav, platform, openPairingSheet).back;
  installEnhancements({ receiveAddress: async () => (await popup.appNav.status()).receiveAddress });

  // "Request 1 of N" above an approval when more are waiting, with a Reject-all shortcut for a dApp
  // that floods requests. Refreshed when the queue changes or the screen re-renders.
  const syncCounter = () => {
    const app = document.getElementById("app");
    const existing = document.getElementById("approval-counter");
    const total = platform.approvalQueue().length + queuedWcRequestCount();
    if (!app || !window.location.hash.startsWith("#/approve/") || total < 2) {
      existing?.remove();
      return;
    }
    const label = t("queue.position", { current: "1", total: String(total) });
    if (existing && existing.parentElement === app) {
      existing.querySelector("span")!.textContent = label;
      return;
    }
    existing?.remove();
    const bar = document.createElement("div");
    bar.id = "approval-counter";
    bar.className = "approval-counter";
    const text = document.createElement("span");
    text.textContent = label;
    const rejectAll = document.createElement("button");
    rejectAll.type = "button";
    rejectAll.className = "link-btn";
    rejectAll.textContent = t("queue.rejectAll");
    rejectAll.addEventListener("click", () => {
      // Waiting WalletConnect requests first, so none is handed over (and shown) in between.
      void rejectQueuedWcRequests().then(() => platform.dismissAllApprovals());
    });
    bar.append(text, rejectAll);
    app.prepend(bar);
  };
  const appEl = document.getElementById("app");
  if (appEl) new MutationObserver(() => syncCounter()).observe(appEl, { childList: true });
  platform.onApprovalQueued(() => syncCounter());
  platform.onApprovalClosed(() => syncCounter());
  window.addEventListener("hashchange", syncCounter);
  // Requests WalletConnect is still holding raise no event of their own, so re-check while an
  // approval is on screen.
  setInterval(() => {
    if (window.location.hash.startsWith("#/approve/")) syncCounter();
  }, 1000);

  await initApprovalNotifications(platform);
  await startWalletConnect(platform);
}

boot().catch((e) => {
  const app = document.getElementById("app");
  if (app) app.textContent = `Sapient failed to start: ${e instanceof Error ? e.message : String(e)}`;
});
