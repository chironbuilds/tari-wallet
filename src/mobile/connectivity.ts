// "You're offline" bar: a phone loses signal far more often than a desktop browser, and a request
// that silently hangs reads as a broken wallet. Shown under the app bar while there is no network;
// on reconnect it says so briefly and the caller refreshes the current tab.
import { Network } from "@capacitor/network";
import { t } from "../lib/i18n";

export async function installConnectivityBar(onReconnect: () => void): Promise<void> {
  const bar = document.createElement("div");
  bar.id = "net-bar";
  bar.setAttribute("role", "status");
  bar.hidden = true;
  document.body.append(bar);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const show = (connected: boolean, initial: boolean) => {
    clearTimeout(hideTimer);
    document.documentElement.classList.toggle("offline", !connected);
    if (!connected) {
      bar.className = "offline";
      bar.textContent = t("mobile.offline");
      bar.hidden = false;
      return;
    }
    if (initial) {
      bar.hidden = true;
      return;
    }
    bar.className = "online";
    bar.textContent = t("mobile.backOnline");
    bar.hidden = false;
    hideTimer = setTimeout(() => (bar.hidden = true), 2200);
    onReconnect();
  };

  try {
    show((await Network.getStatus()).connected, true);
  } catch {
    // Unknown: assume online.
  }
  let last: boolean | null = null;
  await Network.addListener("networkStatusChange", ({ connected }) => {
    if (connected === last) return;
    last = connected;
    show(connected, false);
  });
}
