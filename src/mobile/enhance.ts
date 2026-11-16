// Phone-only touches added to the shared popup screens after each render, without changing them:
// Paste / Scan QR on address fields (and no autocorrect mangling addresses), a native Share sheet
// on Receive, the tab bar stepping aside while the keyboard is up, and haptics on copy.
import { Clipboard } from "@capacitor/clipboard";
import { Share } from "@capacitor/share";
import { t } from "../lib/i18n";
import { scanQr, showPairingNotice } from "./pairUi";
import { tick } from "./nav";

import { extractAddress } from "./address";

function isAddressInput(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement) || el.type !== "text") return false;
  const ph = el.placeholder ?? "";
  return ph.includes("otl_") || ph.includes("component_");
}

function setValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function addressTools(input: HTMLInputElement): void {
  if (input.dataset.enhanced) return;
  input.dataset.enhanced = "1";
  // Addresses are case-sensitive bech32-ish strings: keep the keyboard from "fixing" them.
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocomplete", "off");
  input.spellcheck = false;

  const bar = document.createElement("div");
  bar.className = "addr-tools";
  const paste = document.createElement("button");
  paste.type = "button";
  paste.className = "chip-btn";
  paste.textContent = t("mobile.paste");
  const scan = document.createElement("button");
  scan.type = "button";
  scan.className = "chip-btn";
  scan.textContent = t("mobile.scanQr");
  bar.append(paste, scan);
  input.insertAdjacentElement("afterend", bar);

  paste.addEventListener("click", async () => {
    try {
      const { value } = await Clipboard.read();
      const addr = extractAddress(value ?? "");
      if (!addr) {
        showPairingNotice(t("mobile.noAddressInClipboard"), "err");
        return;
      }
      tick();
      setValue(input, addr);
    } catch {
      showPairingNotice(t("mobile.noAddressInClipboard"), "err");
    }
  });
  scan.addEventListener("click", async () => {
    try {
      const raw = await scanQr();
      if (!raw) return;
      const addr = extractAddress(raw);
      if (!addr) {
        showPairingNotice(t("mobile.noAddressInQr"), "err");
        return;
      }
      tick();
      setValue(input, addr);
    } catch (e) {
      showPairingNotice(e instanceof Error ? e.message : String(e), "err");
    }
  });
}

export interface EnhanceDeps {
  receiveAddress(): Promise<string | null>;
  /** Opens the Connect-a-dApp sheet. */
  connectDapp(): void;
}

export function installEnhancements(deps: EnhanceDeps): void {
  const app = document.getElementById("app")!;

  const enhance = () => {
    for (const el of app.querySelectorAll("input")) if (isAddressInput(el)) addressTools(el);
    const h1 = app.querySelector("h1");

    // dApps tab: start a connection from where connections are listed.
    if (h1?.textContent === t("connectedSites.title") && !app.querySelector("#connectDappBtn")) {
      const btn = document.createElement("button");
      btn.id = "connectDappBtn";
      btn.type = "button";
      btn.className = "primary";
      btn.textContent = t("mobile.connectDapp");
      h1.after(btn);
      btn.addEventListener("click", () => {
        tick();
        deps.connectDapp();
      });
    }

    // Receive: a native Share sheet next to Copy.
    if (h1?.textContent === t("receive.title") && !app.querySelector("#shareAddress")) {
      const share = document.createElement("button");
      share.id = "shareAddress";
      share.type = "button";
      share.className = "primary";
      share.textContent = t("mobile.shareAddress");
      // Right under the wallet-address card (the one holding the first Copy button), not below the
      // fold at the end of the screen.
      const card = app.querySelector(".icon-btn")?.closest(".card") ?? app.querySelector(".icon-btn")?.parentElement?.parentElement;
      if (card) card.after(share);
      else app.append(share);
      share.addEventListener("click", async () => {
        const address = await deps.receiveAddress();
        if (!address) return;
        tick();
        try {
          await Share.share({ title: t("mobile.shareTitle"), text: address, dialogTitle: t("mobile.shareAddress") });
        } catch {
          // The user closed the share sheet.
        }
      });
    }
  };
  new MutationObserver(enhance).observe(app, { childList: true, subtree: true });
  enhance();

  // Copy buttons (and Home's address chip): a haptic tick and a short "Copied" toast, so the copy
  // registers even when the button's own label change is under a thumb.
  app.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>(".icon-btn, .addr-pill");
    if (!btn) return;
    tick();
    if (btn.classList.contains("addr-pill") || btn.textContent?.includes(t("common.copy"))) showPairingNotice(t("mobile.copied"), "ok", 1600);
  });

  // Keyboard: Android resizes the page, which would float the tab bar right above the keyboard
  // and over the field being typed in. Step it aside while a field has focus, and keep the field
  // in view once the keyboard has finished opening.
  const root = document.documentElement;
  document.addEventListener("focusin", (e) => {
    const el = e.target as HTMLElement;
    if (!el.matches("input, textarea, select")) return;
    root.classList.add("kb-open");
    setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 320);
  });
  document.addEventListener("focusout", () => {
    // Next tick: focus may be moving straight to another field.
    setTimeout(() => {
      const a = document.activeElement as HTMLElement | null;
      if (!a || !a.matches("input, textarea, select")) root.classList.remove("kb-open");
    }, 50);
  });
}
