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
export function showPairingNotice(message: string, kind: "ok" | "err", ms = 5000): void {
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
  noticeTimer = setTimeout(() => (el!.hidden = true), ms);
}

/**
 * Scans one QR code. Prefers Google's code scanner (polished, no camera permission needed) when its
 * Play-services module is already on the device; otherwise scans at once with the built-in scanner
 * (ML Kit model bundled in the app, live camera behind a framed overlay) while the Google module
 * downloads in the background for next time. Resolves null if the user cancels.
 */
export async function scanQr(): Promise<string | null> {
  try {
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (available) {
      const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
      return barcodes[0]?.rawValue ?? null;
    }
  } catch (e) {
    // The user backing out of Google's scanner is a cancel, not a reason to open another one.
    if (/cancel/i.test(String((e as Error)?.message ?? e))) return null;
  }
  void BarcodeScanner.installGoogleBarcodeScannerModule().catch(() => {});
  return builtInScan();
}

let cancelActiveScan: (() => void) | null = null;

/** Closes the built-in scanner if it is open (the back button); returns whether it was. */
export function cancelScan(): boolean {
  if (!cancelActiveScan) return false;
  cancelActiveScan();
  return true;
}

async function builtInScan(): Promise<string | null> {
  let perm = await BarcodeScanner.checkPermissions();
  if (perm.camera !== "granted") perm = await BarcodeScanner.requestPermissions();
  if (perm.camera !== "granted") throw new Error("Sapient needs camera access to scan. You can paste the link instead.");

  const root = document.documentElement;
  const ui = document.createElement("div");
  ui.id = "qr-scanner";
  ui.innerHTML = `
    <div class="qr-top"><div class="qr-title">Scan a QR code</div><div class="qr-sub">Point the camera at the code</div></div>
    <div class="qr-frame"><i></i><i></i><i></i><i></i><div class="qr-line"></div></div>
    <div class="qr-actions">
      <button type="button" class="qr-btn" id="qr-torch" hidden>Flashlight</button>
      <button type="button" class="qr-btn" id="qr-cancel">Cancel</button>
    </div>`;
  document.body.append(ui);
  root.classList.add("scanning");

  return new Promise<string | null>((resolve, reject) => {
    let finished = false;
    let handle: { remove(): Promise<void> } | null = null;
    const finish = async (value: string | null, error?: unknown) => {
      if (finished) return;
      finished = true;
      cancelActiveScan = null;
      await handle?.remove().catch(() => {});
      await BarcodeScanner.stopScan().catch(() => {});
      root.classList.remove("scanning");
      ui.remove();
      if (error) reject(error);
      else resolve(value);
    };
    cancelActiveScan = () => void finish(null);
    ui.querySelector("#qr-cancel")!.addEventListener("click", () => void finish(null));

    void (async () => {
      try {
        handle = await BarcodeScanner.addListener("barcodesScanned", (event) => {
          const value = event.barcodes.find((b) => b.rawValue)?.rawValue;
          if (value) void finish(value);
        });
        await BarcodeScanner.startScan({ formats: [BarcodeFormat.QrCode] });
        const { available } = await BarcodeScanner.isTorchAvailable().catch(() => ({ available: false }));
        if (available && !finished) {
          const torch = ui.querySelector<HTMLButtonElement>("#qr-torch")!;
          torch.hidden = false;
          torch.addEventListener("click", async () => {
            await BarcodeScanner.toggleTorch().catch(() => {});
            torch.classList.toggle("on");
          });
        }
      } catch (e) {
        void finish(null, e);
      }
    })();
  });
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

