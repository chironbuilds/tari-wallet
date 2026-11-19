// Screenshot tour for CI (.github/workflows/ios.yml, simulator job). Bundled ONLY when the build sets
// VITE_E2E_SHOTS (the URL of scripts/ios-e2e-server.mjs on the CI Mac); release builds never
// contain it. Walks a fresh throwaway wallet through the main screens and asks the server for a
// simulator screenshot at each stop. Moves no funds: nothing is ever submitted.
import { closePairingSheet } from "./pairUi";

const PASSWORD = "Sim-Tour-Pass-9x!";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

export async function runScreenshotTour(server: string): Promise<void> {
  const call = (path: string) => fetch(`${server}${path}`, { mode: "no-cors", cache: "no-store" }).catch(() => undefined);
  const log = (msg: string) => call(`/log?msg=${encodeURIComponent(msg)}`);
  const shot = async (name: string) => {
    await sleep(700); // let transitions settle
    await call(`/shot?name=${encodeURIComponent(name)}`);
  };
  const waitFor = async (sel: string, ms = 20_000) => {
    for (let t = 0; t < ms; t += 250) {
      const el = $(sel);
      if (el) return el;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${sel}`);
  };
  const click = async (sel: string, ms?: number) => (await waitFor(sel, ms)).click();
  const fill = (sel: string, value: string) => {
    const el = $<HTMLInputElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const tab = async (id: string) => {
    await click(`#tab-bar [data-tab="${id}"]`);
    await sleep(1800);
  };
  const back = async () => {
    const b = $(".app-bar-back:not([hidden])");
    if (b) b.click();
    await sleep(1500);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      await log(`PASS ${name}`);
    } catch (e) {
      await log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
      await shot(`fail-${name}`);
    }
  };

  await log(`tour start ${navigator.userAgent}`);
  await step("welcome", async () => {
    await waitFor("#create", 30_000);
    await shot("01-welcome");
  });
  await step("create-wallet", async () => {
    await click("#create");
    await waitFor("#pw2");
    fill("#pw", PASSWORD);
    fill("#pw2", PASSWORD);
    await shot("02-set-password");
    await click("#submit");
    await waitFor(".mnemonic-grid", 60_000);
    await shot("03-recovery-phrase"); // a throwaway simulator wallet, never funded
    const words = [...document.querySelectorAll(".mnemonic-word")].map((w) => (w.lastChild?.textContent ?? "").trim());
    await click("#confirm");
    await waitFor("#app label");
    const labels = [...document.querySelectorAll("#app label")];
    for (const label of labels) {
      const n = Number(/\d+/.exec(label.textContent ?? "")?.[0]);
      const input = label.nextElementSibling as HTMLInputElement | null;
      if (n && input?.tagName === "INPUT") input.value = words[n - 1] ?? "";
    }
    await shot("04-verify-phrase");
    await click("#confirm");
    await waitFor(".account-summary", 90_000);
    await sleep(5000); // balances
    await shot("05-home");
  });
  await step("receive", async () => {
    await click("#receiveAction");
    await waitFor(".qr-card svg");
    await shot("06-receive");
    await back();
  });
  await step("send", async () => {
    await click("#sendAction");
    await sleep(2500);
    await shot("07-send");
    await back();
  });
  await step("activity", async () => {
    await tab("activity");
    await shot("08-activity");
  });
  await step("scan", async () => {
    await tab("scan");
    await shot("09-connect-dapp");
    closePairingSheet();
    await sleep(800);
  });
  await step("dapps", async () => {
    await tab("dapps");
    await shot("10-dapps");
  });
  await step("settings", async () => {
    await tab("settings");
    await shot("11-settings");
    window.scrollTo(0, document.body.scrollHeight);
    document.scrollingElement?.scrollTo(0, document.scrollingElement.scrollHeight);
    await sleep(600);
    await shot("12-settings-bottom");
  });
  await step("lock", async () => {
    await tab("settings");
    await click("#lock");
    await waitFor("#unlock");
    await shot("13-locked");
    fill("#pw", PASSWORD);
    await click("#unlock");
    await waitFor(".account-summary", 60_000);
    await sleep(2000);
    await shot("14-unlocked-home");
  });
  await call("/done");
}
