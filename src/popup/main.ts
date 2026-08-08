import "./styles.css";
import type { AccountSummary, DaemonAccountOption, PendingApproval, PopupRequest, TransactionHistoryEntry, WalletStatus } from "../lib/messages";
import { isPlausibleMnemonic } from "../lib/cipherSeed";
import { AUTO_LOCK_OPTIONS, formatAutoLockOption } from "../lib/autoLock";
import { summarizeArgs, summarizeInstruction } from "../lib/instructionSummary";
import { avatarSvg } from "../lib/avatar";
import { estimatePasswordStrength, isBlockedPassword } from "../lib/passwordStrength";
import { qrCodeSvg } from "../lib/qr";
import {
  type Balance,
  MAX_DAEMON_LABEL_LENGTH,
  TARI_RESOURCE_ADDRESS,
  deriveWebUiApiKeysUrl,
  formatBalanceAmount,
  formatBalanceAmountGrouped,
  isValidComponentAddress,
  isValidOotleWalletAddress,
  normalizeDaemonUrl,
  parseDecimalToRaw,
  resourceLabel,
  shortAddr,
  tokenInitial,
} from "./format";

const app = document.getElementById("app")!;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendOnce<T>(message: PopupRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: { ok: boolean; result?: T; error?: string }) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) reject(new Error(response?.error ?? "Unknown error"));
      else resolve(response.result as T);
    });
  });
}

// A freshly-opened popup can win the race against the background service worker waking from a
// cold start (Chrome tears MV3 workers down after ~30s idle) — the very first message sent can
// fail with "Could not establish connection. Receiving end does not exist." even though the
// worker comes up a beat later. Retrying that specific, transient failure a couple of times
// (not other errors, which are real and should surface immediately) rides out the gap invisibly.
async function send<T = unknown>(message: PopupRequest, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendOnce<T>(message);
    } catch (e) {
      const isColdStartRace = e instanceof Error && e.message.includes("Receiving end does not exist");
      if (!isColdStartRace || attempt >= retries) throw e;
      await sleep(200 * (attempt + 1));
    }
  }
}

// Feather Icons (MIT) path data, inlined as raw SVG markup — `h()` can't build real SVG elements
// (document.createElement has no SVG namespace), but the HTML parser used by innerHTML handles
// inline <svg> fine, and these are fixed, non-user-controlled strings.
const ICON_ARROW_UP = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';
const ICON_ARROW_DOWN = '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>';
const ICON_PLUS = '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
const ICON_CHEVRON_RIGHT = '<polyline points="9 18 15 12 9 6"/>';
const ICON_CHEVRON_DOWN = '<polyline points="6 9 12 15 18 9"/>';
const ICON_COPY =
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
const ICON_SETTINGS =
  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
const ICON_CLOCK = '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>';
const ICON_REFRESH =
  '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>';
const ICON_LOCK = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
const ICON_UNLOCK = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>';
const ICON_EXTERNAL_LINK =
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>';
const ICON_USER_PLUS =
  '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="17" y1="11" x2="23" y2="11"/>';
const ICON_SERVER = '<rect x="2" y="3" width="20" height="8" rx="2" ry="2"/><rect x="2" y="13" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/>';
const ICON_GLOBE =
  '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>';
const ICON_BOOK =
  '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>';
const ICON_KEY =
  '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>';
const ICON_INBOX = '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>';

function icon(paths: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "icon-svg";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return span;
}

// Deterministic per-address avatar (see src/lib/avatar.ts for why) -- innerHTML here is safe the
// same way `icon()` above is: the SVG markup comes entirely from our own generator over data this
// extension already computed (the account's own address), never from a page or dApp.
function accountAvatar(address: string | null, size = 44): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "avatar";
  div.style.width = `${size}px`;
  div.style.height = `${size}px`;
  if (address) {
    div.innerHTML = avatarSvg(address, size);
  } else {
    div.textContent = "T";
  }
  return div;
}

/** A "nothing here yet" placeholder with a supporting icon, not just flat centered text -- used
 * everywhere a list can legitimately be empty (history, balances, address book, ...). */
function emptyState(message: string, iconPaths: string): HTMLElement {
  return h("div", { class: "empty-state" }, [
    h("div", { class: "empty-state-icon", "aria-hidden": "true" }, [icon(iconPaths)]),
    h("div", { class: "muted" }, [message]),
  ]);
}

function skeletonBalanceRow(): HTMLElement {
  return h("div", { class: "balance-row" }, [
    h("div", { class: "balance-left" }, [
      h("span", { class: "token-avatar skeleton", style: "width:28px;height:28px" }, [""]),
      h("span", { class: "skeleton", style: "display:inline-block;width:64px;height:13px" }, [""]),
    ]),
    h("span", { class: "skeleton", style: "display:inline-block;width:46px;height:13px" }, [""]),
  ]);
}

/** A title+subtitle shimmer row, matching skeletonBalanceRow's convention -- for any list-row-info
 * screen fetching data after its first paint (history, connected sites), instead of a plain
 * "Loading…" line that gives no sense of the eventual layout. */
function skeletonListRow(): HTMLElement {
  return h("div", { class: "balance-row" }, [
    h("span", { class: "skeleton", style: "width:28px;height:28px;border-radius:50%;flex-shrink:0" }, [""]),
    h("div", { class: "list-row-info", style: "display:flex;flex-direction:column;gap:5px" }, [
      h("span", { class: "skeleton", style: "display:inline-block;width:90px;height:13px" }, [""]),
      h("span", { class: "skeleton", style: "display:inline-block;width:140px;height:11px" }, [""]),
    ]),
  ]);
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

// Every screen swap replays a short fade/slide-in on #app — restarting a CSS animation requires a
// reflow between removing and re-adding its class, since re-adding the same class name alone is a
// no-op as far as the browser's style engine is concerned.
function render(...nodes: (Node | string)[]) {
  app.replaceChildren(...nodes);
  app.classList.remove("view-enter");
  void app.offsetWidth;
  app.classList.add("view-enter");
}

/** Copies `text` and flashes `label`'s text to "Copied!" for a beat, then restores it. */
async function copyToClipboard(text: string, label: HTMLElement) {
  // Clipboard permission denied/unavailable is rare in an extension's own popup, but silently
  // doing nothing on click reads as a broken button, not a failed copy -- flash a clear message
  // either way rather than only on success. aria-live so a screen-reader user actually hears the
  // outcome, not just sighted users watching the text change.
  label.setAttribute("aria-live", "polite");
  let message: string;
  try {
    await navigator.clipboard.writeText(text);
    message = "Copied!";
  } catch {
    message = "Couldn't copy";
  }
  const original = label.textContent;
  label.textContent = message;
  label.classList.remove("copy-flash");
  void label.offsetWidth;
  label.classList.add("copy-flash");
  setTimeout(() => {
    label.textContent = original;
    label.classList.remove("copy-flash");
  }, 1200);
}

/** Swaps a submit button's own label to `busyLabel` and disables it while an async action runs,
 * restoring the original label after -- previously every submit button just grayed out while a
 * separate status line below said "Submitting…", so the button itself looked inert rather than
 * busy. Assumes a plain-text button (no icon children) -- every submit button this is used on is. */
function setBusy(btn: HTMLButtonElement, busy: boolean, busyLabel = "Working…") {
  if (busy) {
    btn.dataset.label ??= btn.textContent ?? "";
    btn.disabled = true;
    btn.textContent = busyLabel;
  } else {
    btn.disabled = false;
    if (btn.dataset.label !== undefined) btn.textContent = btn.dataset.label;
  }
}

/**
 * Replaces `button` with an inline "are you sure?" prompt on its first click, only calling
 * `action` if the user then confirms -- Cancel restores `button` exactly as it was. For actions
 * that previously fired on a single click (remove address-book entry, disconnect daemon/site):
 * easy to redo, but a stray click shouldn't be able to do them with zero friction either.
 */
function confirmThenRun(button: HTMLButtonElement, message: string, confirmLabel: string, action: () => void | Promise<void>) {
  button.addEventListener("click", () => {
    const yes = h("button", { class: "primary btn-compact" }, [confirmLabel]);
    const no = h("button", { class: "secondary btn-compact" }, ["Cancel"]);
    const prompt = h("div", { class: "inline-confirm" }, [
      h("div", { class: "muted", style: "margin-bottom:6px" }, [message]),
      h("div", { class: "row", style: "gap:8px" }, [yes, no]),
    ]);
    yes.addEventListener("click", () => void action());
    no.addEventListener("click", () => prompt.replaceWith(button));
    button.replaceWith(prompt);
  });
}

/** Toggles a green/red border on `input` as the user types, once there's something to judge — a
 * wrong recipient address here is unrecoverable-funds territory, so catching it before submit
 * (rather than only on click) is worth the couple of lines. Empty stays neutral (no judgment on a
 * field nobody's touched yet). */
function wireLiveValidation(input: HTMLInputElement, isValid: (value: string) => boolean) {
  const update = () => {
    const value = input.value.trim();
    input.classList.toggle("input-valid", value.length > 0 && isValid(value));
    input.classList.toggle("input-invalid", value.length > 0 && !isValid(value));
  };
  input.addEventListener("input", update);
  update();
}

/**
 * The first status/account fetch after unlocking (or creating a wallet, or adding an account)
 * triggers on-chain key derivation the background service worker hasn't done yet — a lazy-loaded
 * ~1.4MB WASM signing module has to load and instantiate before it resolves. Without this, that
 * gap between click and the next screen looks identical to the extension being stuck.
 */
function renderLoading(message = "Loading…") {
  render(h("div", { class: "loading" }, [h("div", { class: "spinner" }), h("div", { class: "muted" }, [message])]));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function main() {
  const hash = window.location.hash; // "#/approve/<id>"
  const approveMatch = hash.match(/^#\/approve\/(.+)$/);
  if (approveMatch) {
    await renderApprovalFlow(approveMatch[1]!);
    return;
  }

  renderLoading();
  const status = await send<WalletStatus>({ kind: "popup-get-status" });
  if (!status.hasWallet) renderWelcome();
  else if (!status.isUnlocked) renderUnlock(undefined, status.lastKnownAddress);
  else await renderHome(status);
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function renderWelcome() {
  render(
    h("div", { class: "welcome-hero" }, [
      h("img", { src: "icons/icon128.png", width: "56", height: "56", alt: "" }),
      h("h1", {}, ["Sapient", h("span", {}, [" Wallet"])]),
      h("p", { class: "muted" }, [
        "A self-custody wallet for Tari Ootle. Your seed never leaves this browser and no wallet daemon is required.",
      ]),
    ]),
    h("button", { class: "primary", id: "create" }, ["Create New Wallet"]),
    h("button", { class: "secondary", id: "import" }, ["Import Existing Wallet"])
  );
  document.getElementById("create")!.addEventListener("click", () => renderSetPassword("create"));
  document.getElementById("import")!.addEventListener("click", () => renderSetPassword("import"));
}

function renderSetPassword(mode: "create" | "import") {
  const title = mode === "create" ? "Create a password" : "Import wallet";
  const wrap = h("div", {}, [
    h("h1", {}, [title]),
    h("p", { class: "muted" }, ["This password encrypts your seed on this device. There is no way to recover it if you forget it."]),
  ]);

  let mnemonicTextarea: HTMLTextAreaElement | null = null;
  const mnemonicField =
    mode === "import"
      ? (() => {
          const label = h("label", {}, ["24-word recovery phrase"]);
          const ta = h("textarea", { id: "mnemonic", placeholder: "word1 word2 word3 ...", maxlength: "1000" }) as HTMLTextAreaElement;
          mnemonicTextarea = ta;
          return [label, ta];
        })()
      : [];

  const pwLabel = h("label", {}, ["Password"]);
  const pw = h("input", { type: "password", id: "pw", maxlength: "256" });
  const meterBar = h("div", { class: "strength-meter-fill" }, []);
  const meterLabel = h("div", { class: "muted", style: "font-size:12px;margin-top:2px" }, [""]);
  const meter = h("div", { class: "strength-meter", style: "display:none" }, [meterBar]);
  const pw2Label = h("label", {}, ["Confirm password"]);
  const pw2 = h("input", { type: "password", id: "pw2", maxlength: "256" });
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const submit = h("button", { class: "primary", id: "submit" }, [mode === "create" ? "Create Wallet" : "Import Wallet"]);
  const back = h("button", { class: "secondary", id: "back" }, ["Back"]);

  wrap.append(...mnemonicField, pwLabel, pw, meter, meterLabel, pw2Label, pw2, statusEl, submit, back);
  render(wrap);

  // Focus the first field the user actually needs to fill in -- the mnemonic textarea for
  // Import (it comes first in the form), otherwise the password field.
  (mnemonicTextarea ?? (pw as HTMLInputElement)).focus();
  const submitOnEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") document.getElementById("submit")!.click();
  };
  pw.addEventListener("keydown", submitOnEnter);
  pw2.addEventListener("keydown", submitOnEnter);

  // Live, advisory-only feedback (SECURITY_AUDIT.md §7) — the actual gate against a known-common
  // or trivially-patterned password happens at submit time in isBlockedPassword(), below.
  const STRENGTH_COLORS = ["var(--bad)", "var(--bad)", "var(--fair)", "var(--highlight)", "var(--good)"];
  pw.addEventListener("input", () => {
    const value = (pw as HTMLInputElement).value;
    if (!value) {
      meter.style.display = "none";
      meterLabel.textContent = "";
      return;
    }
    const { score, label, feedback } = estimatePasswordStrength(value);
    meter.style.display = "block";
    meterBar.style.width = `${((score + 1) / 5) * 100}%`;
    meterBar.style.background = STRENGTH_COLORS[score]!;
    meterLabel.textContent = feedback.length > 0 ? `${label} — ${feedback[0]}` : label;
  });

  document.getElementById("back")!.addEventListener("click", renderWelcome);
  document.getElementById("submit")!.addEventListener("click", async () => {
    const password = (document.getElementById("pw") as HTMLInputElement).value;
    const password2 = (document.getElementById("pw2") as HTMLInputElement).value;
    const showStatus = (msg: string) => {
      statusEl.textContent = msg;
      statusEl.className = "status err";
      statusEl.style.display = "block";
    };
    if (password.length < 8) return showStatus("Password must be at least 8 characters.");
    // PBKDF2's cost scales with iteration count, not input length, but hashing a pathologically
    // long input (e.g. an accidentally-pasted file) still means a real multi-second UI stall for no
    // security benefit past a reasonable length — 256 chars is generous for an actual passphrase.
    if (password.length > 256) return showStatus("Password must be 256 characters or fewer.");
    if (isBlockedPassword(password)) {
      return showStatus("This password is too common or predictable — choose something a stranger couldn't guess in a few tries.");
    }
    if (password !== password2) return showStatus("Passwords do not match.");

    try {
      if (mode === "create") {
        const { mnemonic } = await send<{ mnemonic: string }>({ kind: "popup-create-wallet", password });
        renderBackupMnemonic(mnemonic);
      } else {
        const mnemonic = (document.getElementById("mnemonic") as HTMLTextAreaElement).value.trim();
        if (!isPlausibleMnemonic(mnemonic)) return showStatus("That recovery phrase doesn't look valid — check spelling and word count.");
        await send({ kind: "popup-import-wallet", password, mnemonic });
        renderLoading("Deriving your account…");
        const status = await send<WalletStatus>({ kind: "popup-get-status" });
        await renderHome(status);
      }
    } catch (e) {
      render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
    }
  });
}

function renderBackupMnemonic(mnemonic: string) {
  const words = mnemonic.split(" ");
  const grid = h(
    "div",
    { class: "mnemonic-grid" },
    words.map((w, i) => h("div", { class: "mnemonic-word" }, [h("span", {}, [String(i + 1)]), w]))
  );
  const confirm = h("button", { class: "primary", id: "confirm" }, ["I've saved my recovery phrase"]);
  render(
    h("h1", {}, ["Save your recovery phrase"]),
    h("p", { class: "muted" }, [
      "Write down these 24 words in order and store them somewhere safe. Anyone with this phrase can spend your funds. It will not be shown again.",
    ]),
    grid,
    confirm
  );
  document.getElementById("confirm")!.addEventListener("click", () => renderVerifyMnemonic(mnemonic));
}

/**
 * A spot-check before finishing wallet creation: this is the single highest-consequence screen in
 * the whole app (lose this phrase, lose the funds, permanently), and the previous flow trusted the
 * user's unverified claim that they'd saved it. Every major wallet (MetaMask, Phantom, Rainbow)
 * gates past their equivalent screen the same way. Import needs no equivalent check -- typing the
 * full 24 words back in from the user's own records already proves they have it saved elsewhere.
 */
function renderVerifyMnemonic(mnemonic: string) {
  const words = mnemonic.split(" ");
  const indices = new Set<number>();
  while (indices.size < 3) indices.add(Math.floor(Math.random() * words.length));
  // Sorted so the fields read in phrase order -- easier to answer in one pass than a shuffled order.
  const fields = [...indices].sort((a, b) => a - b).map((i) => ({
    index: i,
    input: h("input", { type: "text", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement,
  }));

  const statusEl = h("div", { class: "status err", id: "status", style: "display:none" });
  const back = h("button", { class: "secondary", id: "back" }, ["← Back to recovery phrase"]);
  const confirm = h("button", { class: "primary", id: "confirm" }, ["Confirm"]);

  render(
    h("h1", {}, ["Verify your recovery phrase"]),
    h("p", { class: "muted" }, ["Enter the requested words below to confirm you've saved them correctly."]),
    ...fields.flatMap(({ index, input }) => [h("label", {}, [`Word #${index + 1}`]), input]),
    statusEl,
    confirm,
    back
  );

  document.getElementById("back")!.addEventListener("click", () => renderBackupMnemonic(mnemonic));
  document.getElementById("confirm")!.addEventListener("click", async () => {
    const allCorrect = fields.every(({ index, input }) => input.value.trim().toLowerCase() === words[index]!.toLowerCase());
    if (!allCorrect) {
      statusEl.textContent = "One or more words don't match — double check what you wrote down, or go back to view the phrase again.";
      statusEl.style.display = "block";
      return;
    }
    renderLoading("Deriving your account…");
    try {
      const status = await send<WalletStatus>({ kind: "popup-get-status" });
      await renderHome(status);
    } catch (e) {
      render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
    }
  });
}

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------

function renderUnlock(onUnlocked?: () => void, lastKnownAddress?: string | null) {
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const forgotLink = h("button", { class: "link-btn", id: "forgot" }, ["Forgot password?"]);
  render(
    // The real per-account identicon when known (cached in plaintext from the last unlock -- see
    // WalletState.lastKnownAddress's doc comment), so a returning user can spot "wrong
    // wallet/device" the same way MetaMask's lock screen lets them -- otherwise a generic
    // placeholder, since the address genuinely can't be known before the seed is decrypted (a
    // fresh install, or a wallet that's never been unlocked in this browser instance yet).
    h("div", { class: "hero" }, [accountAvatar(lastKnownAddress ?? null)]),
    h("h1", { style: "text-align:center" }, ["Welcome back"]),
    h("label", {}, ["Password"]),
    h("input", { type: "password", id: "pw", maxlength: "256", autofocus: "true" }),
    statusEl,
    h("button", { class: "primary", id: "unlock" }, ["Unlock"]),
    forgotLink
  );
  const pw = document.getElementById("pw") as HTMLInputElement;
  pw.focus();
  pw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("unlock")!.click();
  });
  document.getElementById("unlock")!.addEventListener("click", async () => {
    try {
      await send({ kind: "popup-unlock", password: pw.value });
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      statusEl.className = "status err";
      statusEl.style.display = "block";
      return;
    }
    // Past this point the password was correct, so failures are no longer about this form —
    // `statusEl` is about to be replaced by renderLoading() and can't show them anymore.
    renderLoading("Deriving your account…");
    try {
      if (onUnlocked) {
        onUnlocked();
      } else {
        const status = await send<WalletStatus>({ kind: "popup-get-status" });
        await renderHome(status);
      }
    } catch (e) {
      render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
    }
  });
  forgotLink.addEventListener("click", renderForgotPassword);
}

// A locked wallet with a forgotten password was previously a dead end — `popup-reset-wallet`
// existed (wired from Settings) but nothing reachable from the lock screen itself could ever
// call it, so there was no way back in without knowing devtools/chrome://extensions storage
// wiping. This is the escape hatch, gated behind a typed confirmation (not just a click) since
// it's irreversible and destroys the local seed if it isn't backed up elsewhere.
function renderForgotPassword() {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);
  const confirmInput = h("input", { type: "text", id: "confirm", placeholder: "RESET", maxlength: "16" });
  const resetBtn = h("button", { class: "danger", id: "reset", disabled: "true" }, ["Erase this wallet"]);
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });

  render(
    h("h1", {}, ["Forgot password?"]),
    h("p", { class: "muted" }, [
      "There's no password recovery for a self-custody wallet — resetting ",
      h("b", {}, ["permanently erases this wallet from this device"]),
      ", including every local account. You can only get back in afterward by importing your 24-word recovery phrase, so make sure you have it before continuing.",
    ]),
    h("label", {}, ['Type "RESET" to confirm']),
    confirmInput,
    statusEl,
    resetBtn,
    back
  );

  document.getElementById("back")!.addEventListener("click", () => renderUnlock());
  confirmInput.addEventListener("input", () => {
    (resetBtn as HTMLButtonElement).disabled = (confirmInput as HTMLInputElement).value !== "RESET";
  });
  resetBtn.addEventListener("click", async () => {
    try {
      await send({ kind: "popup-reset-wallet" });
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      statusEl.className = "status err";
      statusEl.style.display = "block";
      return;
    }
    renderWelcome();
  });
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function activeAccountSummary(status: WalletStatus): AccountSummary | undefined {
  return status.accounts.find((a) => a.id === status.activeAccountId);
}

async function renderHome(status: WalletStatus) {
  const activeLabel = activeAccountSummary(status)?.label ?? "Account";
  const accountPill = h("button", { class: "account-pill", "aria-label": `Switch account (current: ${activeLabel})` }, [
    activeLabel,
    icon(ICON_CHEVRON_DOWN),
  ]);
  const settingsBtn = h(
    "button",
    { class: "secondary", id: "settingsBtn", style: "width:auto;padding:6px 10px;margin-top:0", "aria-label": "Settings" },
    [icon(ICON_SETTINGS)]
  );
  const nav = h("div", { class: "top-nav" }, [
    h("h1", {}, ["Sapient", h("span", {}, [" Wallet"])]),
    h("div", { class: "row", style: "gap:6px" }, [accountPill, settingsBtn]),
  ]);
  accountPill.addEventListener("click", () => renderAccountSwitcher(status));
  settingsBtn.addEventListener("click", () => renderSettings(status));

  if (status.activeAccountError) {
    const switchBtn = h("button", { class: "primary", id: "switchAccount" }, ["Switch account"]);
    render(
      nav,
      h("div", { class: "status err" }, [
        `Couldn't reach "${activeLabel}": ${status.activeAccountError}`,
      ]),
      switchBtn
    );
    switchBtn.addEventListener("click", () => renderAccountSwitcher(status));
    return;
  }

  // The wallet (otl_esm_...) address, not the component address -- same reasoning as the Receive
  // screen: it's the one safe to publish/reuse (stealth payments derive a fresh one-time on-chain
  // key per payment off it), and it's now sufficient for a sender to use for a plain send too (see
  // componentAddressFromWalletAddress). The component address stays reachable from Receive's
  // "Advanced" disclosure for anything that still needs it.
  const copyLabel = h("span", {}, [shortAddr(status.receiveAddress ?? "", 8)]);
  const addrPill = h("button", { class: "addr-pill", id: "addrPill", "aria-label": "Copy wallet address" }, [
    copyLabel,
    h("span", { class: "icon", "aria-hidden": "true" }, [icon(ICON_COPY)]),
  ]);
  addrPill.addEventListener("click", () => copyToClipboard(status.receiveAddress ?? "", copyLabel));
  const heroBalanceAmount = h("span", { class: "hero-balance-amount skeleton", style: "display:inline-block;width:90px;height:26px" }, [""]);
  const heroBalance = h("div", { class: "hero-balance" }, [heroBalanceAmount, h("span", { class: "hero-balance-unit" }, ["XTR"])]);
  // Hidden until updateHeroBalance() knows whether there's actually a private balance to show --
  // a permanent "Private: 0" line under every account would just be noise for one that's never
  // shielded anything.
  const heroPrivateBalance = h("div", { class: "private-balance", style: "display:none;margin-top:2px" }, [""]);
  const summaryHead = h("div", { class: "summary-head" }, [accountAvatar(status.address, 32), addrPill]);
  const summaryBalance = h("div", { class: "summary-balance" }, [
    h("div", { class: "summary-label" }, ["Total Balance"]),
    heroBalance,
    heroPrivateBalance,
  ]);
  const hero = h("div", { class: "account-summary card" }, [summaryHead, summaryBalance]);

  const sendActionBtn = h("button", { class: "action-btn", id: "sendAction" }, [h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_ARROW_UP)]), "Send"]);
  const receiveActionBtn = h("button", { class: "action-btn", id: "receiveAction" }, [
    h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_ARROW_DOWN)]),
    "Receive",
  ]);
  const claimActionBtn = h("button", { class: "action-btn", id: "claimAction" }, [
    h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_PLUS)]),
    "Claim XTR",
  ]);
  const historyActionBtn = h("button", { class: "action-btn", id: "historyAction" }, [
    h("div", { class: "action-icon", "aria-hidden": "true" }, [icon(ICON_CLOCK)]),
    "History",
  ]);
  const actionRow = h("div", { class: "action-row" }, [sendActionBtn, receiveActionBtn, claimActionBtn, historyActionBtn]);

  const homeStatusEl = h("div", { class: "status", id: "homeStatus", style: "display:none" });

  // Rescanning needs this account's own view key (see OotleAccount.scanForPrivatePayments()) --
  // unavailable for a daemon-relayed account, same gating Shield/Unshield/Send-privately use.
  const isLocalAccount = status.accounts.find((a) => a.id === status.activeAccountId)?.kind === "local";
  const rescanControl = isLocalAccount ? buildRescanControl() : null;
  const balancesTitleRow = h("div", { class: "row", style: "justify-content:space-between;align-items:center;margin:2px 0 0" }, [
    h("div", { class: "section-title", style: "margin:0" }, ["Assets"]),
    ...(rescanControl ? [rescanControl.button] : []),
  ]);
  const balancesCard = h("div", { class: "card balances-card" }, [skeletonBalanceRow(), skeletonBalanceRow()]);

  render(
    nav,
    hero,
    actionRow,
    homeStatusEl,
    balancesTitleRow,
    ...(rescanControl ? [rescanControl.statusEl] : []),
    balancesCard
  );

  const updateHeroBalance = (balances: Balance[]) => {
    const xtr = balances.find((b) => b.resourceAddress === TARI_RESOURCE_ADDRESS);
    heroBalanceAmount.className = "hero-balance-amount";
    heroBalanceAmount.removeAttribute("style");
    heroBalanceAmount.textContent = formatBalanceAmountGrouped(xtr?.amount ?? "0", xtr?.divisibility ?? 6);

    const privateAmount = BigInt(xtr?.confidentialAmount ?? "0");
    if (privateAmount > 0n) {
      heroPrivateBalance.style.display = "block";
      heroPrivateBalance.textContent = `${formatBalanceAmountGrouped(privateAmount.toString(), xtr?.divisibility ?? 6)} XTR private`;
    } else {
      heroPrivateBalance.style.display = "none";
    }
  };

  sendActionBtn.addEventListener("click", async () => {
    try {
      const balances = await send<Balance[]>({ kind: "popup-get-balances" });
      renderSend(status, balances);
    } catch (e) {
      homeStatusEl.style.display = "block";
      homeStatusEl.className = "status err";
      homeStatusEl.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  receiveActionBtn.addEventListener("click", () => renderReceive(status));
  historyActionBtn.addEventListener("click", () => renderHistory(status));
  claimActionBtn.addEventListener("click", async () => {
    claimActionBtn.setAttribute("disabled", "true");
    homeStatusEl.style.display = "block";
    homeStatusEl.className = "status";
    homeStatusEl.textContent = "Claiming from the testnet faucet — this submits a real transaction, usually takes a few seconds…";
    try {
      await send({ kind: "popup-claim-testnet-xtr" });
      homeStatusEl.className = "status ok";
      homeStatusEl.textContent = "Claimed! Refreshing balances…";
      const balances = await send<Balance[]>({ kind: "popup-get-balances" });
      renderBalances(balancesCard, balances, status);
      updateHeroBalance(balances);
      homeStatusEl.textContent = "Claimed testnet XTR.";
      // Success is transient (matches Send/Shield/Unshield fading back to Home) -- an error stays
      // put below since the user may still need to act on it.
      setTimeout(() => {
        if (homeStatusEl.className === "status ok") homeStatusEl.style.display = "none";
      }, 4000);
    } catch (e) {
      homeStatusEl.className = "status err";
      homeStatusEl.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      claimActionBtn.removeAttribute("disabled");
    }
  });

  try {
    const balances = await send<Balance[]>({ kind: "popup-get-balances" });
    renderBalances(balancesCard, balances, status);
    updateHeroBalance(balances);
  } catch (e) {
    balancesCard.replaceChildren(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
    heroBalanceAmount.className = "hero-balance-amount";
    heroBalanceAmount.removeAttribute("style");
    heroBalanceAmount.textContent = "—";
  }
}

function settingsRow(id: string, label: string, leadingIcon: string, trailing?: string): HTMLButtonElement {
  return h("button", { class: "settings-row", id }, [
    h("span", { class: "settings-row-left" }, [icon(leadingIcon), label]),
    h("span", { class: "settings-row-right" }, [
      trailing ? h("span", { class: "settings-row-trailing" }, [trailing]) : "",
      icon(ICON_CHEVRON_RIGHT),
    ]),
  ]);
}

function renderSettings(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);
  const addAccountBtn = settingsRow("addAccount", "Add account", ICON_USER_PLUS);
  const connectDaemonBtn = settingsRow("connectDaemon", "Connect daemon wallet", ICON_SERVER);
  const daemonsBtn = settingsRow("daemons", "Daemon connections", ICON_SERVER, String(status.daemonConnections.length));
  const sitesBtn = settingsRow("sites", "Connected sites", ICON_GLOBE);
  const addressBookBtn = settingsRow("addressBook", "Address book", ICON_BOOK, String(status.addressBook.length));
  const backupBtn = settingsRow("backup", "Reveal recovery phrase", ICON_KEY);
  const lockBtn = h("button", { class: "danger", id: "lock" }, ["Lock wallet"]);

  const autoLockSelect = h(
    "select",
    { id: "autoLock", class: "settings-row-select", "aria-label": "Auto-lock after" },
    AUTO_LOCK_OPTIONS.map((minutes) =>
      h("option", { value: String(minutes), ...(minutes === status.autoLockMinutes ? { selected: "true" } : {}) }, [
        formatAutoLockOption(minutes),
      ])
    )
  );
  const autoLockRow = h("div", { class: "settings-row settings-row-static" }, [
    h("span", {}, ["Auto-lock after"]),
    autoLockSelect,
  ]);

  const NETWORK_OPTIONS: { value: "esmeralda" | "igor"; label: string }[] = [
    { value: "esmeralda", label: "Esmeralda" },
    { value: "igor", label: "Igor" },
  ];
  const networkSelect = h(
    "select",
    { id: "network", class: "settings-row-select", "aria-label": "Network" },
    NETWORK_OPTIONS.map((opt) =>
      h("option", { value: opt.value, ...(opt.value === status.network ? { selected: "true" } : {}) }, [opt.label])
    )
  );
  const networkRow = h("div", { class: "settings-row settings-row-static" }, [h("span", {}, ["Network"]), networkSelect]);
  const networkConfirmEl = h("div", { class: "status", style: "display:none" });

  render(
    h("h1", {}, ["Settings"]),
    back,
    h("div", { class: "card settings-card" }, [
      addAccountBtn,
      connectDaemonBtn,
      daemonsBtn,
      sitesBtn,
      addressBookBtn,
      backupBtn,
      autoLockRow,
      networkRow,
    ]),
    networkConfirmEl,
    lockBtn
  );

  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
  document.getElementById("lock")!.addEventListener("click", async () => {
    await send({ kind: "popup-lock" });
    renderUnlock(undefined, status.address);
  });
  autoLockSelect.addEventListener("change", () => {
    void send({ kind: "popup-set-auto-lock-minutes", minutes: Number((autoLockSelect as HTMLSelectElement).value) });
  });
  networkSelect.addEventListener("change", () => {
    const chosen = (networkSelect as HTMLSelectElement).value as "esmeralda" | "igor";
    if (chosen === status.network) {
      networkConfirmEl.style.display = "none";
      return;
    }
    // .primary, not .danger -- switching networks is a reversible settings change, not a
    // destructive action (unlike Lock/Reset, which genuinely warrant the red danger styling).
    const confirmBtn = h("button", { class: "primary btn-compact", style: "margin-right:8px" }, ["Switch"]);
    const cancelBtn = h("button", { class: "secondary btn-compact" }, ["Cancel"]);
    networkConfirmEl.className = "status";
    networkConfirmEl.style.display = "block";
    networkConfirmEl.replaceChildren(
      h("p", { style: "margin:0 0 8px" }, [
        `Switching from ${status.network} to ${chosen} changes which chain your balances and transactions are read from. Your accounts and recovery phrase stay the same.`,
      ]),
      confirmBtn,
      cancelBtn
    );
    cancelBtn.addEventListener("click", () => {
      (networkSelect as HTMLSelectElement).value = status.network;
      networkConfirmEl.style.display = "none";
    });
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.setAttribute("disabled", "true");
      cancelBtn.setAttribute("disabled", "true");
      await send({ kind: "popup-set-network", network: chosen });
      renderLoading("Switching network…");
      const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
      renderSettings(newStatus);
    });
  });
  document.getElementById("addAccount")!.addEventListener("click", async () => {
    await send({ kind: "popup-add-account" });
    renderLoading("Deriving your account…");
    try {
      const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
      await renderHome(newStatus);
    } catch (e) {
      render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
    }
  });
  document.getElementById("connectDaemon")!.addEventListener("click", () => renderConnectDaemon(status));
  document.getElementById("daemons")!.addEventListener("click", () => renderDaemonConnections(status));
  document.getElementById("sites")!.addEventListener("click", renderConnectedSites);
  document.getElementById("addressBook")!.addEventListener("click", () => renderAddressBook(status));
  document.getElementById("backup")!.addEventListener("click", renderRevealMnemonic);
}

// ---------------------------------------------------------------------------
// Send / Receive
// ---------------------------------------------------------------------------

function renderReceive(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);

  // The wallet address (otl_...) is the one to hand out: any sender can derive this account's
  // component address from it for a plain send (see componentAddressFromWalletAddress), AND it's
  // the address stealth-type payments (shield/sendPrivately) key off of -- for those, the network
  // derives a fresh one-time on-chain spend key per payment (payTo defaults to
  // { StealthPublicKey: {} } in createOutput), so this same address can be reused forever without
  // ever letting a chain observer link two payments to each other or to this account. There is no
  // reason to publish the raw component_ address instead -- it buys nothing a sender using this
  // wallet (or anything doing the same otl_-address derivation) needs, and it actively costs
  // privacy for plain sends, which record it on-chain exactly as given.
  const walletLabel = h("span", {}, ["Copy"]);
  const walletCopyBtn = h("button", { class: "icon-btn" }, [icon(ICON_COPY), walletLabel]);
  const walletRow = h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [status.receiveAddress ?? "—"]), walletCopyBtn]);
  walletCopyBtn.addEventListener("click", () => copyToClipboard(status.receiveAddress ?? "", walletLabel));

  const qrCard = h("div", { class: "card qr-card" }, []);
  if (status.receiveAddress) {
    qrCard.innerHTML = qrCodeSvg(status.receiveAddress);
    qrCard.classList.add("qr-card-filled");
  } else {
    qrCard.textContent = "No address available";
  }

  const componentLabel = h("span", {}, ["Copy"]);
  const componentCopyBtn = h("button", { class: "icon-btn" }, [icon(ICON_COPY), componentLabel]);
  const componentRow = h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [status.address ?? "—"]), componentCopyBtn]);
  componentCopyBtn.addEventListener("click", () => copyToClipboard(status.address ?? "", componentLabel));
  const componentDetails = h("div", { class: "card" }, [
    h("details", { class: "raw-details" }, [
      h("summary", {}, ["Advanced: component address"]),
      h("p", { class: "muted", style: "margin:6px 0 10px" }, [
        "Only needed for a tool that can't accept an otl_ address directly. Every payment sent here is a permanent, publicly linkable on-chain record — sharing it undoes the privacy your wallet address already gives you for free.",
      ]),
      componentRow,
    ]),
  ]);

  const isLocalAccount = status.accounts.find((a) => a.id === status.activeAccountId)?.kind === "local";
  const claimCard = isLocalAccount ? buildClaimPrivatePaymentCard(status) : null;

  render(
    h("h1", {}, ["Receive"]),
    h("p", { class: "muted" }, [
      "Share this address to receive any token on Tari Ootle. It's safe to publish and reuse for every payment — private (stealth) transfers derive a fresh one-time key on-chain each time, so they can never be linked to you or to each other.",
    ]),
    h("div", { class: "hero" }, [accountAvatar(status.address)]),
    qrCard,
    h("div", { class: "card" }, [h("div", { class: "muted", style: "margin-bottom:8px" }, ["Wallet address"]), walletRow]),
    componentDetails,
    ...(claimCard ? [claimCard] : []),
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

/**
 * `scanForPrivatePayments()` already runs opportunistically on every popup open (see
 * `buildStatus()`'s doc comment), but only over a shallow, cheap window (3 pages of 50
 * transactions). This triggers the same scan with a much deeper lookback (20×50 = 1000) on
 * demand -- for catching up after the wallet's been closed a while, or just confirming "did that
 * stealth transfer actually arrive" without waiting for the next popup open to notice it.
 */
/**
 * A small icon-button next to the "Assets" title on the home screen (see renderHome) rather than
 * its own screen -- rescanning is something people want to try right where they're already looking
 * at their balance, not a few taps away. `scanForPrivatePayments()` already runs opportunistically
 * on every popup open (see buildStatus()'s doc comment) but only over a shallow window (150
 * transactions); this triggers the same scan with a much deeper lookback (1000) on demand, for
 * catching up after the wallet's been closed a while or just confirming a stealth transfer arrived
 * without waiting for the next popup open to notice it. Returns `{ button, statusEl }` so the
 * caller can lay both out next to the title and under it respectively.
 */
function buildRescanControl(): { button: HTMLElement; statusEl: HTMLElement } {
  const button = h("button", { class: "icon-btn", "aria-label": "Rescan for private payments", title: "Rescan for private payments" }, [
    icon(ICON_REFRESH),
  ]);
  const statusEl = h("div", { class: "muted", style: "display:none;font-size:12px;margin:-4px 0 8px" }, [""]);
  const showStatus = (msg: string) => {
    statusEl.style.display = "block";
    statusEl.textContent = msg;
  };

  button.addEventListener("click", async () => {
    button.setAttribute("disabled", "true");
    showStatus("Scanning recent transactions…");
    try {
      const { claimed } = await send<{ claimed: number }>({ kind: "popup-rescan-private-payments" });
      showStatus(claimed === 0 ? "No new private payments found." : `Found ${claimed} new private ${claimed === 1 ? "payment" : "payments"}!`);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e));
    } finally {
      button.removeAttribute("disabled");
    }
  });

  return { button, statusEl };
}

/**
 * A private send has no scan-by-view-key discovery (see `sendPrivately()`'s doc comment) -- the
 * recipient can only find it by being handed the commitment out of band. This is that hand-off's
 * landing spot: given a resource address + commitment, `claimPrivatePayment()` fetches the
 * on-chain output and tries to decrypt it with this account's own view secret, which both proves
 * ownership and recovers the exact amount in one step -- no need to be told the amount separately,
 * and no risk of typing it wrong. Once claimed, it behaves exactly like a self-shielded output:
 * it shows up in the private balance and in Unshield/Send-privately's picker.
 */
function buildClaimPrivatePaymentCard(status: WalletStatus) {
  const resourceInput = h("input", { type: "text", placeholder: "resource_…", maxlength: "80" }) as HTMLInputElement;
  resourceInput.value = TARI_RESOURCE_ADDRESS;
  const commitmentInput = h("input", { type: "text", placeholder: "64 hex characters", maxlength: "64" });
  const claimBtn = h("button", { class: "secondary" }, ["Claim"]);
  const statusEl = h("div", { class: "status", style: "display:none" });
  const showStatus = (msg: string, cls: "err" | "ok") => {
    statusEl.style.display = "block";
    statusEl.className = `status ${cls}`;
    statusEl.textContent = msg;
  };

  claimBtn.addEventListener("click", async () => {
    const resourceAddress = resourceInput.value.trim();
    const commitment = (commitmentInput as HTMLInputElement).value.trim();
    if (!/^[0-9a-f]{64}$/i.test(commitment)) {
      showStatus("Enter a valid 32-byte commitment (64 hex characters).", "err");
      return;
    }
    setBusy(claimBtn as HTMLButtonElement, true, "Checking…");
    showStatus("Checking…", "ok");
    try {
      await send({ kind: "popup-claim-private-payment", resourceAddress, commitment });
      showStatus("Claimed! It's now part of your private balance.", "ok");
      (commitmentInput as HTMLInputElement).value = "";
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(claimBtn as HTMLButtonElement, false);
    }
  });

  return h("div", { class: "card" }, [
    h("div", { class: "muted", style: "margin-bottom:8px" }, ["Claim a private payment"]),
    h("p", { class: "muted", style: "margin:0 0 8px" }, [
      "If someone sent you a private payment, ask them for the resulting commitment and paste it below — there's no way to discover it automatically.",
    ]),
    h("label", {}, ["Resource address"]),
    resourceInput,
    h("label", {}, ["Commitment (hex)"]),
    commitmentInput,
    statusEl,
    claimBtn,
  ]);
}

const HISTORY_KIND_LABEL: Record<TransactionHistoryEntry["kind"], string> = {
  send: "Sent",
  shield: "Shielded",
  unshield: "Unshielded",
  "send-privately": "Sent privately",
  claim: "Claimed testnet XTR",
  "private-payment-received": "Received privately",
  "dapp-transaction": "App transaction",
};

// Lock/unlock for shield/unshield (a state change in privacy, not a transfer direction) and for
// send-privately/private-payment-received (reinforces which entries are private at a glance,
// rather than relying on reading the label text) -- direction arrows stay reserved for the two
// plain-balance kinds so "money left" vs. "money arrived" is still the first thing that reads.
const HISTORY_KIND_ICON: Record<TransactionHistoryEntry["kind"], string> = {
  send: ICON_ARROW_UP,
  shield: ICON_LOCK,
  unshield: ICON_UNLOCK,
  "send-privately": ICON_LOCK,
  claim: ICON_PLUS,
  "private-payment-received": ICON_UNLOCK,
  "dapp-transaction": ICON_EXTERNAL_LINK,
};

/**
 * Transaction history is recorded client-side, starting from when this feature shipped -- it's
 * not a retroactive reconstruction of everything this account has ever done on-chain (see
 * TransactionHistoryEntry's doc comment in storage.ts for why). Fetches current balances
 * alongside the history list purely for display formatting (symbol/divisibility) — an entry for
 * a resource this account no longer holds still renders, just without those niceties.
 */
async function renderHistory(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);
  const skeleton = h("div", { class: "card history-list" }, [skeletonListRow(), skeletonListRow(), skeletonListRow()]);
  render(h("h1", {}, ["History"]), skeleton, back);
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));

  const [entries, balances] = await Promise.all([
    send<TransactionHistoryEntry[]>({ kind: "popup-get-transaction-history" }),
    send<Balance[]>({ kind: "popup-get-balances" }).catch(() => [] as Balance[]),
  ]);
  const balanceByResource = new Map(balances.map((b) => [b.resourceAddress, b]));

  const list =
    entries.length === 0
      ? emptyState("No transactions yet.", ICON_CLOCK)
      : h(
          "div",
          { class: "card history-list" },
          entries.map((entry) => {
            const b = entry.resourceAddress ? balanceByResource.get(entry.resourceAddress) : undefined;
            const amountText =
              entry.amount && entry.resourceAddress
                ? `${formatBalanceAmountGrouped(entry.amount, b?.divisibility ?? 0)} ${resourceLabel(entry.resourceAddress, b?.symbol ?? null)}`
                : null;
            const when = new Date(entry.createdAt).toLocaleString();
            // dapp-transaction's counterparty is a human sentence ("origin: summary") -- shortAddr()
            // (first-N…last-N) would garble it. Every other kind's counterparty is a real address,
            // where shortAddr() is exactly right. Either way, list-row-subtitle's CSS still wraps
            // instead of overflowing, as a safety net against one unbroken token being too long.
            const counterpartyText = entry.counterparty
              ? entry.kind === "dapp-transaction"
                ? entry.counterparty
                : shortAddr(entry.counterparty)
              : null;
            return h("div", { class: `balance-row${entry.status === "failed" ? " status-failed" : ""}` }, [
              h("div", { class: "history-icon", "aria-hidden": "true" }, [icon(HISTORY_KIND_ICON[entry.kind])]),
              h("div", { class: "list-row-info" }, [
                h("div", {}, [HISTORY_KIND_LABEL[entry.kind], entry.status === "failed" ? " (failed)" : ""]),
                h("div", { class: "muted" }, [amountText ? `${amountText} · ${when}` : when]),
                counterpartyText ? h("div", { class: "list-row-subtitle", title: entry.counterparty ?? "" }, [counterpartyText]) : "",
                entry.memo ? h("div", { class: "list-row-subtitle" }, [`"${entry.memo}"`]) : "",
              ]),
            ]);
          })
        );

  render(h("h1", {}, ["History"]), list, back);
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

/**
 * The single "Send" screen, covering both a plain revealed-balance transfer and a private
 * (stealth-to-stealth) send from behind one tab toggle -- previously two separate screens
 * (renderSend/renderSendPrivately) reached from two separate entry points. The private tab is
 * only shown for local accounts (sendPrivately() has no daemon-account equivalent, same gating
 * Shield/Unshield already use).
 */
function renderSend(
  status: WalletStatus,
  balances: Balance[],
  options?: { initialTab?: "public" | "private"; initialResourceAddress?: string; onBack?: () => void }
) {
  const onBack = options?.onBack ?? (() => renderHome(status));
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);

  if (balances.length === 0) {
    render(h("h1", {}, ["Send"]), h("p", { class: "muted" }, ["You don't hold any tokens yet — claim some testnet XTR first."]), back);
    document.getElementById("back")!.addEventListener("click", onBack);
    return;
  }

  const isLocalAccount = status.accounts.find((a) => a.id === status.activeAccountId)?.kind === "local";

  const publicSection = h("div", {});
  const privateSection = h("div", { style: "display:none" });

  if (!isLocalAccount) {
    render(h("h1", {}, ["Send"]), publicSection, back);
    document.getElementById("back")!.addEventListener("click", onBack);
    buildPublicSendForm(publicSection, balances, status.addressBook);
    return;
  }

  const publicTabBtn = h("button", { class: "tab-btn", role: "tab", "aria-selected": "true" }, ["Send"]);
  const privateTabBtn = h("button", { class: "tab-btn", role: "tab", "aria-selected": "false" }, ["Send privately"]);
  const tabRow = h("div", { class: "tab-row", role: "tablist" }, [publicTabBtn, privateTabBtn]);

  const setTab = (tab: "public" | "private") => {
    publicTabBtn.classList.toggle("active", tab === "public");
    publicTabBtn.setAttribute("aria-selected", String(tab === "public"));
    privateTabBtn.classList.toggle("active", tab === "private");
    privateTabBtn.setAttribute("aria-selected", String(tab === "private"));
    publicSection.style.display = tab === "public" ? "" : "none";
    privateSection.style.display = tab === "private" ? "" : "none";
  };
  publicTabBtn.addEventListener("click", () => setTab("public"));
  privateTabBtn.addEventListener("click", () => setTab("private"));

  render(h("h1", {}, ["Send"]), tabRow, publicSection, privateSection, back);
  document.getElementById("back")!.addEventListener("click", onBack);

  buildPublicSendForm(publicSection, balances, status.addressBook);
  buildPrivateSendForm(privateSection, balances, status.addressBook, options?.initialResourceAddress);
  setTab(options?.initialTab ?? "public");
}

/** A picker of saved address-book entries matching `isMatch`, or `null` if there are none worth
 * showing — selecting an option fills `targetInput`'s value but leaves it freely editable, so
 * manual entry still works exactly as before. */
function buildAddressPicker(
  entries: { id: string; label: string; address: string }[],
  isMatch: (address: string) => boolean,
  targetInput: HTMLElement
): HTMLElement | null {
  const matching = entries.filter((e) => isMatch(e.address));
  if (matching.length === 0) return null;
  const select = h("select", { class: "settings-row-select", style: "margin-bottom:8px", "aria-label": "Choose from address book" }, [
    h("option", { value: "" }, ["Choose from address book…"]),
    ...matching.map((e) => h("option", { value: e.address }, [`${e.label} (${shortAddr(e.address)})`])),
  ]);
  select.addEventListener("change", () => {
    const value = (select as HTMLSelectElement).value;
    if (value) (targetInput as HTMLInputElement).value = value;
  });
  return select;
}

function buildPublicSendForm(container: HTMLElement, balances: Balance[], addressBook: { id: string; label: string; address: string }[]) {
  const tokenSelect = h(
    "select",
    {},
    balances.map((b) => h("option", { value: b.resourceAddress }, [resourceLabel(b.resourceAddress, b.symbol)]))
  );
  const balanceHint = h("div", { class: "muted", style: "margin-top:6px" }, [""]);

  const toInput = h("input", { type: "text", placeholder: "otl_…", maxlength: "200" });
  wireLiveValidation(toInput as HTMLInputElement, isValidOotleWalletAddress);
  const addressPicker = buildAddressPicker(addressBook, isValidOotleWalletAddress, toInput);
  const amountInput = h("input", { type: "text", placeholder: "0.0", maxlength: "40", inputmode: "decimal" });
  const maxBtn = h("button", { class: "max-btn" }, ["MAX"]);
  const amountField = h("div", { class: "amount-field" }, [amountInput, maxBtn]);

  const statusEl = h("div", { class: "status", style: "display:none" });
  const sendBtn = h("button", { class: "primary" }, ["Review & Send"]);

  container.replaceChildren(
    h("label", {}, ["Asset"]),
    tokenSelect,
    balanceHint,
    h("label", {}, ["Recipient address"]),
    ...(addressPicker ? [addressPicker] : []),
    toInput,
    h("label", {}, ["Amount"]),
    amountField,
    statusEl,
    sendBtn
  );

  const selected = () => balances.find((b) => b.resourceAddress === (tokenSelect as HTMLSelectElement).value)!;
  const updateHint = () => {
    const b = selected();
    balanceHint.textContent = `Available: ${formatBalanceAmountGrouped(b.amount, b.divisibility)} ${resourceLabel(b.resourceAddress, b.symbol)}`;
  };
  updateHint();
  tokenSelect.addEventListener("change", updateHint);

  maxBtn.addEventListener("click", () => {
    const b = selected();
    (amountInput as HTMLInputElement).value = formatBalanceAmount(b.amount, b.divisibility);
  });

  const showStatus = (msg: string, cls: "err" | "ok") => {
    statusEl.style.display = "block";
    statusEl.className = `status ${cls}`;
    statusEl.textContent = msg;
  };

  sendBtn.addEventListener("click", async () => {
    const b = selected();
    const toAddress = (toInput as HTMLInputElement).value.trim();
    if (!isValidOotleWalletAddress(toAddress)) {
      showStatus("Enter a valid Ootle wallet address (starts with otl_).", "err");
      return;
    }
    let raw: bigint;
    try {
      raw = parseDecimalToRaw((amountInput as HTMLInputElement).value, b.divisibility);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      return;
    }
    if (raw > BigInt(b.amount)) {
      showStatus("Amount exceeds your available balance.", "err");
      return;
    }

    setBusy(sendBtn as HTMLButtonElement, true, "Sending…");
    showStatus("Submitting — this usually takes a few seconds…", "ok");
    try {
      await send({ kind: "popup-send", recipientWalletAddress: toAddress, resourceAddress: b.resourceAddress, amount: raw.toString() });
      showStatus("Sent!", "ok");
      setTimeout(async () => {
        const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
        await renderHome(newStatus);
      }, 700);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(sendBtn as HTMLButtonElement, false);
    }
  });
}

/**
 * Sends some of this account's total private balance for a resource directly to someone else's
 * Ootle wallet address — private the whole way (unlike Shield, which always targets this same
 * account, and Unshield, which always reveals back to this same account). Which specific shielded
 * output(s) get spent is chosen by the wallet itself (largest-first coin selection — see
 * `resolveSendPrivatelyPlan`), combining more than one into a single transaction if no single
 * output covers the amount, so the user only ever thinks in terms of a total balance and an
 * amount, never individual UTXOs/commitments.
 *
 * Only offers resources with an actual private balance to send from (`confidentialAmount > 0n`)
 * *and* whose resource kind is "Stealth" -- a real Confidential-vault resource (a distinct engine
 * type, see renderTokenDetail's isStealthResource comment) can also carry a nonzero
 * confidentialAmount, but sendPrivately()'s StealthTransfer pipeline only works for Stealth
 * resources and would fail on-chain for one of those. If none exist, shows a hint to shield first
 * rather than an empty picker.
 */
function buildPrivateSendForm(
  container: HTMLElement,
  balances: Balance[],
  addressBook: { id: string; label: string; address: string }[],
  initialResourceAddress?: string
) {
  const privateBalances = balances.filter((b) => b.kind === "Stealth" && BigInt(b.confidentialAmount) > 0n);
  if (privateBalances.length === 0) {
    container.replaceChildren(h("p", { class: "muted" }, ["You don't have a private balance yet — shield some first."]));
    return;
  }

  const resourceSelect = h(
    "select",
    {},
    privateBalances.map((b) => h("option", { value: b.resourceAddress }, [resourceLabel(b.resourceAddress, b.symbol)]))
  );
  if (initialResourceAddress && privateBalances.some((b) => b.resourceAddress === initialResourceAddress)) {
    (resourceSelect as HTMLSelectElement).value = initialResourceAddress;
  }

  const formSection = h("div", { style: "margin-top:10px" });
  const statusEl = h("div", { class: "status", style: "display:none" });
  const showStatus = (msg: string, cls: "err" | "ok") => {
    statusEl.style.display = "block";
    statusEl.className = `status ${cls}`;
    statusEl.textContent = msg;
  };

  // There's no scan-by-view-key API, so the recipient has no way to notice this payment on their
  // own -- surface the new output's commitment so it can be handed to them out of band (they
  // paste it into their own wallet's Receive -> "Claim a private payment" card).
  const showResultSection = (recipientCommitment: string) => {
    statusEl.style.display = "none";
    const copyLabel = h("span", {}, ["Copy"]);
    const copyBtn = h("button", { class: "icon-btn" }, [icon(ICON_COPY), copyLabel]);
    copyBtn.addEventListener("click", () => copyToClipboard(recipientCommitment, copyLabel));
    const doneBtn = h("button", { class: "primary" }, ["Done"]);
    doneBtn.addEventListener("click", async () => {
      const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
      await renderHome(newStatus);
    });
    formSection.replaceChildren(
      h("div", { class: "status ok" }, ["Sent privately!"]),
      h("p", { class: "muted" }, [
        "The recipient can't discover this on their own -- share the commitment below with them directly.",
      ]),
      h("label", {}, ["Commitment"]),
      h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [recipientCommitment]), copyBtn]),
      doneBtn
    );
  };

  container.replaceChildren(h("label", {}, ["Asset"]), resourceSelect, formSection, statusEl);

  const buildForm = (balance: Balance, label: string, maxAmount: bigint) => {
    const recipientInput = h("input", { type: "text", placeholder: "otl_…", maxlength: "200" });
    wireLiveValidation(recipientInput as HTMLInputElement, isValidOotleWalletAddress);
    const addressPicker = buildAddressPicker(addressBook, isValidOotleWalletAddress, recipientInput);
    const amountInput = h("input", { type: "text", placeholder: "0.0", maxlength: "40", inputmode: "decimal" });
    const maxBtn = h("button", { class: "max-btn" }, ["MAX"]);
    const amountField = h("div", { class: "amount-field" }, [amountInput, maxBtn]);
    const hint = h("div", { class: "muted", style: "margin-top:6px" }, [
      `Private balance: ${formatBalanceAmountGrouped(maxAmount.toString(), balance.divisibility)} ${label}`,
    ]);
    const memoInput = h("input", { type: "text", placeholder: "e.g. Payment for invoice #42", maxlength: "200" });
    const submitBtn = h("button", { class: "primary" }, [`Send ${label} privately`]);

    maxBtn.addEventListener("click", () => {
      (amountInput as HTMLInputElement).value = formatBalanceAmount(maxAmount.toString(), balance.divisibility);
    });

    submitBtn.addEventListener("click", async () => {
      const recipientWalletAddress = (recipientInput as HTMLInputElement).value.trim();
      if (!isValidOotleWalletAddress(recipientWalletAddress)) {
        showStatus("Enter a valid Ootle wallet address (starts with otl_).", "err");
        return;
      }
      let raw: bigint;
      try {
        raw = parseDecimalToRaw((amountInput as HTMLInputElement).value, balance.divisibility);
      } catch (e) {
        showStatus(e instanceof Error ? e.message : String(e), "err");
        return;
      }
      if (raw <= 0n) {
        showStatus("Enter an amount greater than zero.", "err");
        return;
      }
      if (raw > maxAmount) {
        showStatus("Amount exceeds your private balance.", "err");
        return;
      }
      setBusy(submitBtn as HTMLButtonElement, true, "Sending…");
      showStatus("Submitting — this usually takes a few seconds…", "ok");
      const memo = (memoInput as HTMLInputElement).value.trim();
      try {
        const { recipientCommitment } = await send<{ transactionId: string; recipientCommitment: string }>({
          kind: "popup-send-privately",
          resourceAddress: balance.resourceAddress,
          recipientWalletAddress,
          amount: raw.toString(),
          memo: memo || undefined,
        });
        showResultSection(recipientCommitment);
      } catch (e) {
        showStatus(e instanceof Error ? e.message : String(e), "err");
        setBusy(submitBtn as HTMLButtonElement, false);
      }
    });

    return [
      h("label", {}, ["Recipient's Ootle wallet address"]),
      ...(addressPicker ? [addressPicker] : []),
      recipientInput,
      h("label", {}, ["Amount"]),
      amountField,
      hint,
      h("label", {}, ["Memo (optional)"]),
      memoInput,
      h("p", { class: "muted", style: "margin:4px 0 0" }, [
        "Only the recipient can decrypt this — but it's stored on-chain (encrypted), so keep it short.",
      ]),
      submitBtn,
    ];
  };

  const loadForm = () => {
    const balance = privateBalances.find((b) => b.resourceAddress === (resourceSelect as HTMLSelectElement).value)!;
    const label = resourceLabel(balance.resourceAddress, balance.symbol);
    formSection.replaceChildren(...buildForm(balance, label, BigInt(balance.confidentialAmount)));
  };

  resourceSelect.addEventListener("change", loadForm);
  loadForm();
}

/**
 * Shields (revealed → private) some amount of one token, always to a NEW stealth output owned
 * by this same account — not a transfer to someone else. Local accounts only: shielding needs
 * this account's own view key/stealth signing, which a daemon-relayed account can't provide (see
 * background/index.ts's popup-shield handler), so this screen should only ever be reached from a
 * local account's token detail.
 */
function renderShield(status: WalletStatus, balance: Balance) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);
  const label = resourceLabel(balance.resourceAddress, balance.symbol);

  const amountInput = h("input", { type: "text", id: "amount", placeholder: "0.0", maxlength: "40", inputmode: "decimal" });
  const maxBtn = h("button", { class: "max-btn", id: "max" }, ["MAX"]);
  const amountField = h("div", { class: "amount-field" }, [amountInput, maxBtn]);
  const balanceHint = h("div", { class: "muted", style: "margin-top:6px" }, [
    `Revealed balance: ${formatBalanceAmountGrouped(balance.amount, balance.divisibility)} ${label}`,
  ]);
  const memoInput = h("input", { type: "text", id: "memo", placeholder: "e.g. Savings", maxlength: "200" });

  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const shieldBtn = h("button", { class: "primary", id: "submit" }, [`Shield ${label}`]);

  render(
    h("h1", {}, ["Shield"]),
    h("p", { class: "muted" }, [
      `Moves some of your revealed (public) ${label} balance into a new private output only you can see. The transaction fee is still paid from your revealed balance.`,
    ]),
    h("label", {}, ["Amount"]),
    amountField,
    balanceHint,
    h("label", {}, ["Memo (optional)"]),
    memoInput,
    h("p", { class: "muted", style: "margin:4px 0 0" }, [
      "A private note attached to this output — encrypted, but stored on-chain, so keep it short.",
    ]),
    statusEl,
    shieldBtn,
    back
  );

  document.getElementById("back")!.addEventListener("click", () => renderTokenDetail(status, balance));

  maxBtn.addEventListener("click", () => {
    (amountInput as HTMLInputElement).value = formatBalanceAmount(balance.amount, balance.divisibility);
  });

  const showStatus = (msg: string, cls: "err" | "ok") => {
    statusEl.style.display = "block";
    statusEl.className = `status ${cls}`;
    statusEl.textContent = msg;
  };

  shieldBtn.addEventListener("click", async () => {
    let raw: bigint;
    try {
      raw = parseDecimalToRaw((amountInput as HTMLInputElement).value, balance.divisibility);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      return;
    }
    if (raw <= 0n) {
      showStatus("Enter an amount greater than zero.", "err");
      return;
    }
    if (raw > BigInt(balance.amount)) {
      showStatus("Amount exceeds your revealed balance.", "err");
      return;
    }

    setBusy(shieldBtn as HTMLButtonElement, true, "Shielding…");
    showStatus("Submitting — this usually takes a few seconds…", "ok");
    const memo = (memoInput as HTMLInputElement).value.trim();
    try {
      await send({ kind: "popup-shield", resourceAddress: balance.resourceAddress, amount: raw.toString(), memo: memo || undefined });
      showStatus("Shielded!", "ok");
      setTimeout(async () => {
        const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
        await renderHome(newStatus);
      }, 700);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(shieldBtn as HTMLButtonElement, false);
    }
  });
}

/**
 * Unshields (private → revealed) some of this account's total private balance for a resource.
 * Which specific shielded output(s) get spent is chosen by the wallet itself (largest-first coin
 * selection — see `resolveUnshieldPlan`), combining more than one into a single transaction if no
 * single output covers the amount, so the user only ever thinks in terms of a total balance and
 * an amount, never individual UTXOs/commitments.
 *
 * The protocol has no way to reveal a shielded balance's *entire* value in one step (confirmed
 * against the SDK's own builder validation, see `OotleAccount.unshield()`'s doc comment) — at
 * least the smallest unit must remain private as change, so MAX caps just under the full balance.
 */
function renderUnshield(status: WalletStatus, balance: Balance) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);
  const label = resourceLabel(balance.resourceAddress, balance.symbol);
  const maxAmount = BigInt(balance.confidentialAmount);

  const amountInput = h("input", { type: "text", id: "amount", placeholder: "0.0", maxlength: "40", inputmode: "decimal" });
  const maxBtn = h("button", { class: "max-btn", id: "max" }, ["MAX"]);
  const amountField = h("div", { class: "amount-field" }, [amountInput, maxBtn]);
  const balanceHint = h("div", { class: "muted", style: "margin-top:6px" }, [
    `Private balance: ${formatBalanceAmountGrouped(maxAmount.toString(), balance.divisibility)} ${label}`,
  ]);
  const memoInput = h("input", { type: "text", id: "memo", placeholder: "e.g. Remaining savings", maxlength: "200" });

  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const submitBtn = h("button", { class: "primary", id: "submit" }, [`Unshield ${label}`]);

  render(
    h("h1", {}, ["Unshield"]),
    h("p", { class: "muted" }, [
      `Moves some of your private ${label} back to your revealed (public) balance. At least the smallest unit must always stay private as change, and the fee is paid from your revealed balance.`,
    ]),
    h("label", {}, ["Amount to reveal"]),
    amountField,
    balanceHint,
    h("label", {}, ["Memo for the remaining private balance (optional)"]),
    memoInput,
    h("p", { class: "muted", style: "margin:4px 0 0" }, [
      "A private note attached to the remaining private output — encrypted, but stored on-chain, so keep it short.",
    ]),
    statusEl,
    submitBtn,
    back
  );

  document.getElementById("back")!.addEventListener("click", () => renderTokenDetail(status, balance));

  maxBtn.addEventListener("click", () => {
    const revealMax = maxAmount - 1n;
    (amountInput as HTMLInputElement).value = revealMax > 0n ? formatBalanceAmount(revealMax.toString(), balance.divisibility) : "";
  });

  const showStatus = (msg: string, cls: "err" | "ok") => {
    statusEl.style.display = "block";
    statusEl.className = `status ${cls}`;
    statusEl.textContent = msg;
  };

  submitBtn.addEventListener("click", async () => {
    let raw: bigint;
    try {
      raw = parseDecimalToRaw((amountInput as HTMLInputElement).value, balance.divisibility);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      return;
    }
    if (raw <= 0n) {
      showStatus("Enter an amount greater than zero.", "err");
      return;
    }
    if (raw >= maxAmount) {
      showStatus("At least the smallest unit must stay private — enter a smaller amount.", "err");
      return;
    }
    setBusy(submitBtn as HTMLButtonElement, true, "Unshielding…");
    showStatus("Submitting — this usually takes a few seconds…", "ok");
    const memo = (memoInput as HTMLInputElement).value.trim();
    try {
      await send({
        kind: "popup-unshield",
        resourceAddress: balance.resourceAddress,
        revealedAmount: raw.toString(),
        memo: memo || undefined,
      });
      showStatus("Unshielded!", "ok");
      setTimeout(async () => {
        const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
        await renderHome(newStatus);
      }, 700);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(submitBtn as HTMLButtonElement, false);
    }
  });
}

function renderBalances(balancesCard: HTMLElement, balances: Balance[], status: WalletStatus) {
  if (balances.length === 0) {
    balancesCard.replaceChildren(
      emptyState("No tokens yet — claim some testnet XTR above to get started.", ICON_INBOX)
    );
  } else {
    balancesCard.replaceChildren(
      ...balances.map((b) => {
        const label = resourceLabel(b.resourceAddress, b.symbol);
        const row = h("button", { class: "balance-row clickable", "aria-label": `${label}, ${formatBalanceAmountGrouped(b.amount, b.divisibility)} — view details` }, [
          h("div", { class: "balance-left" }, [
            h("span", { class: "token-avatar", "aria-hidden": "true" }, [tokenInitial(b.resourceAddress, b.symbol)]),
            h("span", { class: "token-symbol" }, [label]),
          ]),
          h("span", { class: "token-amount" }, [formatBalanceAmountGrouped(b.amount, b.divisibility)]),
        ]);
        row.addEventListener("click", () => renderTokenDetail(status, b));
        return row;
      })
    );
  }
}

function renderTokenDetail(status: WalletStatus, balance: Balance) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);

  const addrLabel = h("span", {}, ["Copy"]);
  const addrCopyBtn = h("button", { class: "icon-btn" }, [icon(ICON_COPY), addrLabel]);
  const addrRow = h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [balance.resourceAddress]), addrCopyBtn]);
  addrCopyBtn.addEventListener("click", () => copyToClipboard(balance.resourceAddress, addrLabel));

  const isXtr = balance.resourceAddress === TARI_RESOURCE_ADDRESS;
  const displayName = isXtr ? "Tari" : (balance.name ?? "—");
  const displaySymbol = resourceLabel(balance.resourceAddress, balance.symbol);

  // Whether to show the private-balance row/Unshield button: NOT `balance.kind === "Confidential"`
  // -- shielding a plain Fungible vault's revealed balance creates a freestanding stealth UTXO
  // substate, which never changes the vault's own on-chain kind. Basing this on the vault kind
  // would hide a real private balance behind a "Fungible" vault forever. Base it on whether there's
  // actually something to show instead.
  const isConfidential = BigInt(balance.confidentialAmount) > 0n || balance.confidentialDecryptFailures > 0;
  const failures = balance.confidentialDecryptFailures;
  // Shielding needs this account's own view key/stealth signing -- unavailable for a
  // daemon-relayed account (see background/index.ts's popup-shield handler).
  const isLocalAccount = status.accounts.find((a) => a.id === status.activeAccountId)?.kind === "local";

  // Of the engine's three resource kinds (Fungible, Confidential, Stealth — see
  // demo_token/src/lib.rs's ResourceBuilder usage and StealthTransfer.prepare()'s source for how
  // these are confirmed distinct and fixed at resource-creation time, never convertible), only
  // Stealth resources support shield()/unshield()/sendPrivately()'s StealthTransfer pipeline at
  // all -- attempting it against a Fungible resource (e.g. a plain DemoToken like tUSD) or a real
  // Confidential-vault resource fails on-chain with "Stealth transfer is only allowed for stealth
  // resources". Gate every privacy action on this instead of just `isLocalAccount`.
  const isStealthResource = balance.kind === "Stealth";

  const shieldBtn =
    isLocalAccount && isStealthResource ? h("button", { class: "secondary" }, [`Shield ${displaySymbol}`]) : null;
  if (shieldBtn) shieldBtn.addEventListener("click", () => renderShield(status, balance));

  const unshieldBtn =
    isLocalAccount && isConfidential && isStealthResource ? h("button", { class: "secondary" }, [`Unshield ${displaySymbol}`]) : null;
  if (unshieldBtn) unshieldBtn.addEventListener("click", () => renderUnshield(status, balance));

  const sendPrivatelyBtn =
    isLocalAccount && isConfidential && isStealthResource ? h("button", { class: "secondary" }, [`Send ${displaySymbol} privately`]) : null;

  // A real Confidential-vault resource (distinct from Stealth -- see above) can genuinely carry a
  // nonzero confidential balance that this wallet correctly *displays* (sumConfidentialCommitments
  // in getBalances()), but has no send/unshield pipeline implemented for at all. Silently dropping
  // the buttons here would look like a bug; say so instead. Plain Fungible/NonFungible resources
  // have no private balance to begin with, so isConfidential is already false for them and no note
  // is shown.
  const noPrivacyActionsNote =
    isLocalAccount && !isStealthResource && isConfidential
      ? h("div", { class: "muted", style: "margin-top:10px;font-size:13px" }, [
          "This token's private balance uses a format this wallet doesn't support sending or unshielding for yet.",
        ])
      : null;
  if (sendPrivatelyBtn) {
    sendPrivatelyBtn.addEventListener("click", async () => {
      const balances = await send<Balance[]>({ kind: "popup-get-balances" });
      renderSend(status, balances, {
        initialTab: "private",
        initialResourceAddress: balance.resourceAddress,
        onBack: () => renderTokenDetail(status, balance),
      });
    });
  }

  render(
    h("h1", {}, ["Token"]),
    h("div", { class: "hero" }, [h("div", { class: "avatar" }, [tokenInitial(balance.resourceAddress, balance.symbol)])]),
    h("div", { class: "card" }, [
      h("div", { class: "muted" }, ["Name"]),
      h("div", { class: "detail-value" }, [displayName]),
      h("div", { class: "muted" }, ["Symbol"]),
      h("div", { class: "detail-value" }, [displaySymbol]),
      h("div", { class: "muted" }, [isConfidential ? "Revealed balance" : "Balance"]),
      h("div", { class: "detail-value" }, [formatBalanceAmountGrouped(balance.amount, balance.divisibility)]),
      ...(isConfidential
        ? [
            h("div", { class: "muted private-label" }, [icon(ICON_LOCK), "Private balance"]),
            h("div", { class: "detail-value", style: "color:var(--highlight)" }, [
              formatBalanceAmountGrouped(balance.confidentialAmount, balance.divisibility),
            ]),
            ...(failures > 0
              ? [
                  h("div", { class: "muted", style: "color:var(--bad)" }, [
                    `${failures} private ${failures === 1 ? "output" : "outputs"} couldn't be decrypted with this account's key.`,
                  ]),
                ]
              : []),
          ]
        : []),
      h("div", { class: "muted" }, ["Resource address"]),
      h("div", { style: "margin-top:4px" }, [addrRow]),
    ]),
    ...(shieldBtn ? [shieldBtn] : []),
    ...(unshieldBtn ? [unshieldBtn] : []),
    ...(sendPrivatelyBtn ? [sendPrivatelyBtn] : []),
    ...(noPrivacyActionsNote ? [noPrivacyActionsNote] : []),
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

function renderAccountSwitcher(status: WalletStatus) {
  const rows = status.accounts.map((account) => {
    const isActive = account.id === status.activeAccountId;
    // .settings-row (a flat list item with hover/active states), not .primary/.secondary -- the
    // previous version rendered every account as a stacked full-width CTA button, with the active
    // one filled solid, reading as "4 buttons" rather than "a list, one item selected."
    const row = h("button", { class: "settings-row", "aria-current": String(isActive) }, [
      h("div", { class: "row", style: "gap:10px;align-items:center" }, [
        accountAvatar(account.address, 28),
        h("div", {}, [
          h("div", { style: "font-weight:600;font-size:13.5px" }, [account.label]),
          account.kind === "daemon" ? h("div", { class: "muted", style: "font-size:11px" }, ["daemon"]) : "",
        ]),
      ]),
      isActive ? h("span", { class: "settings-row-right" }, ["Current"]) : "",
    ]);
    row.addEventListener("click", async () => {
      if (isActive) return;
      await send({ kind: "popup-set-active-account", accountId: account.id });
      renderLoading("Switching account…");
      try {
        const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
        await renderHome(newStatus);
      } catch (e) {
        render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
      }
    });
    return row;
  });
  const connectDaemonBtn = h("button", { class: "secondary", id: "connectDaemon" }, ["+ Connect daemon wallet"]);
  const back = h("button", { class: "secondary", id: "back" }, ["Back"]);
  // .account-switch-list bounds a long account list to a scrollable max-height (same convention
  // as .balances-card/.history-list) instead of growing the popup unboundedly.
  const list = h("div", { class: "card settings-card account-switch-list" }, rows);
  render(h("h1", {}, ["Switch account"]), list, connectDaemonBtn, back);
  connectDaemonBtn.addEventListener("click", () => renderConnectDaemon(status));
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

function renderDaemonConnections(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);
  const list =
    status.daemonConnections.length === 0
      ? emptyState("No daemon connections yet.", ICON_SERVER)
      : h(
          "div",
          {},
          status.daemonConnections.map((c) => {
            const info = h("div", { class: "list-row-info" }, [
              h("div", { class: "list-row-title" }, [c.label]),
              h("div", { class: "list-row-subtitle", title: c.url }, [c.url]),
            ]);
            const removeBtn = h("button", { class: "secondary btn-compact" }, ["Disconnect"]) as HTMLButtonElement;
            confirmThenRun(removeBtn, `Disconnect "${c.label}"? Its accounts will no longer be reachable from this wallet.`, "Disconnect", async () => {
              await send({ kind: "popup-remove-daemon-connection", connectionId: c.id });
              renderLoading("Removing…");
              const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
              // Switching away is only necessary if the removed connection owned the active
              // account — `popup-get-status` already reflects accounts being gone either way.
              if (!newStatus.accounts.some((a) => a.id === newStatus.activeAccountId)) {
                await send({ kind: "popup-set-active-account", accountId: "local:0" });
                await renderHome(await send<WalletStatus>({ kind: "popup-get-status" }));
              } else {
                renderDaemonConnections(newStatus);
              }
            });
            const row = h("div", { class: "balance-row" }, [info, removeBtn]);
            return row;
          })
        );
  render(h("h1", {}, ["Daemon connections"]), list, back);
  document.getElementById("back")!.addEventListener("click", () => renderSettings(status));
}

// ---------------------------------------------------------------------------
// Address book
// ---------------------------------------------------------------------------

function renderAddressBook(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);
  const list =
    status.addressBook.length === 0
      ? emptyState("No saved addresses yet.", ICON_BOOK)
      : h(
          "div",
          {},
          status.addressBook.map((entry) => {
            const info = h("div", { class: "list-row-info" }, [
              h("div", { class: "list-row-title" }, [entry.label]),
              h("div", { class: "list-row-subtitle", title: entry.address }, [entry.address]),
            ]);
            const removeBtn = h("button", { class: "secondary btn-compact" }, ["Remove"]) as HTMLButtonElement;
            confirmThenRun(removeBtn, `Remove "${entry.label}" from your address book?`, "Remove", async () => {
              await send({ kind: "popup-remove-address-book-entry", id: entry.id });
              renderAddressBook(await send<WalletStatus>({ kind: "popup-get-status" }));
            });
            return h("div", { class: "balance-row" }, [info, removeBtn]);
          })
        );

  const labelInput = h("input", { type: "text", placeholder: "e.g. Alice", maxlength: "40" });
  const addressInput = h("input", { type: "text", placeholder: "component_… or otl_…", maxlength: "200" });
  wireLiveValidation(addressInput as HTMLInputElement, (v) => isValidComponentAddress(v) || isValidOotleWalletAddress(v));
  const statusEl = h("div", { class: "status", style: "display:none" });
  const addBtn = h("button", { class: "primary" }, ["Save address"]);
  const showStatus = (msg: string, cls: "err" | "ok") => {
    statusEl.style.display = "block";
    statusEl.className = `status ${cls}`;
    statusEl.textContent = msg;
  };
  addBtn.addEventListener("click", async () => {
    const label = (labelInput as HTMLInputElement).value.trim();
    const address = (addressInput as HTMLInputElement).value.trim();
    if (!label) {
      showStatus("Enter a label.", "err");
      return;
    }
    if (!isValidComponentAddress(address) && !isValidOotleWalletAddress(address)) {
      showStatus("Enter a valid component_… (public) or otl_… (private) address.", "err");
      return;
    }
    setBusy(addBtn as HTMLButtonElement, true, "Saving…");
    try {
      await send({ kind: "popup-add-address-book-entry", label, address });
      renderAddressBook(await send<WalletStatus>({ kind: "popup-get-status" }));
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(addBtn as HTMLButtonElement, false);
    }
  });

  render(
    h("h1", {}, ["Address book"]),
    list,
    h("label", {}, ["Label"]),
    labelInput,
    h("label", {}, ["Address"]),
    addressInput,
    statusEl,
    addBtn,
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderSettings(status));
}

// ---------------------------------------------------------------------------
// Connect daemon wallet (the "hardware wallet" flow — connect, then pick accounts to add)
// ---------------------------------------------------------------------------

// Opening the daemon's web UI in a new tab (see below) steals focus, and an extension popup closes
// the instant it loses focus — so whatever the user already typed here would otherwise vanish the
// moment they go mint their API key, the exact point of the button that sends them there. Not the
// API key itself (that's sensitive and short-lived to copy-paste in one sitting); just the two
// fields that are annoying to retype. chrome.storage.session (not .local) so this never persists
// past a full browser restart.
const DAEMON_DRAFT_KEY = "daemonConnectDraft";

async function loadDaemonConnectDraft(): Promise<{ url: string; label: string }> {
  const stored = await chrome.storage.session.get(DAEMON_DRAFT_KEY);
  return (stored[DAEMON_DRAFT_KEY] as { url: string; label: string } | undefined) ?? { url: "", label: "" };
}

function saveDaemonConnectDraft(draft: { url: string; label: string }): void {
  void chrome.storage.session.set({ [DAEMON_DRAFT_KEY]: draft });
}

function clearDaemonConnectDraft(): void {
  void chrome.storage.session.remove(DAEMON_DRAFT_KEY);
}

async function renderConnectDaemon(status: WalletStatus) {
  const draft = await loadDaemonConnectDraft();
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);
  const urlInput = h("input", { type: "text", id: "url", placeholder: "http://127.0.0.1:5100", maxlength: "512" }) as HTMLInputElement;
  urlInput.value = draft.url;
  const keyInput = h("input", { type: "password", id: "apiKey", placeholder: "Paste the API key here", maxlength: "4096" });
  const labelInput = h("input", {
    type: "text",
    id: "label",
    placeholder: "e.g. Local walletd",
    maxlength: String(MAX_DAEMON_LABEL_LENGTH),
  }) as HTMLInputElement;
  labelInput.value = draft.label;
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const openWebUiBtn = h("button", { class: "secondary", id: "openWebUi", style: "margin-top:8px" }, ["Open API Keys page ↗"]);
  const connectBtn = h("button", { class: "primary", id: "connect" }, ["Connect"]);

  render(
    h("h1", {}, ["Connect daemon wallet"]),
    h("p", { class: "muted" }, [
      "Connect to a running tari_ootle_walletd — this extension will relay reads and transactions to it instead of signing locally, like a hardware wallet.",
    ]),
    h("p", { class: "muted" }, [
      "This extension can't log into the daemon's own browser session (WebAuthn is locked to the ",
      "daemon's own localhost origin, and a browser extension can never hold that session's cookie ",
      "either way) — mint an ",
      h("b", {}, ["API key with the \"admin\" permission"]),
      " from the daemon's web UI instead (requires an Admin login there once) and paste it below. ",
      "A narrower key will be rejected — this wallet needs admin access to submit transactions and ",
      "claim testnet funds.",
    ]),
    h("label", {}, ["Daemon URL"]),
    urlInput,
    openWebUiBtn,
    h("label", {}, ["API key"]),
    keyInput,
    h("label", {}, ["Label"]),
    labelInput,
    statusEl,
    connectBtn,
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderAccountSwitcher(status));

  const saveDraft = () => saveDaemonConnectDraft({ url: urlInput.value, label: labelInput.value });
  urlInput.addEventListener("input", saveDraft);
  labelInput.addEventListener("input", saveDraft);

  openWebUiBtn.addEventListener("click", () => {
    saveDraft();
    window.open(deriveWebUiApiKeysUrl(urlInput.value), "_blank");
  });

  const showStatus = (msg: string, cls: "err" | "ok") => {
    statusEl.style.display = "block";
    statusEl.className = `status ${cls}`;
    statusEl.textContent = msg;
  };

  connectBtn.addEventListener("click", async () => {
    let url: string;
    try {
      url = normalizeDaemonUrl(urlInput.value);
    } catch (e) {
      return showStatus(e instanceof Error ? e.message : String(e), "err");
    }
    const apiKey = (keyInput as HTMLInputElement).value.trim();
    if (!apiKey) return showStatus("Paste the API key you minted from the daemon's web UI.", "err");
    const label = labelInput.value.trim() || url;
    if (label.length > MAX_DAEMON_LABEL_LENGTH) {
      return showStatus(`Label must be ${MAX_DAEMON_LABEL_LENGTH} characters or fewer.`, "err");
    }

    // manifest.json's `host_permissions` only covers localhost/127.0.0.1 -- a remote daemon (a
    // different LAN host, a tailscale address, etc.) needs its origin granted at connect time via
    // the optional-permissions flow instead. A no-op (resolves true immediately, no prompt) for an
    // origin already covered by host_permissions or a previously-granted optional one. Must run
    // here, in the popup's own foreground context with this click as the user gesture --
    // chrome.permissions.request() cannot be called from the background service worker.
    const origin = `${new URL(url).origin}/*`;
    let granted: boolean;
    try {
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      return showStatus(`Couldn't request permission for ${origin}: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
    if (!granted) {
      return showStatus(`This wallet needs permission to reach ${new URL(url).origin} to connect to that daemon.`, "err");
    }

    setBusy(connectBtn as HTMLButtonElement, true, "Connecting…");
    showStatus("Connecting…", "ok");
    try {
      const result = await send<{ connectionId: string; accounts: DaemonAccountOption[] }>({
        kind: "popup-connect-daemon",
        url,
        apiKey,
        label,
      });
      clearDaemonConnectDraft();
      renderDaemonAccountPicker(status, result.connectionId, result.accounts);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      setBusy(connectBtn as HTMLButtonElement, false);
    }
  });
}

function renderDaemonAccountPicker(status: WalletStatus, connectionId: string, accounts: DaemonAccountOption[]) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);

  if (accounts.length === 0) {
    render(h("h1", {}, ["No accounts found"]), h("p", { class: "muted" }, ["This daemon has no accounts yet."]), back);
    document.getElementById("back")!.addEventListener("click", () => renderAccountSwitcher(status));
    return;
  }

  const checkboxes = accounts.map((a) => {
    const checkbox = h("input", { type: "checkbox", id: `acct-${a.componentAddress}` }) as HTMLInputElement;
    checkbox.checked = true;
    const row = h("label", { class: "balance-row", style: "cursor:pointer;gap:10px;justify-content:flex-start" }, [checkbox, a.label]);
    return { checkbox, account: a, row };
  });

  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const addBtn = h("button", { class: "primary", id: "add" }, ["Add selected accounts"]);

  render(
    h("h1", {}, ["Choose accounts"]),
    h("p", { class: "muted" }, ["Pick which of this daemon's accounts to add to your wallet."]),
    h("div", { class: "card" }, checkboxes.map((c) => c.row)),
    statusEl,
    addBtn,
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderAccountSwitcher(status));

  addBtn.addEventListener("click", async () => {
    const selected = checkboxes.filter((c) => c.checkbox.checked).map((c) => c.account);
    if (selected.length === 0) {
      statusEl.style.display = "block";
      statusEl.className = "status err";
      statusEl.textContent = "Select at least one account.";
      return;
    }
    setBusy(addBtn as HTMLButtonElement, true, "Adding…");
    try {
      await send({
        kind: "popup-add-daemon-accounts",
        connectionId,
        accounts: selected.map((a) => ({ componentAddress: a.componentAddress, label: a.label })),
      });
      renderLoading("Switching to the new account…");
      const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
      await renderHome(newStatus);
    } catch (e) {
      statusEl.style.display = "block";
      statusEl.className = "status err";
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      setBusy(addBtn as HTMLButtonElement, false);
    }
  });
}

function renderRevealMnemonic() {
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  render(
    h("h1", {}, ["Reveal recovery phrase"]),
    h("p", { class: "muted" }, ["Enter your password to display your 24-word recovery phrase."]),
    h("label", {}, ["Password"]),
    h("input", { type: "password", id: "pw", maxlength: "256" }),
    statusEl,
    h("div", { class: "row" }, [
      h("button", { class: "secondary", id: "cancel" }, ["Cancel"]),
      h("button", { class: "primary", id: "reveal" }, ["Reveal"]),
    ])
  );
  const pw = document.getElementById("pw") as HTMLInputElement;
  pw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("reveal")!.click();
  });
  document.getElementById("cancel")!.addEventListener("click", async () => {
    const status = await send<WalletStatus>({ kind: "popup-get-status" });
    await renderHome(status);
  });
  document.getElementById("reveal")!.addEventListener("click", async () => {
    try {
      const { mnemonic } = await send<{ mnemonic: string }>({ kind: "popup-reveal-mnemonic", password: pw.value });
      renderMnemonicDisplay(mnemonic);
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      statusEl.className = "status err";
      statusEl.style.display = "block";
    }
  });
}

function renderMnemonicDisplay(mnemonic: string) {
  const words = mnemonic.split(" ");
  const grid = h(
    "div",
    { class: "mnemonic-grid" },
    words.map((w, i) => h("div", { class: "mnemonic-word" }, [h("span", {}, [String(i + 1)]), w]))
  );
  const back = h("button", { class: "primary", id: "back" }, ["Back"]);
  render(
    h("h1", {}, ["Your recovery phrase"]),
    h("p", { class: "muted" }, ["Anyone with this phrase can spend your funds. Keep it secret."]),
    grid,
    back
  );
  document.getElementById("back")!.addEventListener("click", async () => {
    const status = await send<WalletStatus>({ kind: "popup-get-status" });
    await renderHome(status);
  });
}

async function renderConnectedSites() {
  const backEarly = h("button", { class: "secondary", id: "back" }, ["Back"]);
  render(h("h1", {}, ["Connected sites"]), h("div", { class: "card" }, [skeletonListRow(), skeletonListRow()]), backEarly);
  backEarly.addEventListener("click", async () => {
    const status = await send<WalletStatus>({ kind: "popup-get-status" });
    await renderHome(status);
  });

  const sites = await send<{ origin: string }[]>({ kind: "popup-get-connected-sites" });
  const list =
    sites.length === 0
      ? emptyState("No connected sites.", ICON_GLOBE)
      : h(
          "div",
          {},
          sites.map((s) => {
            // Wrapped in list-row-info (not a bare string) for the same reason as the address
            // book/daemon connections rows -- an unusually long origin shouldn't be able to
            // blow out the row width and squeeze the Disconnect button off-screen.
            const info = h("div", { class: "list-row-info" }, [h("div", { class: "list-row-title", title: s.origin }, [s.origin])]);
            const removeBtn = h("button", { class: "secondary btn-compact" }, ["Disconnect"]) as HTMLButtonElement;
            confirmThenRun(removeBtn, `Disconnect ${s.origin}? It will need to request access again to reconnect.`, "Disconnect", async () => {
              await send({ kind: "popup-disconnect-site", origin: s.origin });
              await renderConnectedSites();
            });
            return h("div", { class: "balance-row" }, [info, removeBtn]);
          })
        );
  const back = h("button", { class: "secondary", id: "back" }, ["Back"]);
  render(h("h1", {}, ["Connected sites"]), list, back);
  document.getElementById("back")!.addEventListener("click", async () => {
    const status = await send<WalletStatus>({ kind: "popup-get-status" });
    await renderHome(status);
  });
}

// ---------------------------------------------------------------------------
// Approval popups (opened by the background service worker)
// ---------------------------------------------------------------------------

async function renderApprovalFlow(approvalId: string) {
  const status = await send<WalletStatus>({ kind: "popup-get-status" });
  if (!status.hasWallet) {
    render(h("div", { class: "status err" }, ["No wallet set up — open the extension normally first."]));
    return;
  }
  if (!status.isUnlocked) {
    renderUnlock(
      () =>
        void send<WalletStatus>({ kind: "popup-get-status" }).then((freshStatus) => renderApprovalDetails(approvalId, freshStatus)),
      status.lastKnownAddress
    );
    return;
  }
  await renderApprovalDetails(approvalId, status);
}

/** The account chip shown on both approval screens: whichever account will actually sign, so a
 * user with multiple accounts can confirm which identity/funds a request is exposing before
 * approving. For a transaction, that's the site's connected account (`approval.accountId`, bound
 * at connect time -- NOT necessarily whichever account happens to be active right now); for a
 * connect request, it's whichever account is active right now (there's nothing else to bind to
 * yet -- that's exactly what a connect request grants). */
function approvalAccountChip(status: WalletStatus, accountId: string | undefined): HTMLElement {
  const account = status.accounts.find((a) => a.id === (accountId ?? status.activeAccountId));
  return h("div", { class: "approval-account-chip" }, [
    accountAvatar(account?.address ?? null, 26),
    h("div", {}, [
      h("div", { style: "font-weight:600;font-size:13px" }, [account?.label ?? "An account"]),
      account?.address ? h("div", { class: "muted", style: "font-size:11px" }, [shortAddr(account.address)]) : "",
    ]),
  ]);
}

async function renderApprovalDetails(approvalId: string, status: WalletStatus) {
  const approval = await send<PendingApproval | null>({ kind: "popup-get-pending-approval", approvalId });
  if (!approval) {
    render(h("div", { class: "status err" }, ["This request has expired or was already handled."]));
    return;
  }

  const resolve = async (approve: boolean) => {
    const { resolved } = await send<{ resolved: boolean }>({ kind: "popup-resolve-approval", approvalId, approve });
    if (!resolved) {
      // The background service worker restarted while this popup sat open (MV3 tears workers down
      // after ~30s idle) — the page's own original request already died with it, so this click
      // didn't do anything. Say so instead of closing and letting the user believe it went through.
      render(
        h("div", { class: "status err" }, [
          "This request expired before you responded (the connection to the site was lost). Nothing was sent — try again from the site.",
        ])
      );
      return;
    }
    window.close();
  };

  if (approval.kind === "connect") {
    render(
      h("h1", {}, ["Connection request"]),
      h("p", { class: "muted" }, [h("b", {}, [approval.origin]), " wants to connect to your wallet and view your address."]),
      approvalAccountChip(status, undefined),
      h("button", { class: "primary", id: "approve" }, ["Connect"]),
      h("button", { class: "secondary", id: "reject" }, ["Cancel"])
    );
  } else {
    const instructionCards = approval.instructions.map((instr, i) => {
      const { title, detail } = summarizeInstruction(instr);
      const args = summarizeArgs(instr);
      return h("div", { class: "instruction-card" }, [
        h("div", { class: "instruction-index" }, [String(i + 1)]),
        h("div", { class: "instruction-body" }, [
          h("div", { class: "instruction-title" }, [title]),
          detail ? h("div", { class: "instruction-detail" }, [detail]) : "",
          args.length > 0
            ? h("div", { class: "instruction-args" }, [`with ${args.length} argument${args.length === 1 ? "" : "s"}`])
            : "",
        ]),
      ]);
    });

    const rawJson = JSON.stringify(approval.instructions, null, 2);
    const rawDetails = h("details", { class: "raw-details" }, [
      h("summary", {}, ["View raw instruction data"]),
      h("div", { class: "instruction-list" }, [rawJson]),
    ]);

    render(
      h("h1", {}, ["Transaction request"]),
      h("p", { class: "muted" }, [h("b", {}, [approval.origin]), " wants you to sign and submit a transaction."]),
      approvalAccountChip(status, approval.accountId),
      approval.note ? h("p", { class: "muted", style: "color:var(--highlight)" }, [approval.note]) : "",
      approval.maxFee ? h("p", { class: "muted" }, [`Max fee: ${approval.maxFee}`]) : "",
      approval.dryRun ? h("p", { class: "muted" }, ["This is a dry run — nothing will be spent."]) : "",
      h("div", { class: "instruction-cards" }, instructionCards),
      rawDetails,
      h("button", { class: "primary", id: "approve" }, [approval.dryRun ? "Simulate" : "Approve & Sign"]),
      h("button", { class: "secondary", id: "reject" }, ["Reject"])
    );
  }

  document.getElementById("approve")!.addEventListener("click", () => resolve(true));
  document.getElementById("reject")!.addEventListener("click", () => resolve(false));
}

main().catch((e) => {
  render(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
});
