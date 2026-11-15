// Android app entry. Sets up the Capacitor host, starts the wallet core in this same WebView, then
// loads the existing popup UI on top of it.
import "./mobile.css";
import { App } from "@capacitor/app";
import { SplashScreen } from "@capacitor/splash-screen";
import { setPlatform } from "../platform";
import { createAndroidPlatform } from "./platform";
import { cancelScan, closePairingSheet, openPairingSheet } from "./pairUi";
import { installNav } from "./nav";
import { installEnhancements } from "./enhance";
import { installConnectivityBar } from "./connectivity";
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
    if (cancelScan()) return;
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

  // Resolves when the shared UI has drawn its first real screen (unlock, welcome, home...).
  const appEl = document.getElementById("app")!;
  const firstRender = new Promise<void>((resolve) => {
    const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    new MutationObserver((_, obs) => {
      if (appEl.querySelector("h1, .hero, .top-nav, input")) {
        obs.disconnect();
        done();
      }
    }).observe(appEl, { childList: true, subtree: true });
    // Never leave the launch screen up if something unexpected renders first.
    setTimeout(resolve, 6000);
  });
  const popup = await import("../popup/main");
  const nav = installNav(popup.appNav, platform, openPairingSheet);
  navBack = nav.back;
  // Back in the app: fresh balances / activity on a tab root (never disturbs a form or approval).
  App.addListener("resume", () => setTimeout(() => nav.refreshTabRoot(), 400));
  void installConnectivityBar(() => nav.refreshTabRoot());
  // Launcher shortcuts (long-press the app icon): Scan to connect, Receive.
  App.addListener("appUrlOpen", ({ url }) => void nav.openShortcut(url));
  void App.getLaunchUrl().then((launch) => {
    if (launch?.url) nav.openShortcut(launch.url);
  });
  installEnhancements({ receiveAddress: async () => (await popup.appNav.status()).receiveAddress, connectDapp: openPairingSheet });

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
  new MutationObserver(() => syncCounter()).observe(appEl, { childList: true });
  platform.onApprovalQueued(() => syncCounter());
  platform.onApprovalClosed(() => syncCounter());
  window.addEventListener("hashchange", syncCounter);
  // Requests WalletConnect is still holding raise no event of their own, so re-check while an
  // approval is on screen.
  setInterval(() => {
    if (window.location.hash.startsWith("#/approve/")) syncCounter();
  }, 1000);

  // The first screen is up: drop the native launch screen, then start the background services
  // (notification channel, WalletConnect relay) without holding up the first paint.
  await firstRender;
  // Launch: the native splash (res/drawable/avd_sapient_splash.xml) pops in the icon and blinks
  // once; now it is removed (instantly -- see capacitor.config.ts) and the app rises gently into
  // place from the same dark background. Nothing has to line up, so nothing can jump or ghost.
  void SplashScreen.hide().catch(() => {});
  if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    await appEl
      .animate(
        [
          { transform: "translateY(14px)", opacity: 0 },
          { transform: "translateY(0)", opacity: 1 },
        ],
        { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" }
      )
      .finished.catch(() => {});
  }
  platform.markUiReady();
  await initApprovalNotifications(platform);
  await startWalletConnect(platform);
}

boot().catch((e) => {
  void SplashScreen.hide().catch(() => {});
  const app = document.getElementById("app");
  if (app) app.textContent = `Sapient failed to start: ${e instanceof Error ? e.message : String(e)}`;
});
