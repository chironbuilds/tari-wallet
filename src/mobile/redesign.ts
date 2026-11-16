// Phone layouts for the shared popup screens. The popup renders the same elements for the
// extension's 320px window; after each render this re-composes a few of them into native-feeling
// mobile layouts -- the welcome screen, the Home header and hero, the L1-burn card, grouped
// Settings. It only moves and wraps existing elements (never re-creates them), so their event
// listeners keep working, and every step is idempotent: a screen already composed is left alone.
import { t } from "../lib/i18n";

const ICON = {
  key: '<path d="M14.5 9.5a4.5 4.5 0 1 1-2.2-3.9"/><path d="M14 10l7-7M18 6l2 2M16 8l2 2"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-2.6 3.6M6.6 6.6A13 13 0 0 0 2 12c1 2.5 5 7 10 7a9.7 9.7 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
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
}

export function installRedesign(): void {
  const app = document.getElementById("app")!;
  const root = document.documentElement;
  const compose = () => {
    // Screen flags for CSS, reset on every render.
    if (!app.querySelector(".welcome-hero")) root.classList.remove("screen-welcome");
    if (!app.querySelector(".account-summary")) root.classList.remove("screen-home");
    if (!app.querySelector(".token-hero, .hero .token-avatar")) root.classList.remove("screen-token");
    composeWelcome(app);
    composeHome(app);
    composeSettings(app);
    composeToken(app);
    composeHistory(app);
  };
  new MutationObserver(compose).observe(app, { childList: true });
  compose();
}
