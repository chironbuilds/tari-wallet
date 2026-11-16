// A review sheet before value moves. The shared screens act on their primary button straight away
// ("Review & Send", "Send X privately", "Shield X", "Unshield X"); on the phone that tap first opens
// this sheet, and only its Confirm lets the original handler run.
//   Sends: amount, the full recipient address (the characters people compare highlighted),
//   network, privacy and memo.
//   Shield / Unshield: amount and the direction (Public -> Private or back), network, who pays the fee.
// Incomplete forms pass straight through so the shared screen still shows its own errors.
import { ImpactStyle } from "@capacitor/haptics";
import { t } from "../lib/i18n";
import { tick } from "./nav";

export interface ReviewDeps {
  network(): Promise<string>;
}

type Mode = "public" | "private" | "shield" | "unshield";

let sheet: HTMLElement | null = null;

/** Closes the review sheet if open (hardware back); true when it was. */
export function closeReviewSheet(): boolean {
  if (!sheet) return false;
  const s = sheet;
  sheet = null;
  s.classList.remove("open");
  setTimeout(() => s.remove(), 260);
  return true;
}

/** Text that is `template` with any symbol in place of {symbol}, e.g. "Shield TARI". */
function matches(text: string, template: string): string | null {
  const [before, after] = template.split("\u0000");
  if (before === undefined || after === undefined || !text.startsWith(before) || !text.endsWith(after)) return null;
  const symbol = text.slice(before.length, text.length - after.length).trim();
  return symbol || null;
}

function classify(button: HTMLElement): { mode: Mode; symbol: string | null } | null {
  const text = button.textContent?.trim() ?? "";
  if (text === t("send.reviewAndSend")) return { mode: "public", symbol: null };
  const priv = matches(text, t("send.sendPrivatelyButton", { symbol: "\u0000" }));
  if (priv) return { mode: "private", symbol: priv };
  const shield = matches(text, t("shield.submitButton", { symbol: "\u0000" }));
  if (shield) return { mode: "shield", symbol: shield };
  const unshield = matches(text, t("unshield.submitButton", { symbol: "\u0000" }));
  if (unshield) return { mode: "unshield", symbol: unshield };
  return null;
}

function networkName(network: string): string {
  return t(network === "mainnet" ? "network.mainnet" : network === "esmeralda" ? "network.esmeralda" : "network.igor");
}

function row(label: string, value: Node | string, cls = ""): HTMLElement {
  const r = document.createElement("div");
  r.className = `rv-row ${cls}`;
  const l = document.createElement("span");
  l.className = "rv-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "rv-value";
  v.append(value);
  r.append(l, v);
  return r;
}

function addressNode(address: string): HTMLElement {
  const a = document.createElement("span");
  a.className = "rv-addr";
  const ends = 6;
  if (address.length <= ends * 2 + 12) {
    a.textContent = address;
    return a;
  }
  // Every address shares its prefix ("otl_esm_1"), so the characters worth comparing are the six
  // right after it and the last six.
  const prefixLen = address.match(/^[a-z]+(?:_[a-z]+)*_1/)?.[0].length ?? 0;
  const prefix = document.createElement("span");
  prefix.textContent = address.slice(0, prefixLen);
  const head = document.createElement("b");
  head.textContent = address.slice(prefixLen, prefixLen + ends);
  const mid = document.createElement("span");
  mid.textContent = address.slice(prefixLen + ends, -ends);
  const tail = document.createElement("b");
  tail.textContent = address.slice(-ends);
  a.append(prefix, head, mid, tail);
  return a;
}

/** "Public -> Private" (or back) as two chips and an arrow. */
function direction(mode: "shield" | "unshield"): HTMLElement {
  const d = document.createElement("div");
  d.className = "rv-flow";
  const pub = document.createElement("span");
  pub.className = "rv-chip rv-chip-pub";
  pub.textContent = t("mobile.publicLabel");
  const priv = document.createElement("span");
  priv.className = "rv-chip rv-chip-priv";
  priv.textContent = t("mobile.privateLabel");
  const arrow = document.createElement("span");
  arrow.className = "rv-arrow";
  arrow.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  if (mode === "shield") d.append(pub, arrow, priv);
  else d.append(priv, arrow, pub);
  return d;
}

const TITLES: Record<Mode, Parameters<typeof t>[0]> = {
  public: "mobile.reviewTitle",
  private: "mobile.reviewPrivateTitle",
  shield: "mobile.reviewShieldTitle",
  unshield: "mobile.reviewUnshieldTitle",
};
const CONFIRMS: Record<Mode, Parameters<typeof t>[0]> = {
  public: "mobile.reviewConfirm",
  private: "mobile.reviewConfirm",
  shield: "mobile.reviewConfirmShield",
  unshield: "mobile.reviewConfirmUnshield",
};

function formOf(button: HTMLElement): HTMLElement {
  return button.parentElement ?? document.getElementById("app")!;
}

async function open(button: HTMLButtonElement, mode: Mode, symbolHint: string | null, deps: ReviewDeps): Promise<void> {
  const form = formOf(button);
  const app = document.getElementById("app")!;
  const recipient = form.querySelector<HTMLInputElement>('input[placeholder^="otl_"]')?.value.trim() ?? "";
  const amount = form.querySelector<HTMLInputElement>(".amount-field input")?.value.trim() ?? "";
  const asset = app.querySelector<HTMLSelectElement>("select")?.selectedOptions[0]?.textContent?.trim() ?? "";
  const symbol = symbolHint ?? asset.split(/\s/)[0] ?? "";
  const memo =
    [...form.querySelectorAll<HTMLInputElement>('input[type="text"]')]
      .find((i) => !i.placeholder.startsWith("otl_") && !i.closest(".amount-field"))
      ?.value.trim() ?? "";
  let network = "";
  try {
    network = networkName(await deps.network());
  } catch {
    /* shown without it */
  }

  closeReviewSheet();
  const root = document.createElement("div");
  root.className = "review-sheet";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const card = document.createElement("div");
  card.className = `review-card rv-${mode}`;
  card.innerHTML = '<div class="wc-sheet-handle"></div>';
  const title = document.createElement("h2");
  title.textContent = t(TITLES[mode]);
  const big = document.createElement("div");
  big.className = "rv-amount";
  const num = document.createElement("span");
  num.textContent = amount;
  const unit = document.createElement("span");
  unit.className = "rv-unit";
  unit.textContent = symbol;
  big.append(num, unit);

  const rows = document.createElement("div");
  rows.className = "rv-rows";
  if (mode === "public" || mode === "private") {
    rows.append(row(t("mobile.reviewTo"), addressNode(recipient), "rv-to"));
    if (network) rows.append(row(t("settings.network"), network));
    rows.append(row(t("mobile.reviewPrivacy"), t(mode === "private" ? "mobile.reviewPrivate" : "mobile.reviewPublic"), mode === "private" ? "rv-priv" : ""));
  } else {
    if (network) rows.append(row(t("settings.network"), network));
    rows.append(row(t("mobile.reviewFee"), t("mobile.reviewFeePublic")));
  }
  if (memo) rows.append(row(t("mobile.reviewMemo"), memo));

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "primary";
  confirm.textContent = t(CONFIRMS[mode]);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = t("common.cancel");
  card.append(title, big);
  if (mode === "shield" || mode === "unshield") card.append(direction(mode));
  card.append(rows, confirm, cancel);
  root.append(card);
  document.body.append(root);
  sheet = root;
  requestAnimationFrame(() => root.classList.add("open"));

  cancel.addEventListener("click", () => closeReviewSheet());
  root.addEventListener("click", (e) => {
    if (e.target === root) closeReviewSheet();
  });
  confirm.addEventListener("click", () => {
    tick(ImpactStyle.Heavy);
    closeReviewSheet();
    button.dataset.reviewed = "1";
    button.click();
  });
}

export function installReview(deps: ReviewDeps): void {
  const app = document.getElementById("app")!;
  app.addEventListener(
    "click",
    (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button.primary");
      if (!button || button.disabled) return;
      const found = classify(button);
      if (!found) return;
      if (button.dataset.reviewed) {
        delete button.dataset.reviewed;
        return; // confirmed: the shared handler runs
      }
      const form = formOf(button);
      const amount = form.querySelector<HTMLInputElement>(".amount-field input")?.value.trim();
      const needsRecipient = found.mode === "public" || found.mode === "private";
      const recipient = form.querySelector<HTMLInputElement>('input[placeholder^="otl_"]')?.value.trim();
      // Incomplete: let the shared screen say what's missing. (Any non-zero digit counts as an
      // amount: "1,000" must still be reviewed, not skipped.)
      if (!amount || !/[1-9]/.test(amount) || (needsRecipient && !recipient)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      tick();
      void open(button, found.mode, found.symbol, deps);
    },
    true
  );
}
