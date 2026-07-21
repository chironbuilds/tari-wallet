import "./styles.css";
import type { PendingApproval, PopupRequest, WalletStatus } from "../lib/messages";
import { validateMnemonic } from "../lib/mnemonic";

const app = document.getElementById("app")!;

type Balance = { resourceAddress: string; kind: string; amount: string; divisibility: number; symbol: string | null };

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

function shortAddr(addr: string, n = 10): string {
  return addr.length > n * 2 + 3 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr;
}

/** Copies `text` and flashes `label`'s text to "Copied!" for a beat, then restores it. */
async function copyToClipboard(text: string, label: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return; // Clipboard permission denied or unavailable — fail silently, nothing to recover.
  }
  const original = label.textContent;
  label.textContent = "Copied!";
  setTimeout(() => {
    label.textContent = original;
  }, 1200);
}

/** Parses a decimal string (e.g. "12.5") into raw resource-native units for a given divisibility.
 * Truncates (does not round) anything past `divisibility` places, mirroring on-chain behavior. */
function parseDecimalToRaw(input: string, divisibility: number): bigint {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter an amount.");
  const [wholeStr = "", fracStr = ""] = trimmed.split(".");
  if (!/^\d*$/.test(wholeStr) || !/^\d*$/.test(fracStr) || (!wholeStr && !fracStr)) throw new Error("Enter a valid amount.");
  const whole = wholeStr ? BigInt(wholeStr) : 0n;
  const frac = fracStr.slice(0, divisibility).padEnd(divisibility, "0");
  const raw = whole * 10n ** BigInt(divisibility) + (frac ? BigInt(frac) : 0n);
  if (raw <= 0n) throw new Error("Amount must be greater than zero.");
  return raw;
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
  else if (!status.isUnlocked) renderUnlock();
  else await renderHome(status);
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function renderWelcome() {
  render(
    h("h1", {}, ["Tari", h("span", {}, [" Wallet"])]),
    h("p", { class: "muted" }, [
      "A self-custody wallet for Tari Ootle. Your seed never leaves this browser and no wallet daemon is required.",
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

  const mnemonicField =
    mode === "import"
      ? (() => {
          const label = h("label", {}, ["24-word recovery phrase"]);
          const ta = h("textarea", { id: "mnemonic", placeholder: "word1 word2 word3 ..." });
          return [label, ta];
        })()
      : [];

  const pwLabel = h("label", {}, ["Password"]);
  const pw = h("input", { type: "password", id: "pw" });
  const pw2Label = h("label", {}, ["Confirm password"]);
  const pw2 = h("input", { type: "password", id: "pw2" });
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const submit = h("button", { class: "primary", id: "submit" }, [mode === "create" ? "Create Wallet" : "Import Wallet"]);
  const back = h("button", { class: "secondary", id: "back" }, ["Back"]);

  wrap.append(...mnemonicField, pwLabel, pw, pw2Label, pw2, statusEl, submit, back);
  render(wrap);

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
    if (password !== password2) return showStatus("Passwords do not match.");

    try {
      if (mode === "create") {
        const { mnemonic } = await send<{ mnemonic: string }>({ kind: "popup-create-wallet", password });
        renderBackupMnemonic(mnemonic);
      } else {
        const mnemonic = (document.getElementById("mnemonic") as HTMLTextAreaElement).value.trim();
        if (!validateMnemonic(mnemonic)) return showStatus("That recovery phrase doesn't look valid — check spelling and word count.");
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
  document.getElementById("confirm")!.addEventListener("click", async () => {
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

function renderUnlock(onUnlocked?: () => void) {
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  render(
    h("h1", {}, ["Unlock"]),
    h("label", {}, ["Password"]),
    h("input", { type: "password", id: "pw" }),
    statusEl,
    h("button", { class: "primary", id: "unlock" }, ["Unlock"])
  );
  const pw = document.getElementById("pw") as HTMLInputElement;
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
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

async function renderHome(status: WalletStatus) {
  const accountPill = h("span", { class: "account-pill" }, [`Account ${status.activeAccountIndex + 1} ▾`]);
  const settingsBtn = h("button", { class: "secondary", id: "settingsBtn", style: "width:auto;padding:6px 10px;margin-top:0" }, ["⚙"]);
  const nav = h("div", { class: "top-nav" }, [
    h("h1", {}, ["Tari", h("span", {}, [" Wallet"])]),
    h("div", { class: "row", style: "gap:6px" }, [accountPill, settingsBtn]),
  ]);
  accountPill.addEventListener("click", () => renderAccountSwitcher(status));
  settingsBtn.addEventListener("click", () => renderSettings(status));

  const initial = `A${status.activeAccountIndex + 1}`;
  const copyLabel = h("span", {}, [shortAddr(status.address ?? "", 8)]);
  const addrPill = h("div", { class: "addr-pill", id: "addrPill" }, [copyLabel, h("span", { class: "icon" }, ["⧉"])]);
  addrPill.addEventListener("click", () => copyToClipboard(status.address ?? "", copyLabel));
  const hero = h("div", { class: "hero" }, [h("div", { class: "avatar" }, [initial]), addrPill]);

  const sendActionBtn = h("div", { class: "action-btn", id: "sendAction" }, [h("div", { class: "action-icon" }, ["↑"]), "Send"]);
  const receiveActionBtn = h("div", { class: "action-btn", id: "receiveAction" }, [h("div", { class: "action-icon" }, ["↓"]), "Receive"]);
  const claimActionBtn = h("div", { class: "action-btn", id: "claimAction" }, [h("div", { class: "action-icon" }, ["+"]), "Claim XTR"]);
  const actionRow = h("div", { class: "action-row" }, [sendActionBtn, receiveActionBtn, claimActionBtn]);

  const claimStatusEl = h("div", { class: "status", id: "claimStatus", style: "display:none" });

  const balancesTitle = h("div", { class: "section-title" }, ["Assets"]);
  const balancesCard = h("div", { class: "card balances-card" }, [h("div", { class: "muted" }, ["Loading balances…"])]);

  render(nav, hero, actionRow, claimStatusEl, balancesTitle, balancesCard);

  sendActionBtn.addEventListener("click", async () => {
    try {
      const balances = await send<Balance[]>({ kind: "popup-get-balances" });
      renderSend(status, balances);
    } catch (e) {
      claimStatusEl.style.display = "block";
      claimStatusEl.className = "status err";
      claimStatusEl.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  receiveActionBtn.addEventListener("click", () => renderReceive(status));
  claimActionBtn.addEventListener("click", async () => {
    claimActionBtn.setAttribute("style", "pointer-events:none;opacity:0.6");
    claimStatusEl.style.display = "block";
    claimStatusEl.className = "status";
    claimStatusEl.textContent = "Claiming from the testnet faucet — this submits a real transaction, usually takes a few seconds…";
    try {
      await send({ kind: "popup-claim-testnet-xtr" });
      claimStatusEl.className = "status ok";
      claimStatusEl.textContent = "Claimed! Refreshing balances…";
      const balances = await send<Balance[]>({ kind: "popup-get-balances" });
      renderBalances(balancesCard, balances);
      claimStatusEl.textContent = "Claimed testnet XTR.";
    } catch (e) {
      claimStatusEl.className = "status err";
      claimStatusEl.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      claimActionBtn.removeAttribute("style");
    }
  });

  try {
    const balances = await send<Balance[]>({ kind: "popup-get-balances" });
    renderBalances(balancesCard, balances);
  } catch (e) {
    balancesCard.replaceChildren(h("div", { class: "status err" }, [e instanceof Error ? e.message : String(e)]));
  }
}

function renderSettings(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);
  const addAccountBtn = h("button", { class: "secondary", id: "addAccount" }, ["+ Add account"]);
  const sitesBtn = h("button", { class: "secondary", id: "sites" }, ["Connected sites"]);
  const backupBtn = h("button", { class: "secondary", id: "backup" }, ["Reveal recovery phrase"]);
  const lockBtn = h("button", { class: "danger", id: "lock" }, ["Lock wallet"]);

  render(h("h1", {}, ["Settings"]), back, addAccountBtn, sitesBtn, backupBtn, lockBtn);

  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
  document.getElementById("lock")!.addEventListener("click", async () => {
    await send({ kind: "popup-lock" });
    renderUnlock();
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
  document.getElementById("sites")!.addEventListener("click", renderConnectedSites);
  document.getElementById("backup")!.addEventListener("click", renderRevealMnemonic);
}

// ---------------------------------------------------------------------------
// Send / Receive
// ---------------------------------------------------------------------------

function renderReceive(status: WalletStatus) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);

  const componentLabel = h("span", {}, ["Copy"]);
  const componentCopyBtn = h("button", { class: "icon-btn" }, [componentLabel]);
  const componentRow = h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [status.address ?? "—"]), componentCopyBtn]);
  componentCopyBtn.addEventListener("click", () => copyToClipboard(status.address ?? "", componentLabel));

  const walletLabel = h("span", {}, ["Copy"]);
  const walletCopyBtn = h("button", { class: "icon-btn" }, [walletLabel]);
  const walletRow = h("div", { class: "copy-row" }, [h("div", { class: "addr" }, [status.receiveAddress ?? "—"]), walletCopyBtn]);
  walletCopyBtn.addEventListener("click", () => copyToClipboard(status.receiveAddress ?? "", walletLabel));

  render(
    h("h1", {}, ["Receive"]),
    h("p", { class: "muted" }, ["Share your account address to receive any token on Tari Ootle."]),
    h("div", { class: "hero" }, [h("div", { class: "avatar" }, [`A${status.activeAccountIndex + 1}`])]),
    h("div", { class: "card" }, [
      h("div", { class: "muted", style: "margin-bottom:8px" }, ["Component address"]),
      componentRow,
      h("div", { class: "muted", style: "margin:14px 0 8px" }, ["Wallet address"]),
      walletRow,
    ]),
    back
  );
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

function renderSend(status: WalletStatus, balances: Balance[]) {
  const back = h("button", { class: "secondary", id: "back" }, ["← Back"]);

  if (balances.length === 0) {
    render(
      h("h1", {}, ["Send"]),
      h("p", { class: "muted" }, ["You don't hold any tokens yet — claim some testnet XTR first."]),
      back
    );
    document.getElementById("back")!.addEventListener("click", () => renderHome(status));
    return;
  }

  const tokenSelect = h(
    "select",
    { id: "token" },
    balances.map((b) => h("option", { value: b.resourceAddress }, [resourceLabel(b.resourceAddress, b.symbol)]))
  );
  const balanceHint = h("div", { class: "muted", id: "balanceHint", style: "margin-top:6px" }, [""]);

  const toInput = h("input", { type: "text", id: "to", placeholder: "component_…" });
  const amountInput = h("input", { type: "text", id: "amount", placeholder: "0.0" });
  const maxBtn = h("button", { class: "max-btn", id: "max" }, ["MAX"]);
  const amountField = h("div", { class: "amount-field" }, [amountInput, maxBtn]);

  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  const sendBtn = h("button", { class: "primary", id: "submit" }, ["Review & Send"]);

  render(
    h("h1", {}, ["Send"]),
    h("label", {}, ["Asset"]),
    tokenSelect,
    balanceHint,
    h("label", {}, ["Recipient address"]),
    toInput,
    h("label", {}, ["Amount"]),
    amountField,
    statusEl,
    sendBtn,
    back
  );

  const selected = () => balances.find((b) => b.resourceAddress === (tokenSelect as HTMLSelectElement).value)!;
  const updateHint = () => {
    const b = selected();
    balanceHint.textContent = `Available: ${formatBalanceAmount(b.amount.toString(), b.divisibility)} ${resourceLabel(b.resourceAddress, b.symbol)}`;
  };
  updateHint();
  tokenSelect.addEventListener("change", updateHint);

  maxBtn.addEventListener("click", () => {
    const b = selected();
    (amountInput as HTMLInputElement).value = formatBalanceAmount(b.amount.toString(), b.divisibility);
  });

  document.getElementById("back")!.addEventListener("click", () => renderHome(status));

  const showStatus = (msg: string, cls: "err" | "ok") => {
    statusEl.style.display = "block";
    statusEl.className = `status ${cls}`;
    statusEl.textContent = msg;
  };

  sendBtn.addEventListener("click", async () => {
    const b = selected();
    const toAddress = (toInput as HTMLInputElement).value.trim();
    if (!/^component_[0-9a-f]{16,}$/i.test(toAddress)) {
      showStatus("Enter a valid recipient component address (component_…).", "err");
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

    sendBtn.setAttribute("disabled", "true");
    showStatus("Submitting — this usually takes a few seconds…", "ok");
    try {
      await send({ kind: "popup-send", toAddress, resourceAddress: b.resourceAddress, amount: raw.toString() });
      showStatus("Sent!", "ok");
      setTimeout(async () => {
        const newStatus = await send<WalletStatus>({ kind: "popup-get-status" });
        await renderHome(newStatus);
      }, 700);
    } catch (e) {
      showStatus(e instanceof Error ? e.message : String(e), "err");
      sendBtn.removeAttribute("disabled");
    }
  });
}

// Mirrors `TARI_RESOURCE_ADDRESS` from `@tari-project/ootle` (not imported directly here — that
// would pull the whole wasm-backed SDK into the popup bundle just for one constant string).
const TARI_RESOURCE_ADDRESS = "resource_0101010101010101010101010101010101010101010101010101010101010101";

function resourceLabel(resourceAddress: string, symbol: string | null): string {
  if (resourceAddress === TARI_RESOURCE_ADDRESS) return "XTR";
  return symbol ?? shortAddr(resourceAddress);
}

// Each balance carries its resource's real on-chain `divisibility` (see OotleAccount.getBalances()
// in wallet.ts) — not a guessed convention. Confirmed empirically to actually vary: XTR is 6, a
// typical DemoToken-style test token defaults to 8; formatting everything as 6 would silently show
// amounts two orders of magnitude too small for those.
function formatBalanceAmount(rawAmount: string, divisibility: number): string {
  const unit = 10n ** BigInt(divisibility);
  const raw = BigInt(rawAmount);
  const whole = raw / unit;
  const frac = (raw % unit).toString().padStart(divisibility, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function tokenInitial(resourceAddress: string, symbol: string | null): string {
  const label = resourceLabel(resourceAddress, symbol);
  return label.slice(0, 1).toUpperCase();
}

function renderBalances(balancesCard: HTMLElement, balances: Balance[]) {
  if (balances.length === 0) {
    balancesCard.replaceChildren(h("div", { class: "muted" }, ["No tokens yet."]));
  } else {
    balancesCard.replaceChildren(
      ...balances.map((b) =>
        h("div", { class: "balance-row" }, [
          h("div", { class: "balance-left" }, [
            h("span", { class: "token-avatar" }, [tokenInitial(b.resourceAddress, b.symbol)]),
            h("span", { class: "token-symbol" }, [resourceLabel(b.resourceAddress, b.symbol)]),
          ]),
          h("span", { class: "token-amount" }, [formatBalanceAmount(b.amount, b.divisibility)]),
        ])
      )
    );
  }
}

function renderAccountSwitcher(status: WalletStatus) {
  const rows = Array.from({ length: status.accountCount }, (_, index) => {
    const isActive = index === status.activeAccountIndex;
    const row = h("button", { class: isActive ? "primary" : "secondary", style: "text-align:left" }, [
      `Account ${index + 1}`,
      isActive ? " (current)" : "",
    ]);
    row.addEventListener("click", async () => {
      if (isActive) return;
      await send({ kind: "popup-set-active-account", index });
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
  const back = h("button", { class: "secondary", id: "back" }, ["Back"]);
  render(h("h1", {}, ["Switch account"]), ...rows, back);
  document.getElementById("back")!.addEventListener("click", () => renderHome(status));
}

function renderRevealMnemonic() {
  const statusEl = h("div", { class: "status", id: "status", style: "display:none" });
  render(
    h("h1", {}, ["Reveal recovery phrase"]),
    h("p", { class: "muted" }, ["Enter your password to display your 24-word recovery phrase."]),
    h("label", {}, ["Password"]),
    h("input", { type: "password", id: "pw" }),
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
  const sites = await send<{ origin: string }[]>({ kind: "popup-get-connected-sites" });
  const list =
    sites.length === 0
      ? h("div", { class: "muted" }, ["No connected sites."])
      : h(
          "div",
          {},
          sites.map((s) => {
            const row = h("div", { class: "balance-row" }, [s.origin]);
            const removeBtn = h("button", { class: "secondary", style: "width:auto;padding:4px 8px" }, ["Disconnect"]);
            removeBtn.addEventListener("click", async () => {
              await send({ kind: "popup-disconnect-site", origin: s.origin });
              await renderConnectedSites();
            });
            row.append(removeBtn);
            return row;
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
    renderUnlock(() => void renderApprovalDetails(approvalId));
    return;
  }
  await renderApprovalDetails(approvalId);
}

async function renderApprovalDetails(approvalId: string) {
  const approval = await send<PendingApproval | null>({ kind: "popup-get-pending-approval", approvalId });
  if (!approval) {
    render(h("div", { class: "status err" }, ["This request has expired or was already handled."]));
    return;
  }

  const resolve = async (approve: boolean) => {
    await send({ kind: "popup-resolve-approval", approvalId, approve });
    window.close();
  };

  if (approval.kind === "connect") {
    render(
      h("h1", {}, ["Connection request"]),
      h("p", { class: "muted" }, [h("b", {}, [approval.origin]), " wants to connect to your wallet and view your address."]),
      h("button", { class: "primary", id: "approve" }, ["Connect"]),
      h("button", { class: "secondary", id: "reject" }, ["Cancel"])
    );
  } else {
    const summary = JSON.stringify(approval.instructions, null, 2);
    render(
      h("h1", {}, ["Transaction request"]),
      h("p", { class: "muted" }, [h("b", {}, [approval.origin]), " wants you to sign and submit a transaction."]),
      approval.maxFee ? h("p", { class: "muted" }, [`Max fee: ${approval.maxFee}`]) : "",
      approval.dryRun ? h("p", { class: "muted" }, ["This is a dry run — nothing will be spent."]) : "",
      h("div", { class: "instruction-list" }, [summary]),
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
