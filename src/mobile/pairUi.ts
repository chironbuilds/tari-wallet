// The Android-only "Connect a dApp" bottom sheet (opened from the Scan tab): scan a WalletConnect QR
// code or paste its link. Lives outside #app so the shared popup screens don't need to know about it.
import { BarcodeFormat, BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let closeSheet: () => boolean = () => false;

/** Closes the pairing sheet if it is open; returns whether it was (the back button uses this). */
export function closePairingSheet(): boolean {
  return closeSheet();
}

/** A short toast at the bottom of the screen. */
export function showPairingNotice(message: string, kind: "ok" | "err"): void {
  let el = document.getElementById("wc-notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "wc-notice";
    document.body.appendChild(el);
  }
  el.className = `wc-notice ${kind}`;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el!.hidden = true), 5000);
}

async function scanQr(): Promise<string | null> {
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (!available) {
    // First use on a device: Play services downloads the scanner module in the background.
    await BarcodeScanner.installGoogleBarcodeScannerModule();
    throw new Error("Installing the QR scanner. Try again in a moment, or paste the link instead.");
  }
  const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
  return barcodes[0]?.rawValue ?? null;
}

let openSheet: () => void = () => {};

/** Opens the Connect-a-dApp sheet (the Scan tab). */
export function openPairingSheet(): void {
  openSheet();
}

export function installPairingUi(pair: (uri: string) => Promise<void>, enabled: boolean): void {
  const sheet = document.createElement("div");
  sheet.id = "wc-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Connect a dApp with WalletConnect");
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="wc-sheet-card">
      <div class="wc-sheet-handle"></div>
      <h2>Connect a dApp</h2>
      <p class="muted">On the dApp, choose WalletConnect, then scan its QR code or paste its link.</p>
      <button type="button" class="primary" id="wc-scan">Scan QR code</button>
      <label for="wc-uri">Or paste the link</label>
      <input id="wc-uri" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="wc:…" />
      <button type="button" class="secondary" id="wc-paste-connect">Connect</button>
      <button type="button" class="secondary" id="wc-close">Cancel</button>
    </div>`;
  document.body.appendChild(sheet);

  const input = sheet.querySelector<HTMLInputElement>("#wc-uri")!;
  const close = () => {
    sheet.classList.remove("open");
    setTimeout(() => {
      sheet.hidden = true;
      input.value = "";
    }, 200);
  };
  closeSheet = () => {
    if (sheet.hidden) return false;
    close();
    return true;
  };
  openSheet = () => {
    if (!enabled) {
      showPairingNotice("WalletConnect isn't configured in this build.", "err");
      return;
    }
    sheet.hidden = false;
    // Next frame, so the slide-up transition runs.
    requestAnimationFrame(() => sheet.classList.add("open"));
  };
  // Tapping the dimmed backdrop (not the card) dismisses the sheet, as on any Android bottom sheet.
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) close();
  });
  const connect = async (uri: string | null) => {
    if (!uri) return;
    close();
    try {
      await pair(uri);
      showPairingNotice("Waiting for the dApp…", "ok");
    } catch (e) {
      showPairingNotice(e instanceof Error ? e.message : String(e), "err");
    }
  };

  sheet.querySelector("#wc-close")!.addEventListener("click", close);
  sheet.querySelector("#wc-paste-connect")!.addEventListener("click", () => void connect(input.value));
  sheet.querySelector("#wc-scan")!.addEventListener("click", async () => {
    try {
      await connect(await scanQr());
    } catch (e) {
      showPairingNotice(e instanceof Error ? e.message : String(e), "err");
    }
  });
}

