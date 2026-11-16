// Phone layouts for the shared popup screens. The popup renders the same elements for the
// extension's 320px window; after each render this re-composes a few of them into native-feeling
// mobile layouts -- the welcome screen, the Home header and hero, the L1-burn card, grouped
// Settings. It only moves and wraps existing elements (never re-creates them), so their event
// listeners keep working, and every step is idempotent: a screen already composed is left alone.
import { t } from "../lib/i18n";
import { avatarSvg } from "../lib/avatar";
import type { TransactionHistoryEntry } from "../lib/storage";
import { formatBalanceAmountGrouped, resourceLabel, shortAddr } from "../popup/format";

declare const __APP_VERSION__: string;

/** What the phone layouts read beyond the rendered screen. */
export interface RedesignDeps {
  history(): Promise<TransactionHistoryEntry[]>;
  status(): Promise<{ address: string | null; receiveAddress: string | null; network: string; accounts: { id: string; label: string }[]; activeAccountId: string }>;
}
let deps: RedesignDeps;

const ICON = {
  key: '<path d="M14.5 9.5a4.5 4.5 0 1 1-2.2-3.9"/><path d="M14 10l7-7M18 6l2 2M16 8l2 2"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-2.6 3.6M6.6 6.6A13 13 0 0 0 2 12c1 2.5 5 7 10 7a9.7 9.7 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
};

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

  const tagline = el("p", "welcome-tagline");
  tagline.textContent = t("mobile.welcomeTagline");
  hero.querySelector("h1")?.after(tagline);

  const features = el("ul", "welcome-features");
  for (const [icon, text] of [
    [ICON.key, t("mobile.featureKeys")],
    [ICON.eyeOff, t("mobile.featurePrivate")],
    [ICON.link, t("mobile.featureDapps")],
  ] as const) {
    const li = el("li", "", `<span class="wf-icon">${svg(icon, 18)}</span>`);
    li.append(text);
    features.append(li);
  }
  hero.append(features);

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
  if (network) header.append(network);
  nav.before(header);

  // Hero: label, amount, private pill, address chip.
  const balance = hero.querySelector<HTMLElement>(".summary-balance");
  const addr = hero.querySelector<HTMLElement>(".addr-pill");
  if (balance && addr) balance.append(addr);

  // Hide amounts: an eye beside the label masks every figure in the app until tapped again.
  const label = hero.querySelector<HTMLElement>(".summary-label");
  if (label) {
    const eye = el("button", "amount-eye", svg(ICON.eye, 18));
    eye.type = "button";
    eye.setAttribute("aria-label", t("mobile.hideAmounts"));
    eye.setAttribute("aria-pressed", String(amountsHidden()));
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      setAmountsHidden(!amountsHidden());
      eye.setAttribute("aria-pressed", String(amountsHidden()));
    });
    label.append(eye);
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
    const privEl = hero.querySelector<HTMLElement>(".private-balance");
    balance.insertBefore(split, addr ?? null);
    const num = (v: string | null | undefined) => Number((v ?? "").replace(/[^0-9.]/g, "")) || 0;
    const update = () => {
      if (amountEl) splitDecimals(amountEl);
      const pub = num(amountEl?.textContent);
      const privText = privEl && privEl.style.display !== "none" ? (privEl.textContent ?? "").split(" ")[0] : "";
      const priv = num(privText);
      const total = pub + priv;
      split.hidden = !(priv > 0 && total > 0);
      hero.classList.toggle("has-split", !split.hidden);
      if (split.hidden) return;
      const p = Math.max(4, Math.min(96, (pub / total) * 100));
      split.querySelector<HTMLElement>(".split-pub")!.style.width = `${p}%`;
      split.querySelector<HTMLElement>(".split-priv")!.style.width = `${100 - p}%`;
      split.querySelector(".sl-pub em")!.textContent = amountEl?.textContent ?? "";
      split.querySelector(".sl-priv em")!.textContent = privText ?? "";
    };
    // Only the two figures, never the hero as a whole: update() itself writes styles into it.
    const watch = new MutationObserver(update);
    if (amountEl) watch.observe(amountEl, { subtree: true, childList: true, characterData: true });
    if (privEl) watch.observe(privEl, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style"] });
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
    const watch = () => enhanceEmptyAssets(app, assets);
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
  const list = el("ol", "pg-steps");
  for (const [icon, text, cls] of [
    [ICON.eye, t("mobile.guidePublic"), "pg-pub"],
    [ICON.lock, t("mobile.guideShield"), "pg-priv"],
    [ICON.up, t("mobile.guidePrivate"), "pg-priv"],
  ] as const) {
    const li = el("li", cls, `<span class="pg-icon">${svg(icon, 16)}</span>`);
    const span = el("span", "");
    span.textContent = text;
    li.append(span);
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
    card.classList.add("leaving");
    setTimeout(() => card.remove(), 220);
  });
  card.append(title, list, done);
  after.after(card);
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
  const icon = el("div", "ea-logo", '<img src="icons/icon48.png" alt="">');
  empty.replaceChildren(icon, title, body, receive);
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
  for (const e of entries.slice(0, 3)) {
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
      amt.textContent = `${sign}${formatBalanceAmountGrouped(e.amount, e.divisibility ?? 6)} ${resourceLabel(e.resourceAddress, e.symbol ?? null)}`;
      right.append(amt);
      row.append(right);
    }
    row.addEventListener("click", openActivity);
    card.append(row);
  }
  all.addEventListener("click", openActivity);
  anchor.after(head, card);
}

function openActivity(): void {
  document.querySelector<HTMLElement>('#tab-bar [data-tab="activity"]')?.click();
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
  const dot = text.indexOf(".");
  if (dot <= 0 || !/^[\d,]+\.\d+$/.test(text.trim())) return;
  const whole = el("span", "whole");
  whole.textContent = text.slice(0, dot);
  const frac = el("span", "frac");
  frac.textContent = text.slice(dot);
  target.replaceChildren(whole, frac);
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
  mono.style.background = `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 40) % 360} 65% 46%))`;
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
  lockup.innerHTML = '<img src="icons/icon48.png" width="28" height="28" alt=""><span>Sapient</span>';
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

  const groups: [string, (HTMLElement | null)[]][] = [
    [t("mobile.sectionAccounts"), [byId("addAccount"), byId("importAccount"), byId("connectDaemon"), byId("daemons")]],
    [t("mobile.sectionSecurity"), [byId("backup"), biometric?.classList.contains("settings-row") ? biometric : null, autoLock]],
    [t("mobile.sectionConnections"), [byId("sites"), byId("addressBook")]],
    [t("mobile.sectionPreferences"), [rowOf("network"), rowOf("language"), rowOf("feePrivacyDefault")]],
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
  num.textContent = amount;
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
    pill.textContent = t("home.privateSuffix", { amount: privatePair[1].textContent ?? "", symbol });
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
    amount.textContent = `${sign}${amount.textContent ?? ""}`;
    right.append(amount);
    row.append(right);
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
  const card = el("div", "profile-card");
  card.innerHTML = `<div class="profile-avatar">${s.address ? avatarSvg(s.address, 56) : ""}</div><div class="profile-text"><b></b><span></span></div><span class="profile-net"></span>`;
  card.querySelector("b")!.textContent = acct?.label ?? t("home.accountFallback");
  card.querySelector(".profile-text span")!.textContent = s.receiveAddress ? shortAddr(s.receiveAddress, 10) : "";
  card.querySelector(".profile-net")!.textContent = s.network.charAt(0).toUpperCase() + s.network.slice(1);
  card.classList.toggle("is-mainnet", s.network === "mainnet");
  first.before(card);

  const lock = app.querySelector<HTMLElement>("#lock");
  if (lock && !app.querySelector(".app-version")) {
    const v = el("div", "app-version");
    v.textContent = `Sapient ${__APP_VERSION__}`;
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
    if (!app.querySelector(".token-hero, .hero .token-avatar")) root.classList.remove("screen-token");
    if (!app.querySelector(".qr-card")) root.classList.remove("screen-receive");
    composeWelcome(app);
    composeHome(app);
    composeSettings(app);
    composeToken(app);
    composeHistory(app);
    composeReceive(app);
    composeLockup(app);
    composeApprovalHero(app);
  };
  new MutationObserver(compose).observe(app, { childList: true });
  compose();
}
