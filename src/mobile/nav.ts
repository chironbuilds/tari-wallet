// Native-app chrome for the Android build, layered over the shared popup screens without changing
// them: a bottom tab bar (Home · Activity · Scan · dApps · Settings), a top app bar with a back
// arrow on sub-screens (lifted from each screen's own "Back" button and <h1>), directional screen
// transitions, pull-to-refresh on Home, and haptic feedback.
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import type { AndroidPlatform } from "./platform";
import { t } from "../lib/i18n";

export type Tab = "home" | "activity" | "dapps" | "settings";

export interface AppNav {
  status(): Promise<{ hasWallet: boolean; isUnlocked: boolean; backupPending?: boolean }>;
  home(): Promise<void>;
  activity(): Promise<void>;
  settings(): Promise<void>;
  dapps(): Promise<void>;
  receive(): Promise<void>;
  titles(): { activity: string; settings: string; dapps: string };
}

const ICONS: Record<Tab | "scan", string> = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/>',
  dapps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};

function svg(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/** A light tap; never let haptics failure (no vibrator, permission) affect the UI. */
export function tick(style: ImpactStyle = ImpactStyle.Light): void {
  void Haptics.impact({ style }).catch(() => {});
}

type Direction = "forward" | "back" | "tab";

/** The next re-render animates in this direction (see mobile.css). */
function setDirection(dir: Direction): void {
  const root = document.documentElement;
  root.classList.remove("nav-forward", "nav-back", "nav-tab");
  root.classList.add(`nav-${dir}`);
}

export function installNav(
  nav: AppNav,
  host: AndroidPlatform,
  openScanner: () => void
): { back(): boolean; refreshTabRoot(): void; openShortcut(url: string): boolean } {
  const app = document.getElementById("app")!;
  let activeTab: Tab = "home";

  // ---------------- top app bar ----------------
  const topBar = document.createElement("header");
  topBar.id = "app-bar";
  topBar.hidden = true;
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "app-bar-back";
  backBtn.setAttribute("aria-label", t("common.back"));
  backBtn.innerHTML = svg('<path d="M15 18l-6-6 6-6"/>');
  const title = document.createElement("div");
  title.className = "app-bar-title";
  topBar.append(backBtn, title);
  document.body.prepend(topBar);
  let screenBack: HTMLElement | null = null;
  backBtn.addEventListener("click", () => {
    tick();
    goBack();
  });

  // ---------------- bottom tab bar ----------------
  const tabBar = document.createElement("nav");
  tabBar.id = "tab-bar";
  tabBar.hidden = true;
  const tabs: { id: Tab | "scan"; label: string }[] = [
    { id: "home", label: t("tabs.home") },
    { id: "activity", label: t("tabs.activity") },
    { id: "scan", label: t("tabs.scan") },
    { id: "dapps", label: t("tabs.dapps") },
    { id: "settings", label: t("tabs.settings") },
  ];
  for (const tab of tabs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = tab.id === "scan" ? "tab tab-scan" : "tab";
    b.dataset.tab = tab.id;
    b.setAttribute("aria-label", tab.label);
    b.innerHTML = `<span class="tab-icon">${svg(ICONS[tab.id])}</span><span class="tab-label">${tab.label}</span>`;
    b.addEventListener("click", () => void selectTab(tab.id));
    tabBar.append(b);
  }
  document.body.append(tabBar);

  async function selectTab(id: Tab | "scan"): Promise<void> {
    tick(id === "scan" ? ImpactStyle.Medium : ImpactStyle.Light);
    if (id === "scan") {
      openScanner();
      return;
    }
    if (id === activeTab && id !== "home" && !screenBack) return;
    activeTab = id;
    setDirection("tab");
    paintTabs();
    await nav[id]();
  }

  function paintTabs(): void {
    for (const b of tabBar.querySelectorAll<HTMLButtonElement>(".tab")) {
      const on = b.dataset.tab === activeTab;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
  }

  // ---------------- per-render sync ----------------
  // The shared screens render into #app; after each render, lift their Back button and title into
  // the app bar, work out which tab the screen belongs to, and show or hide the chrome.
  let showChrome = false;
  async function refreshChromeVisibility(): Promise<void> {
    const onApproval = window.location.hash.startsWith("#/approve/");
    let ok = false;
    if (!onApproval) {
      try {
        const s = await nav.status();
        ok = s.hasWallet && s.isUnlocked && !s.backupPending;
      } catch {
        ok = false;
      }
    }
    showChrome = ok;
    apply();
    if (ok && pendingAction) {
      const run = pendingAction;
      pendingAction = null;
      run();
    }
  }

  /** Runs `action` now if the wallet is open, else right after the user unlocks (launcher shortcuts). */
  let pendingAction: (() => void) | null = null;
  function whenUnlocked(action: () => void): void {
    if (showChrome) action();
    else pendingAction = action;
  }

  function apply(): void {
    const onApproval = window.location.hash.startsWith("#/approve/");
    const visible = showChrome && !onApproval;
    tabBar.hidden = !visible;
    document.documentElement.classList.toggle("has-tabs", visible);

    // Lift Back + title into the app bar.
    screenBack = visible ? app.querySelector<HTMLElement>("#back") : null;
    const h1 = app.querySelector<HTMLElement>("h1");
    const titles = nav.titles();
    const tabRoot =
      h1?.textContent === titles.activity ? "activity" : h1?.textContent === titles.settings ? "settings" : h1?.textContent === titles.dapps ? "dapps" : null;
    if (visible && tabRoot) activeTab = tabRoot;
    else if (visible && !screenBack) activeTab = "home";
    paintTabs();

    const lifted = visible && !!h1 && (!!screenBack || !!tabRoot);
    topBar.hidden = !lifted;
    document.documentElement.classList.toggle("has-app-bar", lifted);
    if (lifted && h1) {
      title.textContent = h1.textContent;
      h1.classList.add("lifted");
      // A tab's own root screen has no back arrow (as in any native app); its hardware back goes Home.
      const showBack = !!screenBack && !tabRoot;
      backBtn.hidden = !showBack;
      if (screenBack) screenBack.classList.add("lifted");
    }
  }

  let pending = false;
  new MutationObserver(() => {
    apply();
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      void refreshChromeVisibility();
    });
  }).observe(app, { childList: true });
  window.addEventListener("hashchange", () => void refreshChromeVisibility());
  void refreshChromeVisibility();

  // ---------------- back ----------------
  function goBack(): boolean {
    if (screenBack && backBtn.hidden === false) {
      setDirection("back");
      screenBack.click();
      return true;
    }
    if (showChrome && activeTab !== "home") {
      activeTab = "home";
      setDirection("back");
      paintTabs();
      void nav.home();
      return true;
    }
    return false;
  }

  // Any other in-screen navigation (a list row, a primary action) animates forward.
  app.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest("button, [role=button], .list-row, .settings-row");
      if (!btn) return;
      if (btn.id === "back" || btn.classList.contains("app-bar-back")) setDirection("back");
      else setDirection("forward");
      if (btn.matches("#approve")) tick(ImpactStyle.Medium);
      else if (btn.matches("button.primary")) tick();
    },
    true
  );

  /** On a tab's own root screen (Home, Activity, dApps, Settings) -- not a sub-screen or approval. */
  function isTabRoot(): boolean {
    if (!showChrome || window.location.hash.startsWith("#/approve/")) return false;
    return topBar.hidden === true || backBtn.hidden === true;
  }

  // ---------------- pull to refresh (any tab root) ----------------
  const ptr = document.createElement("div");
  ptr.id = "ptr";
  ptr.innerHTML = '<div class="ptr-spinner"></div>';
  document.body.append(ptr);
  let startY: number | null = null;
  let pulled = 0;
  const THRESHOLD = 72;
  app.addEventListener(
    "touchstart",
    (e) => {
      startY = isTabRoot() && app.scrollTop <= 0 ? e.touches[0]!.clientY : null;
      pulled = 0;
    },
    { passive: true }
  );
  app.addEventListener(
    "touchmove",
    (e) => {
      if (startY === null) return;
      const dy = e.touches[0]!.clientY - startY;
      if (dy <= 0) {
        pulled = 0;
        ptr.style.transform = "";
        ptr.classList.remove("armed");
        return;
      }
      pulled = Math.min(120, dy * 0.5);
      ptr.style.transform = `translateY(${pulled}px) rotate(${pulled * 4}deg)`;
      ptr.style.opacity = String(Math.min(1, pulled / THRESHOLD));
      const armed = pulled >= THRESHOLD;
      if (armed && !ptr.classList.contains("armed")) tick();
      ptr.classList.toggle("armed", armed);
    },
    { passive: true }
  );
  app.addEventListener("touchend", () => {
    if (startY === null) return;
    startY = null;
    if (pulled >= THRESHOLD) {
      ptr.classList.add("spinning");
      ptr.style.transform = `translateY(${THRESHOLD}px)`;
      setDirection("tab");
      void nav[activeTab]().finally(() => {
        ptr.classList.remove("spinning", "armed");
        ptr.style.transform = "";
        ptr.style.opacity = "0";
      });
    } else {
      ptr.style.transform = "";
      ptr.style.opacity = "0";
      ptr.classList.remove("armed");
    }
    pulled = 0;
  });

  /** Re-renders the current tab root with fresh data (app resumed); leaves sub-screens and forms alone. */
  function refreshTabRoot(): void {
    if (!isTabRoot() || activeTab === "settings") return;
    setDirection("tab");
    void nav[activeTab]();
  }

  void host;
  /** Launcher shortcuts (sapient://scan, sapient://receive). */
  function openShortcut(url: string): boolean {
    let target: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "sapient:") return false;
      target = u.host || u.pathname.replace(/^\/+/, "");
    } catch {
      return false;
    }
    if (target === "scan") {
      whenUnlocked(() => openScanner());
      return true;
    }
    if (target === "receive") {
      whenUnlocked(() => {
        activeTab = "home";
        setDirection("forward");
        void nav.receive();
      });
      return true;
    }
    return false;
  }

  return { back: goBack, refreshTabRoot, openShortcut };
}
