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
    const privEl = hero.querySelector<HTMLElement>(".private-balance");
    balance.insertBefore(split, addr ?? null);
    const num = (v: string | null | undefined) => Number((v ?? "").replace(/[^0-9.]/g, "")) || 0;
    const update = () => {
      if (amountEl) splitDecimals(amountEl);
      if (privEl && privEl.style.display !== "none") {
        // "0.50 private": the unit is already beside the balance above it.
        const n = (privEl.textContent ?? "").match(/[\d,]+(?:\.\d+)?/)?.[0];
        const next = n ? t("mobile.privateAmount", { amount: twoDecimals(n) }) : null;
        if (next && privEl.textContent !== next) {
          privEl.title = privEl.textContent ?? "";
          privEl.textContent = next;
        }
      }
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
      const exact = formatBalanceAmountGrouped(e.amount, e.divisibility ?? 6);
      const unit = resourceLabel(e.resourceAddress, e.symbol ?? null);
      amt.textContent = `${sign}${twoDecimals(exact)} ${unit}`;
      amt.title = `${exact} ${unit}`;
      right.append(amt);
      row.append(right);
    }
    row.addEventListener("click", openActivity);
    card.append(row);
  }
  all.addEventListener("click", openActivity);
  anchor.after(head, card);
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
    const exact = amount.textContent ?? "";
    amount.title = exact;
    amount.textContent = `${sign}${exact.replace(/[\d,]+(?:\.\d+)?/, (n) => twoDecimals(n))}`;
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
    v.textContent = `Sapient ${platform().appVersion()}`;
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
    composeSecret(app);
    composeDappsEmpty(app);
    composeClaimBurn(app);
    composePageBar(app);
  };
  new MutationObserver(compose).observe(app, { childList: true });
  compose();
}
