// Android app entry. Sets up the Capacitor host, starts the wallet core in this same WebView, then
// loads the existing popup UI on top of it.
import "./mobile.css";
import { App } from "@capacitor/app";
import { setPlatform } from "../platform";
import { createAndroidPlatform } from "./platform";
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

  // Hardware back: on an approval screen it means "reject".
  let lastBackMs = 0;
  App.addListener("backButton", () => {
    if (platform.currentApproval()) {
      platform.dismissCurrentApproval();
      return;
    }
    // Screens aren't hash routes, so "back" re-renders the home screen; a second press within
    // 1.5 s backgrounds the app (never exits it, so a WalletConnect session stays reachable).
    const now = Date.now();
    if (now - lastBackMs < 1500) {
      void App.minimizeApp();
      return;
    }
    lastBackMs = now;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await import("../popup/main");
  const { startWalletConnect } = await import("./wc");
  await startWalletConnect(platform);
}

boot().catch((e) => {
  const app = document.getElementById("app");
  if (app) app.textContent = `Sapient failed to start: ${e instanceof Error ? e.message : String(e)}`;
});
