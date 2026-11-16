// A review sheet before money leaves the wallet. The shared Send screens submit on their primary
// button ("Review & Send" / "Send X privately") straight away; on the phone that tap first opens
// this sheet -- amount, the full recipient address (ends highlighted, to check against what the
// person was given), network, privacy and memo -- and only "Confirm send" lets the original handler
// run. Incomplete forms pass straight through so the shared screen still shows its own errors.
import { ImpactStyle } from "@capacitor/haptics";
import { t } from "../lib/i18n";
import { tick } from "./nav";

export interface ReviewDeps {
  network(): Promise<string>;
}

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

function kind(button: HTMLElement): "public" | "private" | null {
  const text = button.textContent?.trim() ?? "";
  if (text === t("send.reviewAndSend")) return "public";
  // "Send {symbol} privately": match around the symbol.
  const [before, after] = t("send.sendPrivatelyButton", { symbol: "\u0000" }).split("\u0000");
  if (before !== undefined && after !== undefined && text.startsWith(before) && text.endsWith(after)) return "private";
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
  if (address.length <= ends * 2 + 4) {
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

async function open(button: HTMLButtonElement, mode: "public" | "private", deps: ReviewDeps): Promise<void> {
  const form = button.parentElement!;
  const app = document.getElementById("app")!;
  const recipient = form.querySelector<HTMLInputElement>('input[placeholder^="otl_"]')?.value.trim() ?? "";
  const amount = form.querySelector<HTMLInputElement>(".amount-field input")?.value.trim() ?? "";
  const select = app.querySelector<HTMLSelectElement>("select");
  const asset = select?.selectedOptions[0]?.textContent?.trim() ?? "";
  const symbol = asset.split(/\s/)[0] ?? asset;
  const memoInput = [...form.querySelectorAll<HTMLInputElement>('input[type="text"]')].find(
    (i) => !i.placeholder.startsWith("otl_") && !i.closest(".amount-field")
  );
  const memo = memoInput?.value.trim() ?? "";
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
  title.textContent = t(mode === "private" ? "mobile.reviewPrivateTitle" : "mobile.reviewTitle");
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
  rows.append(row(t("mobile.reviewTo"), addressNode(recipient), "rv-to"));
  if (network) rows.append(row(t("settings.network"), network));
  rows.append(
    row(t("mobile.reviewPrivacy"), t(mode === "private" ? "mobile.reviewPrivate" : "mobile.reviewPublic"), mode === "private" ? "rv-priv" : "")
  );
  if (memo) rows.append(row(t("mobile.reviewMemo"), memo));

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "primary";
  confirm.textContent = t("mobile.reviewConfirm");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = t("common.cancel");
  card.append(title, big, rows, confirm, cancel);
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
      const mode = kind(button);
      if (!mode) return;
      if (button.dataset.reviewed) {
        delete button.dataset.reviewed;
        return; // confirmed: the shared handler sends
      }
      const form = button.parentElement;
      const recipient = form?.querySelector<HTMLInputElement>('input[placeholder^="otl_"]')?.value.trim();
      const amount = form?.querySelector<HTMLInputElement>(".amount-field input")?.value.trim();
      // Incomplete: let the shared screen say what's missing.
      // (Any non-zero digit counts as an amount: "1,000" must still be reviewed, not skipped.)
      if (!recipient || !amount || !/[1-9]/.test(amount)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      tick();
      void open(button, mode, deps);
    },
    true
  );
}
