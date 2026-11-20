// Layouts for the shared wallet screens, used by both the Android app and the browser extension.
// The screens in src/popup/main.ts render their elements; after each render this re-composes some
// of them -- the Home header and balance, Claim L1 burn, grouped Settings, the token page, Activity
// by day, the recovery-phrase cover. It only moves and wraps existing elements (never re-creates
// them), so their event listeners keep working, and every step is idempotent: a screen already
// composed is left alone. Each host styles the result (src/mobile/mobile.css, src/popup/styles.css).
import { t } from "../lib/i18n";
import { avatarSvg } from "../lib/avatar";
import type { TransactionHistoryEntry } from "../lib/storage";
import { formatBalanceAmountGrouped, resourceLabel, shortAddr } from "../popup/format";
import { platform } from "../platform";

/** What the layouts read beyond the rendered screen. */
export interface RedesignDeps {
  /** Android has a tab bar and its own pairing flow; the extension has neither. */
  host: "android" | "extension";
  history(): Promise<TransactionHistoryEntry[]>;
  status(): Promise<{ address: string | null; receiveAddress: string | null; network: string; accounts: { id: string; label: string }[]; activeAccountId: string }>;
  /** Opens the account switcher (Settings' profile card). */
  openAccounts?(): void;
}
let deps: RedesignDeps;

const ICON = {
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  fingerprint:
    '<path d="M12 11v3a8 8 0 0 1-1.5 4.7"/><path d="M8.5 13a3.5 3.5 0 0 1 7 0c0 1.6-.2 3.1-.6 4.5"/><path d="M5.3 16.5A10 10 0 0 1 5 13a7 7 0 0 1 12.2-4.7"/><path d="M19 12.5c0 1.3-.1 2.6-.4 3.8"/><path d="M8.6 20.3c.6-.9 1-1.9 1.3-2.9"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  network: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>',
  language: '<path d="M4 5h9M8.5 3v2M6 5c.6 3.4 2.6 6 5.5 7.5M11 5c-.7 3.6-3 6.6-7 8"/><path d="M12 21l4.5-10 4.5 10M13.5 18h6"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  sendPrivate: '<path d="M12 15V4M7 9l5-5 5 5"/><rect x="7" y="15" width="10" height="6" rx="1.5"/>',
};

function iconSpan(paths: string, size = 20): HTMLElement {
  return el("span", "icon-svg", svg(paths, size));
}

function svg(paths: string, size = 20): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

// ---------------- Welcome ----------------
function composeWelcome(app: HTMLElement): void {
  const hero = app.querySelector<HTMLElement>(".welcome-hero");
  const create = app.querySelector<HTMLElement>("#create");
  const importBtn = app.querySelector<HTMLElement>("#import");
  if (!hero || !create || !importBtn || hero.dataset.composed) return;
  hero.dataset.composed = "1";
  document.documentElement.classList.add("screen-welcome");

  // The actions go to the bottom of the screen, within thumb reach.
  const actions = el("div", "welcome-actions");
  actions.append(create, importBtn);
  app.append(actions);
}

// ---------------- Home ----------------
function composeHome(app: HTMLElement): void {
  const nav = app.querySelector<HTMLElement>(".top-nav");
  const hero = app.querySelector<HTMLElement>(".account-summary");
  if (!nav || !hero || hero.dataset.composed) return;
  hero.dataset.composed = "1";
  document.documentElement.classList.add("screen-home");

  // Header: [avatar + account name ▾] ........ [● network]
  const pill = nav.querySelector<HTMLElement>(".account-pill");
  const network = nav.querySelector<HTMLElement>(".network-line");
  const avatar = hero.querySelector<HTMLElement>(".summary-head .avatar");
  const header = el("div", "home-header");
  if (pill) {
    if (avatar) pill.prepend(avatar);
    header.append(pill);
  }
  // The extension reaches Settings from here (Android has a Settings tab and hides this button).
  const settings = nav.querySelector<HTMLElement>("#settingsBtn");
  const right = el("div", "home-header-right");
  if (network) right.append(network);
  if (settings) right.append(settings);
  header.append(right);
  nav.before(header);

  // Hero: label, amount, private pill, address chip.
  const balance = hero.querySelector<HTMLElement>(".summary-balance");
  const addr = hero.querySelector<HTMLElement>(".addr-pill");
  if (balance && addr) balance.append(addr);

  // The figure needs no "Public Balance" title above it; the title stays for screen readers, on the
  // figure itself. The hide-amounts eye moves to the header, first in its right-hand group.
  const label = hero.querySelector<HTMLElement>(".summary-label");
  if (label) {
    label.hidden = true;
    hero.querySelector(".hero-balance")?.setAttribute("aria-label", label.textContent ?? "");
    const eye = el("button", "amount-eye", svg(ICON.eye, 18));
    eye.type = "button";
    eye.setAttribute("aria-label", t("mobile.hideAmounts"));
    eye.setAttribute("aria-pressed", String(amountsHidden()));
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      setAmountsHidden(!amountsHidden());
      eye.setAttribute("aria-pressed", String(amountsHidden()));
    });
    right.prepend(eye);
  }

  // Public / private split: a bar and a legend, once there is private value to compare against.
  if (balance) {
    const split = el("div", "balance-split");
    split.hidden = true;
    split.innerHTML =
      '<div class="split-bar"><i class="split-pub"></i><i class="split-priv"></i></div>' +
      '<div class="split-legend"><span class="sl-pub"><b></b><em></em></span><span class="sl-priv"><b></b><em></em></span></div>';
    split.querySelector(".sl-pub b")!.textContent = t("mobile.publicLabel");
    split.querySelector(".sl-priv b")!.textContent = t("mobile.privateLabel");
    const amountEl = hero.querySelector<HTMLElement>(".hero-balance-amount");
    balance.insertBefore(split, addr ?? null);
    const num = (v: string | null | undefined) => Number((v ?? "").replace(/[^0-9.]/g, "")) || 0;
    const update = () => {
      if (amountEl) splitDecimals(amountEl);
      // The headline is the total; Home publishes the public and private parts on the card itself.
      const pubText = hero.dataset.public ?? "";
      const privText = hero.dataset.private ?? "";
      const pub = num(pubText);
      const priv = num(privText);
      const total = pub + priv;
      split.hidden = !(priv > 0 && total > 0);
      hero.classList.toggle("has-split", !split.hidden);
      if (split.hidden) return;
      const p = Math.max(4, Math.min(96, (pub / total) * 100));
      split.querySelector<HTMLElement>(".split-pub")!.style.width = `${p}%`;
      split.querySelector<HTMLElement>(".split-priv")!.style.width = `${100 - p}%`;
      split.querySelector(".sl-pub em")!.textContent = twoDecimals(pubText);
      split.querySelector(".sl-priv em")!.textContent = twoDecimals(privText);
    };
    // The figure and the two data attributes, never the hero's class or style: update() writes those.
    const watch = new MutationObserver(update);
    if (amountEl) watch.observe(amountEl, { subtree: true, childList: true, characterData: true });
    watch.observe(hero, { attributes: true, attributeFilter: ["data-public", "data-private"] });
    update();
  }

  // Actions: four tiles; Claim L1 burn becomes a card of its own under them.
  const burn = app.querySelector<HTMLElement>("#burnAction");
  const row = app.querySelector<HTMLElement>(".action-row");
  if (burn && row) {
    const card = el(
      "button",
      "l1-card",
      `<span class="l1-icon">${svg(ICON.layers, 20)}</span><span class="l1-text"><b></b><span></span></span><span class="l1-go">${svg(ICON.chevron, 18)}</span>`
    );
    card.type = "button";
    card.querySelector("b")!.textContent = t("mobile.l1Title");
    card.querySelector(".l1-text span")!.textContent = t("mobile.l1Body");
    card.addEventListener("click", () => burn.click());
    row.after(card);
  }

  addPrivacyGuide(app);
  const assets = app.querySelector<HTMLElement>(".balances-card");
  if (assets) {
    const watch = () => {
      enhanceEmptyAssets(app, assets);
      shortenAssetAmounts(assets);
    };
    new MutationObserver(watch).observe(assets, { childList: true });
    watch();
  }
  void addRecentActivity(app);
}

// ---------------- First-run privacy guide ----------------
const GUIDE_KEY = "sapient:privacy-guide-done";
function addPrivacyGuide(app: HTMLElement): void {
  try {
    if (localStorage.getItem(GUIDE_KEY) === "1") return;
  } catch {
    return; // nowhere to remember the dismissal: don't nag on every open
  }
  const after = app.querySelector<HTMLElement>(".l1-card") ?? app.querySelector<HTMLElement>(".action-row");
  if (!after || app.querySelector(".privacy-guide")) return;
  const card = el("div", "privacy-guide");
  const title = el("div", "pg-title");
  title.textContent = t("mobile.guideTitle");
  const list = el("ul", "pg-steps");
  for (const text of [t("mobile.guidePublic"), t("mobile.guideShield"), t("mobile.guidePrivate")]) {
    const li = el("li", "");
    li.textContent = text;
    list.append(li);
  }
  const done = el("button", "pg-done");
  done.type = "button";
  done.textContent = t("mobile.guideDismiss");
  done.addEventListener("click", () => {
    try {
      localStorage.setItem(GUIDE_KEY, "1");
    } catch {
      /* ignore */
    }
    collapseAway(card);
  });
  card.append(title, list, done);
  after.after(card);
}

/**
 * Removes an element without the content below it jumping: fade it, then animate its height --
 * and the flex gap it leaves behind -- to zero, and only then take it out of the DOM.
 */
function collapseAway(node: HTMLElement): void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    node.remove();
    return;
  }
  const gap = parseFloat(getComputedStyle(node.parentElement!).rowGap) || 0;
  node.style.height = `${node.offsetHeight}px`;
  node.style.overflow = "hidden";
  node.style.transition = "opacity 140ms ease-out, height 240ms cubic-bezier(0.2, 0.8, 0.2, 1) 100ms, margin-bottom 240ms cubic-bezier(0.2, 0.8, 0.2, 1) 100ms, padding 240ms cubic-bezier(0.2, 0.8, 0.2, 1) 100ms";
  void node.offsetHeight; // commit the starting height before animating from it
  node.style.opacity = "0";
  node.style.height = "0px";
  node.style.paddingTop = "0px";
  node.style.paddingBottom = "0px";
  node.style.marginBottom = `${-gap}px`;
  node.style.borderWidth = "0px";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    node.remove();
  };
  node.addEventListener("transitionend", (e) => {
    if (e.propertyName === "height") finish();
  });
  setTimeout(finish, 500); // in case transitionend never fires
}

// ---------------- Empty wallet ----------------
// A new wallet's asset list is a dead end ("No tokens yet"); make it the first step instead.
function enhanceEmptyAssets(app: HTMLElement, assets: HTMLElement): void {
  const empty = assets.querySelector<HTMLElement>(".empty-state");
  if (!empty || empty.dataset.composed) return;
  empty.dataset.composed = "1";
  assets.classList.add("assets-empty");
  const title = el("div", "ea-title");
  title.textContent = t("mobile.emptyTitle");
  const body = el("div", "ea-body");
  body.textContent = t("mobile.emptyBody");
  const receive = el("button", "primary ea-receive");
  receive.type = "button";
  receive.textContent = t("mobile.receiveTari");
  receive.addEventListener("click", () => app.querySelector<HTMLElement>("#receiveAction")?.click());
  empty.replaceChildren(title, body, receive);
}

const HISTORY_ICON: Record<string, string> = {
  send: ICON.up,
  "send-privately": ICON.lock,
  shield: ICON.lock,
  unshield: ICON.unlock,
  received: ICON.arrowDown,
  claim: ICON.arrowDown,
  "private-payment-received": ICON.unlock,
  "burn-claim": ICON.arrowDown,
  "dapp-transaction": ICON.ext,
};
const KIND_KEY: Record<string, Parameters<typeof t>[0]> = {
  send: "history.kindSend",
  shield: "history.kindShield",
  unshield: "history.kindUnshield",
  "send-privately": "history.kindSendPrivately",
  claim: "history.kindClaim",
  "private-payment-received": "history.kindPrivatePaymentReceived",
  received: "history.kindReceived",
  "burn-claim": "history.kindBurnClaim",
  "dapp-transaction": "history.kindDappTransaction",
};

/** "Recent activity" on Home: the last three entries, tapping through to the Activity tab. */
async function addRecentActivity(app: HTMLElement): Promise<void> {
  let entries: TransactionHistoryEntry[];
  try {
    entries = await deps.history();
  } catch {
    return;
  }
  // Home may have been left (or re-rendered) while this loaded.
  const anchor = app.querySelector<HTMLElement>(".balances-card");
  if (!anchor || app.querySelector(".recent-card") || !entries.length) return;
  entries.sort((a, b) => b.createdAt - a.createdAt);
  const head = el("div", "recent-head");
  const title = el("div", "section-title");
  title.textContent = t("mobile.recentActivity");
  const all = el("button", "see-all");
  all.type = "button";
  all.textContent = t("mobile.seeAll");
  head.append(title, all);
  const card = el("div", "card recent-card history-list");
  for (const e of entries.slice(0, 3)) card.append(activityRow(e));
  all.addEventListener("click", openActivity);
  anchor.after(head, card);
}

/** One activity entry as a compact row (Home's recent activity, a token's own activity). */
function activityRow(e: TransactionHistoryEntry): HTMLElement {
  {
    const row = el("button", "balance-row recent-row");
    row.type = "button";
    const kind = e.kind;
    row.classList.add(INCOMING.has(kind) ? "hk-in" : OUTGOING.has(kind) ? "hk-out" : kind.includes("shield") ? "hk-private" : "hk-other");
    if (e.status === "failed") row.classList.add("status-failed");
    const ic = el("div", "history-icon", svg(HISTORY_ICON[kind] ?? ICON.ext, 18));
    const info = el("div", "list-row-info");
    const name = el("div", "");
    name.textContent = t(KIND_KEY[kind] ?? "history.kindDappTransaction") + (e.status === "failed" ? t("history.failedSuffix") : "");
    const when = el("div", "muted");
    when.textContent = e.createdAt > 0 ? relativeDay(e.createdAt) : t("history.earlier");
    info.append(name, when);
    row.append(ic, info);
    if (e.amount && e.resourceAddress) {
      const right = el("div", "history-right");
      const amt = el("span", "history-amount");
      const sign = INCOMING.has(kind) ? "+" : OUTGOING.has(kind) ? "−" : "";
      const exact = formatBalanceAmountGrouped(e.amount, e.divisibility ?? 6);
      const unit = resourceLabel(e.resourceAddress, e.symbol ?? null);
      // A token without decimals (an NFT count) stays a whole number.
      amt.textContent = `${sign}${e.divisibility === 0 ? exact : twoDecimals(exact)} ${unit}`;
      amt.title = `${exact} ${unit}`;
      right.append(amt);
      row.append(right);
    }
    row.addEventListener("click", openActivity);
    return row;
  }
}

/** The Activity tab on Android; Home's own History button in the extension. */
function openActivity(): void {
  const target =
    document.querySelector<HTMLElement>('#tab-bar [data-tab="activity"]') ?? document.querySelector<HTMLElement>("#historyAction");
  target?.click();
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday", or a short date: the heading for a day of activity. */
function dayLabel(ts: number): string {
  const now = new Date();
  if (dayKey(ts) === dayKey(now.getTime())) return t("mobile.today");
  if (dayKey(ts) === dayKey(now.getTime() - 86_400_000)) return t("mobile.yesterday");
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Today, 12:21 AM" / "Yesterday, 9:05 PM" / "Nov 3, 4:40 PM" */
function relativeDay(ts: number): string {
  return `${dayLabel(ts)}, ${timeOf(ts)}`;
}

/** "2.475105" -> "2" + ".475105" in a smaller, dimmer span, as finance apps set a balance. Leaves
 * anything without a decimal part alone, and is a no-op once split (it is re-run on every change
 * the shared code makes to the figure). */
function splitDecimals(target: HTMLElement): void {
  if (target.querySelector(".frac")) return;
  const text = target.textContent ?? "";
  // Home shows two decimals; the exact figure stays available on hover.
  if (target.classList.contains("hero-balance-amount")) {
    const short = twoDecimals(text);
    if (short !== text) {
      target.title = text;
      if (!short.includes(".")) {
        target.textContent = short; // "< 0.01"
        return;
      }
      return splitDecimals(Object.assign(target, { textContent: short }));
    }
  }
  const dot = text.indexOf(".");
  if (dot <= 0 || !/^[\d,]+\.\d+$/.test(text.trim())) return;
  const whole = el("span", "whole");
  whole.textContent = text.slice(0, dot);
  const frac = el("span", "frac");
  frac.textContent = text.slice(dot);
  target.replaceChildren(whole, frac);
}

/**
 * A balance as Home shows it: two decimals, cut rather than rounded so it never shows more than is
 * held. "2,459.624" -> "2,459.62", "0.5" -> "0.50", "7" -> "7.00"; a positive amount under 0.01 is
 * "< 0.01" rather than a misleading "0.00". Anything that isn't a plain number is returned as is.
 */
export function twoDecimals(text: string): string {
  const m = text.trim().match(/^([\d,]+)(?:\.(\d+))?$/);
  if (!m) return text;
  const whole = m[1]!;
  const dec = m[2] ?? "";
  const cut = `${dec}00`.slice(0, 2);
  if (whole.replace(/,/g, "") === "0" && cut === "00" && /[1-9]/.test(dec)) return "< 0.01";
  return `${whole}.${cut}`;
}

/** The first number inside a label ("0.5 TARI private", "+0.5 private") at two decimals. */
function shortenFirstNumber(node: HTMLElement): void {
  const text = node.textContent ?? "";
  const next = text.replace(/[\d,]+(?:\.\d+)?/, (n) => twoDecimals(n));
  if (next === text) return;
  node.title = text;
  node.textContent = next;
}

/** Home's asset list at two decimals (counts like "3 NFTs" are left alone). */
function shortenAssetAmounts(assets: HTMLElement): void {
  for (const a of assets.querySelectorAll<HTMLElement>(".token-amount")) {
    const text = a.textContent ?? "";
    const short = twoDecimals(text);
    if (short !== text) {
      a.title = text;
      a.textContent = short;
    }
  }
  for (const p of assets.querySelectorAll<HTMLElement>(".token-amount-private")) shortenFirstNumber(p);
}

// ---------------- Recovery phrase ----------------
// Wherever the 24 words appear (backing up a new wallet, Reveal recovery phrase): a plain warning,
// and the words covered until tapped, so they are never on screen by accident.
function composeSecret(app: HTMLElement): void {
  const grid = app.querySelector<HTMLElement>(".mnemonic-grid");
  if (grid && !grid.dataset.composed) {
    grid.dataset.composed = "1";
    const wrap = el("div", "secret");
    grid.before(wrap);
    wrap.append(grid);
    const cover = el("button", "secret-cover");
    cover.type = "button";
    cover.textContent = t("mobile.tapToReveal");
    cover.addEventListener("click", () => {
      wrap.classList.add("revealed");
      cover.remove();
    });
    wrap.append(cover);
    addSecretWarning(app, wrap);
  }
  // The password step of Reveal recovery phrase.
  if (app.querySelector("#reveal") && app.querySelector("#pw")) {
    const anchor = app.querySelector<HTMLElement>("#app > label");
    if (anchor) addSecretWarning(app, anchor);
  }
}

function addSecretWarning(app: HTMLElement, before: HTMLElement): void {
  if (app.querySelector(".secret-warning")) return;
  const note = el("div", "secret-warning");
  note.textContent = t("mobile.secretWarning");
  before.before(note);
}

// ---------------- dApps, when none are connected ----------------
function composeDappsEmpty(app: HTMLElement): void {
  // The steps describe pairing Sapient for Android; the extension connects from the dApp's page.
  if (deps.host !== "android" || app.querySelector("h1")?.textContent !== t("connectedSites.title")) return;
  const empty = app.querySelector<HTMLElement>(".empty-state");
  if (!empty || empty.dataset.composed) return;
  empty.dataset.composed = "1";
  const steps = el("ol", "howto");
  for (const text of [t("mobile.dappsStep1"), t("mobile.dappsStep2"), t("mobile.dappsStep3")]) {
    const li = el("li", "");
    li.textContent = text;
    steps.append(li);
  }
  empty.replaceChildren(steps);
  empty.classList.add("dapps-empty");
}

// ---------------- Page bar (extension) ----------------
// Sub-screens render a title and a full-width "← Back" button. In the extension that becomes a
// page bar: a back chevron beside the title. (Android lifts both into its own app bar instead.)
function composePageBar(app: HTMLElement): void {
  if (deps.host !== "extension" || app.querySelector(".page-bar, .page-header")) return;
  const back = app.querySelector<HTMLButtonElement>("#back");
  const h1 = app.querySelector<HTMLElement>(":scope > h1");
  if (!back || !h1 || back.classList.contains("primary")) return;
  const label = back.textContent?.trim() ?? "";
  back.setAttribute("aria-label", label.replace(/^[←\s]+/, "") || "Back");
  back.title = back.getAttribute("aria-label") ?? "";
  back.className = "page-bar-back";
  back.innerHTML = svg('<path d="M15 18l-6-6 6-6"/>', 18);
  const bar = el("div", "page-bar");
  h1.before(bar);
  bar.append(back, h1);
}

// ---------------- Claim L1 burn ----------------
// The shared screen is one card: a paragraph, the claim key, a textarea and a bare file input.
// On the phone: two numbered steps (burn to this key; add the proof), a real file button, Claim
// burn as the primary action, and the explanation as a note under it.
function composeClaimBurn(app: HTMLElement): void {
  if (app.querySelector("h1")?.textContent !== t("claimBurn.title")) return;
  const card = app.querySelector<HTMLElement>(".card");
  const file = card?.querySelector<HTMLInputElement>('input[type="file"]');
  const proof = card?.querySelector<HTMLTextAreaElement>("textarea");
  const keyRow = card?.querySelector<HTMLElement>(".copy-row");
  const claim = card?.querySelector<HTMLButtonElement>("button.secondary:not(.icon-btn)");
  const desc = card?.querySelector<HTMLElement>("p.muted");
  const status = card?.querySelector<HTMLElement>(".status");
  if (!card || !file || !proof || !keyRow || !claim || card.dataset.composed) return;
  card.dataset.composed = "1";

  const step = (n: number, title: string, body: string, ...content: HTMLElement[]) => {
    const s = el("section", "burn-step");
    const head = el("div", "burn-step-head");
    const num = el("span", "burn-step-num");
    num.textContent = String(n);
    const text = el("div", "");
    const h = el("div", "burn-step-title");
    h.textContent = title;
    const p = el("div", "burn-step-body");
    p.textContent = body;
    text.append(h, p);
    head.append(num, text);
    s.append(head, ...content);
    return s;
  };

  // A real button for the file picker; the native input stays (hidden) and does the work.
  const pick = el("button", "secondary burn-file");
  pick.type = "button";
  pick.textContent = t("mobile.burnChooseFile");
  file.hidden = true;
  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const name = file.files?.[0]?.name;
    pick.textContent = name ? name : t("mobile.burnChooseFile");
    pick.classList.toggle("chosen", !!name);
  });
  proof.rows = 3;

  claim.classList.remove("secondary");
  claim.classList.add("primary", "burn-claim");

  const steps = [
    step(1, t("mobile.burnStep1Title"), t("mobile.burnStep1Body"), keyRow),
    step(2, t("mobile.burnStep2Title"), t("mobile.burnStep2Body"), proof, pick, file),
  ];
  card.replaceChildren(...steps);
  card.classList.add("burn-card");
  card.after(...[status, claim].filter((x): x is HTMLElement => !!x));
  if (desc) {
    desc.removeAttribute("style");
    desc.classList.add("burn-note");
    claim.after(desc);
  }
}

// ---------------- Approval hero ----------------
// Who is asking, first: the dApp's monogram (coloured from its name, so one site always looks the
// same) above the trust card. Never an icon fetched from the site -- that is the dApp's own claim.
function composeApprovalHero(app: HTMLElement): void {
  const card = app.querySelector<HTMLElement>(".site-card");
  if (!card || app.querySelector(".dapp-hero")) return;
  const name = card.querySelector(".site-card-name")?.textContent?.trim() ?? "";
  const letter = (name.replace(/^[^\p{L}\p{N}]+/u, "")[0] ?? "?").toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const hero = el("div", "dapp-hero");
  const mono = el("div", "dapp-mono");
  mono.textContent = letter;
  mono.style.background = `hsl(${hue} 42% 38%)`;
  const link = el("div", "dapp-link", `<i></i><i></i><i></i>`);
  const me = el("div", "dapp-mono dapp-me", '<img src="icons/icon48.png" alt="">');
  hero.append(mono, link, me);
  const h1 = app.querySelector("h1");
  (h1 ?? card).before(hero);
}

// ---------------- Brand lockup ----------------
// Logo + wordmark atop the screens a person sees before the wallet opens (unlock, create, import).
function composeLockup(app: HTMLElement): void {
  if (app.querySelector(".welcome-hero, .brand-lockup")) return;
  // The unlock screen (#unlock) and create/import (#pw2); not in-app password prompts.
  if (!app.querySelector("#unlock, #pw2")) return;
  const lockup = el("div", "brand-lockup");
  lockup.innerHTML = '<img src="icons/icon48.png" width="28" height="28" alt=""><span>Sapient</span><small class="brand-by"></small>';
  lockup.querySelector(".brand-by")!.textContent = t("common.byErebus");
  app.prepend(lockup);
}

// ---------------- Hidden amounts ----------------
const HIDE_KEY = "sapient:hide-amounts";
function amountsHidden(): boolean {
  return document.documentElement.classList.contains("hide-amounts");
}
function setAmountsHidden(on: boolean): void {
  document.documentElement.classList.toggle("hide-amounts", on);
  try {
    localStorage.setItem(HIDE_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable: just not remembered */
  }
}

// ---------------- Settings ----------------
function composeSettings(app: HTMLElement): void {
  const card = app.querySelector<HTMLElement>(".settings-card");
  if (!card || card.dataset.composed || !app.querySelector("#addAccount")) return;
  card.dataset.composed = "1";
  const byId = (id: string) => app.querySelector<HTMLElement>(`#${id}`);
  const rowOf = (id: string) => byId(id)?.closest<HTMLElement>(".settings-row") ?? null;
  const autoLock = rowOf("autoLock");
  // The biometric row has no id; it is rendered right before Auto-lock and filled in later.
  const biometric = autoLock?.previousElementSibling as HTMLElement | null;

  // Every row gets a leading icon, like the navigation rows already have.
  const leading = (row: HTMLElement | null, paths: string) => {
    if (!row || row.querySelector(".settings-row-left")) return;
    const label = row.firstElementChild as HTMLElement | null;
    if (!label) return;
    const left = el("span", "settings-row-left");
    left.append(iconSpan(paths));
    row.prepend(left);
    left.append(label);
  };
  // The biometric row is filled in after this runs (once the device says it has a biometric).
  const bio = byId("biometricRow");
  if (bio) {
    leading(bio, ICON.fingerprint);
    if (!bio.querySelector(".settings-row-left")) {
      const watch = new MutationObserver(() => {
        if (!bio.firstElementChild) return;
        watch.disconnect();
        leading(bio, ICON.fingerprint);
      });
      watch.observe(bio, { childList: true });
    }
  }
  leading(autoLock, ICON.timer);
  leading(rowOf("network"), ICON.network);
  leading(rowOf("language"), ICON.language);

  // Fee privacy reads as one switch with a line saying what it does; the switch's own
  // "Transparent | Private" captions are hidden on the phone.
  const fee = rowOf("feePrivacyDefault");
  if (fee && !fee.classList.contains("fee-row")) {
    fee.classList.add("fee-row");
    const label = fee.firstElementChild as HTMLElement | null;
    if (label) {
      const text = el("span", "settings-row-text");
      const title = el("span", "");
      title.textContent = t("mobile.privateFees");
      const hint = el("span", "settings-row-hint");
      hint.textContent = t("mobile.privateFeesHint");
      text.append(title, hint);
      const left = el("span", "settings-row-left");
      left.append(iconSpan(ICON.shield), text);
      label.replaceWith(left);
    }
  }

  // On the phone every row says in one line what it's for (the extension's popup is too narrow).
  if (deps.host === "android") {
    const describe = (row: HTMLElement | null, hint: string, title?: string) => {
      const left = row?.querySelector<HTMLElement>(".settings-row-left");
      if (!left || left.querySelector(".settings-row-text")) return;
      const label = [...left.childNodes].find((n) => !(n instanceof HTMLElement && n.classList.contains("icon-svg")));
      if (!label) return;
      const text = el("span", "settings-row-text");
      const name = el("span", "");
      name.textContent = title ?? label.textContent ?? "";
      const line = el("span", "settings-row-hint");
      line.textContent = hint;
      text.append(name, line);
      label.replaceWith(text);
    };
    describe(byId("addAccount"), t("mobile.hintAddAccount"));
    describe(byId("importAccount"), t("mobile.hintImportAccount"), t("mobile.importAccountShort"));
    describe(byId("backup"), t("mobile.hintRevealPhrase"));
    describe(byId("sites"), t("mobile.hintSites"));
    describe(byId("addressBook"), t("mobile.hintAddressBook"));
    describe(byId("connectDaemon"), t("mobile.hintConnectDaemon"));
    if (bio) {
      const bioHint = () => describe(bio, t("mobile.hintBiometric"));
      bioHint();
      if (!bio.querySelector(".settings-row-text")) {
        const watch = new MutationObserver(() => {
          if (!bio.querySelector(".settings-row-left")) return;
          watch.disconnect();
          bioHint();
        });
        watch.observe(bio, { childList: true, subtree: true });
      }
    }
    // A count of nothing says nothing: the hint already explains the row.
    const hideZero = (row: HTMLElement | null) => {
      const tr = row?.querySelector<HTMLElement>(".settings-row-trailing");
      if (tr?.textContent?.trim() === "0") tr.remove();
    };
    hideZero(byId("addressBook"));
    hideZero(byId("sites"));
  }

  // A daemon wallet is an advanced setup: its rows go last, and the list row only once one exists.
  const daemons = byId("daemons");
  if (daemons && daemons.querySelector(".settings-row-trailing")?.textContent?.trim() === "0") daemons.remove();

  const groups: [string, (HTMLElement | null)[]][] = [
    [t("mobile.sectionAccounts"), [byId("addAccount"), byId("importAccount")]],
    [t("mobile.sectionSecurity"), [byId("backup"), biometric?.classList.contains("settings-row") ? biometric : null, autoLock]],
    [t("mobile.sectionConnections"), [byId("sites"), byId("addressBook")]],
    [t("mobile.sectionPreferences"), [rowOf("network"), rowOf("language"), fee]],
    [t("mobile.sectionAdvanced"), [byId("connectDaemon"), daemons?.isConnected ? daemons : null]],
  ];
  const frag = document.createDocumentFragment();
  for (const [title, rows] of groups) {
    const present = rows.filter((r): r is HTMLElement => !!r);
    if (!present.length) continue;
    const head = el("div", "settings-group-title");
    head.textContent = title;
    const group = el("div", "card settings-card settings-group");
    group.dataset.composed = "1";
    group.append(...present);
    frag.append(head, group);
  }
  // Anything not placed above (a row added later in the shared code) stays in the original card.
  card.before(frag);
  if (!card.children.length) card.remove();

  // Locking is routine, not destructive: a plain button with a lock.
  const lock = byId("lock");
  if (lock && !lock.classList.contains("lock-btn")) {
    lock.classList.add("lock-btn");
    lock.prepend(iconSpan(ICON.lock, 18));
  }
  void addSettingsProfile(app);
}

// ---------------- Token detail ----------------
// The shared screen is a card of label/value pairs. On the phone: a hero (logo, name, the balance,
// a private pill), the privacy actions as tiles, then the remaining facts as a details list.
function composeToken(app: HTMLElement): void {
  const hero = app.querySelector<HTMLElement>(".hero");
  const avatar = hero?.querySelector<HTMLElement>(".token-avatar");
  const card = hero?.nextElementSibling as HTMLElement | null;
  if (!hero || !avatar || !card?.classList.contains("card") || card.dataset.composed) return;
  card.dataset.composed = "1";
  document.documentElement.classList.add("screen-token");

  const kids = [...card.children] as HTMLElement[];
  const pairs: [HTMLElement, HTMLElement][] = [];
  for (let i = 0; i < kids.length; i++) {
    const label = kids[i]!;
    const value = kids[i + 1];
    if (label.classList.contains("muted") && value && !value.classList.contains("muted")) {
      pairs.push([label, value]);
      i++;
    }
  }
  if (pairs.length < 3) return;
  const [namePair, symbolPair, balancePair] = pairs as [[HTMLElement, HTMLElement], [HTMLElement, HTMLElement], [HTMLElement, HTMLElement]];
  const privatePair = pairs.find(([l]) => l.classList.contains("private-label"));
  const symbol = symbolPair[1].textContent ?? "";
  const amount = balancePair[1].textContent ?? "";
  const isCount = /[a-z]/i.test(amount); // "3 NFTs" already names its unit

  const top = el("div", "token-hero");
  const name = el("div", "token-hero-name");
  name.textContent = namePair[1].textContent ?? "";
  const label = el("div", "token-hero-label");
  label.textContent = balancePair[0].textContent ?? "";
  const big = el("div", "token-hero-amount");
  const num = el("span", "");
  // Two decimals, as everywhere amounts are displayed; the exact figure on hover.
  num.textContent = twoDecimals(amount);
  num.title = amount;
  splitDecimals(num);
  big.append(num);
  if (!isCount) {
    const unit = el("span", "token-hero-unit");
    unit.textContent = symbol;
    big.append(unit);
  }
  top.append(avatar, name, label, big);
  if (privatePair) {
    const pill = el("div", "private-balance");
    const exact = privatePair[1].textContent ?? "";
    pill.textContent = t("mobile.privateAmount", { amount: twoDecimals(exact) });
    pill.title = `${exact} ${symbol}`;
    top.append(pill);
    privatePair[0].remove();
    privatePair[1].remove();
  }
  balancePair[0].remove();
  balancePair[1].remove();
  hero.replaceWith(top);

  // Remaining facts as rows: label left, value right (the resource address keeps its copy row).
  for (const [l, v] of pairs) {
    if (!l.isConnected || l === balancePair[0]) continue;
    const row = el("div", v.querySelector(".copy-row, .icon-btn") ? "kv kv-stack" : "kv");
    l.before(row);
    row.append(l, v);
  }
  const details = el("div", "section-title token-details-title");
  details.textContent = t("mobile.details");
  card.before(details);

  if (deps.host === "android") {
    composeTokenPhone(app, top, card, {
      resource: hero.dataset.resource ?? "",
      symbol,
      exact: amount,
      privateExact: privatePair?.[1].textContent ?? null,
      isCount,
      namePair,
    });
    return;
  }

  // Shield / Unshield / Send privately: tiles in one row above the details.
  const actions = [...app.querySelectorAll<HTMLButtonElement>("#app > button.secondary:not(#back)")];
  if (actions.length) {
    const kinds = [t("tokenDetail.shieldButton", { symbol }), t("tokenDetail.unshieldButton", { symbol }), t("tokenDetail.sendPrivatelyButton", { symbol })];
    const row = el("div", "token-actions");
    for (const b of actions) {
      const k = kinds.indexOf(b.textContent ?? "");
      b.classList.add("token-action", ["ta-shield", "ta-unshield", "ta-send"][k] ?? "ta-other");
      row.append(b);
    }
    top.after(row);
  }
}

/** Adds two decimal amounts given as display strings ("1,234.5"), keeping full precision. */
export function addDecimals(a: string, b: string): string {
  const parse = (x: string) => {
    const [w = "0", f = ""] = x.replace(/[,\s]/g, "").split(".");
    return { w: w || "0", f };
  };
  const x = parse(a);
  const y = parse(b);
  const places = Math.max(x.f.length, y.f.length);
  const sum = BigInt(x.w + x.f.padEnd(places, "0")) + BigInt(y.w + y.f.padEnd(places, "0"));
  const digits = sum.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = places ? digits.slice(digits.length - places).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

const TOKEN_ACTIONS: Record<string, { icon: string; label: () => string; cls: string }> = {
  tokenSend: { icon: ICON.up, label: () => t("home.send"), cls: "ta-public" },
  tokenShield: { icon: ICON.lock, label: () => t("home.shield"), cls: "ta-private" },
  tokenUnshield: { icon: ICON.unlock, label: () => t("home.unshield"), cls: "ta-private" },
  tokenSendPrivate: { icon: ICON.sendPrivate, label: () => t("mobile.sendPrivateShort"), cls: "ta-private" },
};

/**
 * The phone's token screen: the name is the screen title, the actions are Home's round buttons,
 * a balance card gives the exact public / private / total figures (the hero rounds to two
 * decimals), the details are compact rows, and the token's own activity closes the screen.
 */
function composeTokenPhone(
  app: HTMLElement,
  top: HTMLElement,
  card: HTMLElement,
  o: { resource: string; symbol: string; exact: string; privateExact: string | null; isCount: boolean; namePair: [HTMLElement, HTMLElement] }
): void {
  document.documentElement.classList.add("screen-token-phone");
  if (o.privateExact) {
    const label = top.querySelector<HTMLElement>(".token-hero-label");
    if (label) label.textContent = t("mobile.publicBalanceLabel");
  }

  // Actions: round buttons with short labels, Home's style.
  const buttons = Object.keys(TOKEN_ACTIONS)
    .map((id) => app.querySelector<HTMLButtonElement>(`#${id}`))
    .filter((b): b is HTMLButtonElement => !!b);
  let after: HTMLElement = top;
  if (buttons.length) {
    const row = el("div", "action-row token-action-row");
    row.style.setProperty("--n", String(buttons.length));
    for (const b of buttons) {
      const spec = TOKEN_ACTIONS[b.id]!;
      const ic = el("div", "action-icon");
      ic.setAttribute("aria-hidden", "true");
      ic.append(iconSpan(spec.icon, 22));
      b.className = `action-btn ${spec.cls}`;
      b.replaceChildren(ic, document.createTextNode(spec.label()));
      row.append(b);
    }
    top.after(row);
    after = row;
  }

  // Exact balances, when there is a private part to add up.
  if (o.privateExact && !o.isCount) {
    const title = el("div", "section-title");
    title.textContent = t("mobile.balanceTitle");
    const bal = el("div", "card token-balance-card");
    const line = (label: string, value: string, cls = "") => {
      const r = el("div", `kv ${cls}`.trim());
      const l = el("div", "muted");
      l.textContent = label;
      const v = el("div", "detail-value");
      v.textContent = `${value} ${o.symbol}`;
      r.append(l, v);
      return r;
    };
    let total = "";
    try {
      total = addDecimals(o.exact, o.privateExact);
    } catch {
      total = "";
    }
    bal.append(line(t("mobile.publicBalanceLabel"), o.exact), line(t("mobile.privateBalanceLabel"), o.privateExact, "kv-private"));
    if (total) bal.append(line(t("mobile.totalBalanceLabel"), total, "kv-total"));
    after.after(title, bal);
  }

  // Details: the name is already the title; the resource address shortened, with a copy button.
  const nameRow = o.namePair[0].parentElement;
  if (nameRow?.classList.contains("kv")) nameRow.remove();
  const addrRow = card.querySelector<HTMLElement>(".kv-stack");
  const addr = addrRow?.querySelector<HTMLElement>(".addr");
  const copy = addrRow?.querySelector<HTMLElement>(".icon-btn");
  if (addrRow && addr && copy) {
    addrRow.classList.remove("kv-stack");
    addrRow.classList.add("kv-address");
    const full = addr.textContent ?? "";
    const value = el("div", "detail-value kv-address-value");
    const short = el("span", "mono");
    short.textContent = shortAddr(full, 8);
    short.title = full;
    copy.classList.add("copy-icon");
    copy.setAttribute("aria-label", t("mobile.copyAddress"));
    copy.replaceChildren(iconSpan(ICON.copy, 18), el("span", "sr-only"));
    // The shared handler writes "Copied" into the label it was given (now detached); show it here.
    copy.addEventListener("click", () => {
      copy.classList.add("copied");
      setTimeout(() => copy.classList.remove("copied"), 1200);
    });
    value.append(short, copy);
    const label = addrRow.querySelector<HTMLElement>(".muted");
    if (label) label.textContent = t("mobile.resourceAddressShort");
    addrRow.replaceChildren(...(label ? [label] : []), value);
  }

  void addTokenActivity(app, o.resource);
}

async function addTokenActivity(app: HTMLElement, resource: string): Promise<void> {
  if (!resource) return;
  let entries: TransactionHistoryEntry[];
  try {
    entries = await deps.history();
  } catch {
    return;
  }
  // The screen may have been left (or re-rendered) while this loaded.
  const details = app.querySelector<HTMLElement>(".token-details-title");
  const detailsCard = details?.nextElementSibling as HTMLElement | null;
  if (!details || !detailsCard || app.querySelector(".token-activity")) return;
  const mine = entries.filter((e) => e.resourceAddress === resource).sort((a, b) => b.createdAt - a.createdAt);
  const head = el("div", "recent-head token-activity");
  const title = el("div", "section-title");
  title.textContent = t("mobile.tokenActivity");
  head.append(title);
  let body: HTMLElement;
  if (mine.length) {
    if (mine.length > 5) {
      const all = el("button", "see-all");
      all.type = "button";
      all.textContent = t("mobile.seeAll");
      all.addEventListener("click", openActivity);
      head.append(all);
    }
    body = el("div", "card recent-card history-list");
    for (const e of mine.slice(0, 5)) body.append(activityRow(e));
  } else {
    body = el("p", "token-activity-empty");
    body.textContent = t("mobile.tokenNoActivity");
  }
  detailsCard.after(head, body);
}

// ---------------- Activity ----------------
const INCOMING = new Set(["received", "claim", "private-payment-received", "burn-claim"]);
const OUTGOING = new Set(["send", "send-privately"]);

function composeHistory(app: HTMLElement): void {
  for (const row of app.querySelectorAll<HTMLElement>(".balance-row[data-kind]:not([data-composed])")) {
    row.dataset.composed = "1";
    const kind = row.dataset.kind ?? "";
    row.classList.add(INCOMING.has(kind) ? "hk-in" : OUTGOING.has(kind) ? "hk-out" : kind.includes("shield") ? "hk-private" : "hk-other");
    const amount = row.querySelector<HTMLElement>(".history-amount");
    if (!amount) continue;
    const meta = amount.parentElement!;
    const when = meta.querySelector(".history-when");
    meta.replaceChildren(...(when ? [when] : []));
    const right = el("div", "history-right");
    const sign = INCOMING.has(kind) ? "+" : OUTGOING.has(kind) ? "−" : "";
    const exact = amount.textContent ?? "";
    amount.title = exact;
    amount.textContent = row.dataset.divisibility === "0" ? `${sign}${exact}` : `${sign}${exact.replace(/[\d,]+(?:\.\d+)?/, (n) => twoDecimals(n))}`;
    right.append(amount);
    row.append(right);
    if (deps.host === "android" && row.querySelector(".history-tx, .list-row-subtitle")) phoneHistoryRow(row, kind);
  }

  // Group the full list by day: a heading, then that day's rows in their own card.
  const list = app.querySelector<HTMLElement>(".history-list-full");
  if (!list || list.dataset.grouped || !list.querySelector(".balance-row[data-ts]")) return;
  list.dataset.grouped = "1";
  const frag = document.createDocumentFragment();
  let currentKey = "";
  let currentCard: HTMLElement | null = null;
  for (const row of [...list.querySelectorAll<HTMLElement>(".balance-row[data-ts]")]) {
    const ts = Number(row.dataset.ts);
    const key = ts > 0 ? dayKey(ts) : "earlier";
    if (key !== currentKey || !currentCard) {
      currentKey = key;
      const head = el("div", "day-head");
      head.textContent = ts > 0 ? dayLabel(ts) : t("history.earlier");
      currentCard = el("div", "card history-list history-day");
      frag.append(head, currentCard);
    }
    const when = row.querySelector(".history-when");
    if (when && ts > 0) when.textContent = timeOf(ts);
    currentCard.append(row);
  }
  list.replaceWith(frag);
}

/**
 * The phone's Activity row: "Sent", then "8:33 AM · otl_esm_1a…rjvnv", amount on the right. The
 * transaction id, explorer link, memo and full address move to a details sheet opened by a tap
 * (on every row they made each entry ~300px tall).
 */
function phoneHistoryRow(row: HTMLElement, kind: string): void {
  const info = row.querySelector<HTMLElement>(".list-row-info");
  if (!info) return;
  const txLine = info.querySelector<HTMLElement>(".history-tx");
  const subs = [...info.querySelectorAll<HTMLElement>(":scope > .list-row-subtitle:not(.history-tx)")];
  const party = subs.find((x) => x.title);
  const memoEl = subs.find((x) => !x.title);
  const amount = row.querySelector<HTMLElement>(".history-amount");
  const d: TxDetails = {
    title: info.firstElementChild?.textContent ?? "",
    amount: amount?.textContent ?? "",
    exact: amount?.title ?? "",
    tone: INCOMING.has(kind) ? "in" : OUTGOING.has(kind) ? "out" : "other",
    ts: Number(row.dataset.ts) || 0,
    party: party?.title ?? null,
    partyIsAddress: kind !== "dapp-transaction",
    memo: memoEl?.textContent?.replace(/^"|"$/g, "") ?? null,
    txId: txLine?.title ?? null,
    href: txLine?.querySelector("a")?.href ?? null,
    failed: row.classList.contains("status-failed"),
    nfts: row.dataset.nfts ?? null,
  };
  txLine?.remove();
  memoEl?.remove();
  if (party && d.partyIsAddress) {
    // One line: the time, then who it was with.
    const when = info.querySelector<HTMLElement>(".history-when")?.parentElement;
    party.remove();
    if (when) when.append(` · ${shortAddr(party.title, 6)}`);
  }
  row.classList.add("history-tappable");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  const open = () => openTxSheet(d);
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
}

interface TxDetails {
  title: string;
  amount: string;
  exact: string;
  tone: "in" | "out" | "other";
  ts: number;
  party: string | null;
  partyIsAddress: boolean;
  memo: string | null;
  txId: string | null;
  href: string | null;
  failed: boolean;
  nfts: string | null;
}

let txSheet: HTMLElement | null = null;

/** Closes the transaction details sheet if open (hardware back); true when it was. */
export function closeTxSheet(): boolean {
  if (!txSheet) return false;
  const s = txSheet;
  txSheet = null;
  s.classList.remove("open");
  setTimeout(() => s.remove(), 260);
  return true;
}

function openTxSheet(d: TxDetails): void {
  closeTxSheet();
  const wrap = el("div", "review-sheet tx-sheet");
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-label", t("mobile.txDetails"));
  const card = el("div", "review-card tx-card");
  card.append(el("div", "wc-sheet-handle"));

  const head = el("div", "tx-head");
  const kind = el("div", "tx-kind");
  kind.textContent = d.title;
  const big = el("div", `tx-amount tx-${d.tone}`);
  // The exact figure here (rows round to two decimals), with the row's sign.
  const sign = d.amount.match(/^[+−]/)?.[0] ?? "";
  big.textContent = d.exact ? `${sign}${d.exact}` : d.amount;
  head.append(kind);
  if (big.textContent) head.append(big);
  card.append(head);

  const list = el("div", "tx-rows");
  const line = (label: string, value: string, opts: { mono?: boolean; copy?: string } = {}) => {
    const r = el("div", "tx-row");
    const l = el("div", "tx-label");
    l.textContent = label;
    const v = el("div", `tx-value${opts.mono ? " mono" : ""}`);
    v.textContent = value;
    r.append(l, v);
    if (opts.copy) {
      const copyText = opts.copy;
      const b = el("button", "tx-copy");
      b.type = "button";
      b.setAttribute("aria-label", t("common.copy"));
      b.append(iconSpan(ICON.copy, 18));
      b.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(copyText);
          b.classList.add("copied");
          setTimeout(() => b.classList.remove("copied"), 1200);
        } catch {
          /* clipboard unavailable: the value is still selectable */
        }
      });
      r.append(b);
    }
    list.append(r);
  };
  if (d.ts > 0) line(t("mobile.txDate"), new Date(d.ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  if (d.party) {
    const label = !d.partyIsAddress ? t("mobile.txDapp") : d.tone === "in" ? t("mobile.txFrom") : t("mobile.txTo");
    line(label, d.party, d.partyIsAddress ? { mono: true, copy: d.party } : {});
  }
  if (d.nfts) line(t("nft.label"), d.nfts);
  if (d.memo) line(t("mobile.txMemo"), d.memo);
  if (d.txId) line(t("mobile.txId"), shortAddr(d.txId, 10), { mono: true, copy: d.txId });
  card.append(list);

  const actions = el("div", "tx-actions");
  if (d.href) {
    const a = document.createElement("a");
    a.className = "tx-explorer";
    a.href = d.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = t("history.viewOnExplorer");
    actions.append(a);
  }
  const close = el("button", "secondary tx-close");
  close.type = "button";
  close.textContent = t("mobile.close");
  close.addEventListener("click", () => closeTxSheet());
  actions.append(close);
  card.append(actions);

  wrap.append(card);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) closeTxSheet();
  });
  document.body.append(wrap);
  txSheet = wrap;
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add("open")));
}

// ---------------- Receive ----------------
// QR first; the address with Copy and Share side by side; the explanation after it, as a note.
function composeReceive(app: HTMLElement): void {
  const qr = app.querySelector<HTMLElement>(".qr-card");
  const share = app.querySelector<HTMLElement>("#shareAddress");
  if (!qr || !share || qr.dataset.composed) return;
  const addrCard = share.previousElementSibling as HTMLElement | null;
  const copy = addrCard?.querySelector<HTMLElement>(".icon-btn");
  if (!addrCard || !copy) return;
  qr.dataset.composed = "1";
  document.documentElement.classList.add("screen-receive");
  const desc = app.querySelector<HTMLElement>(":scope > p.muted");
  addrCard.classList.add("receive-address");
  const actions = el("div", "receive-actions");
  copy.classList.add("receive-copy");
  actions.append(copy, share);
  addrCard.append(actions);
  if (desc) {
    desc.classList.add("receive-note");
    addrCard.after(desc);
  }
}

// ---------------- Settings profile ----------------
async function addSettingsProfile(app: HTMLElement): Promise<void> {
  let s: Awaited<ReturnType<RedesignDeps["status"]>>;
  try {
    s = await deps.status();
  } catch {
    return;
  }
  const first = app.querySelector<HTMLElement>(".settings-group-title");
  if (!first || app.querySelector(".profile-card")) return;
  const acct = s.accounts.find((a) => a.id === s.activeAccountId);
  // With more than one account (or a way to add one), the card opens the account switcher.
  const card = el(deps.openAccounts ? "button" : "div", "profile-card");
  if (card instanceof HTMLButtonElement) {
    card.type = "button";
    card.setAttribute("aria-label", t("mobile.switchAccount"));
    card.addEventListener("click", () => deps.openAccounts?.());
  }
  card.innerHTML = `<div class="profile-avatar">${s.address ? avatarSvg(s.address, 56) : ""}</div><div class="profile-text"><b></b><span></span></div><span class="profile-net"></span>${deps.openAccounts ? `<span class="profile-chevron">${svg(ICON.chevron, 18)}</span>` : ""}`;
  card.querySelector("b")!.textContent = acct?.label ?? t("home.accountFallback");
  card.querySelector(".profile-text span")!.textContent = s.receiveAddress ? shortAddr(s.receiveAddress, 8) : "";
  card.querySelector(".profile-net")!.textContent = s.network.charAt(0).toUpperCase() + s.network.slice(1);
  card.classList.toggle("is-mainnet", s.network === "mainnet");
  first.before(card);

  const lock = app.querySelector<HTMLElement>("#lock");
  if (lock && !app.querySelector(".app-version")) {
    const v = el("div", "app-version");
    v.textContent = `Sapient ${platform().appVersion()} · ${t("common.byErebus")}`;
    lock.after(v);
  }
}

export function installRedesign(d: RedesignDeps): void {
  deps = d;
  const app = document.getElementById("app")!;
  const root = document.documentElement;
  try {
    if (localStorage.getItem(HIDE_KEY) === "1") root.classList.add("hide-amounts");
  } catch {
    /* storage unavailable */
  }
  const compose = () => {
    // Screen flags for CSS, reset on every render.
    if (!app.querySelector(".welcome-hero")) root.classList.remove("screen-welcome");
    if (!app.querySelector(".account-summary")) root.classList.remove("screen-home");
    if (!app.querySelector(".token-hero, .hero .token-avatar")) root.classList.remove("screen-token", "screen-token-phone");
    if (!app.querySelector(".qr-card")) root.classList.remove("screen-receive");
    composeWelcome(app);
    composeHome(app);
    composeSettings(app);
    composeToken(app);
    composeHistory(app);
    composeReceive(app);
    composeLockup(app);
    composeApprovalHero(app);
    composeSecret(app);
    composeDappsEmpty(app);
    composeClaimBurn(app);
    composePageBar(app);
  };
  new MutationObserver(compose).observe(app, { childList: true });
  compose();
}
