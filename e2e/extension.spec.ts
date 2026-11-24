// The built Chrome extension (dist/) in real Chromium: onboarding, lock/unlock, recovery, settings,
// and the window.tari dApp API with its approval windows. Nothing here needs funds.
import { test as base, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PASSWORD, createWallet, createWalletWithWrongQuiz, expectHome, importWallet, trackErrors } from "./helpers";

const EXT = resolve("dist");
const DAPP = "http://127.0.0.1:5180/dapp.html";

type Fixtures = { context: BrowserContext; extensionId: string; popup: Page; errors: string[] };

const pageErrors = new WeakMap<Page, string[]>();

const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sapient-e2e-")), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await use(ctx);
    await ctx.close();
  },
  extensionId: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await use(new URL(sw.url()).host);
  },
  popup: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    pageErrors.set(page, trackErrors(page));
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await use(page);
  },
  errors: async ({ popup }, use) => {
    await use(pageErrors.get(popup) ?? []);
  },
});

/** The wallet's state as the popup's background reports it. */
async function status(popup: Page): Promise<{ address: string; receiveAddress: string; network: string; locked?: boolean }> {
  return popup.evaluate(
    () =>
      new Promise((res, rej) =>
        chrome.runtime.sendMessage({ kind: "popup-get-status" }, (r: { ok: boolean; result: unknown; error?: string }) =>
          r?.ok ? res(r.result) : rej(new Error(r?.error ?? "no response")),
        ),
      ),
  ) as never;
}

async function openDapp(context: BrowserContext) {
  const dapp = await context.newPage();
  await dapp.goto(DAPP);
  await dapp.waitForFunction(() => typeof (window as unknown as { tari?: unknown }).tari !== "undefined", null, { timeout: 15_000 });
  const call = (method: string, params?: unknown) =>
    dapp.evaluate(
      ([m, p]) =>
        (window as unknown as { tari: { request(a: unknown): Promise<unknown> } }).tari.request({ method: m, params: p }).then(
          (ok) => ({ ok, err: undefined as string | undefined, code: undefined as number | undefined }),
          (e: { message?: string; code?: number }) => ({ ok: undefined, err: e?.message ?? String(e), code: e?.code }),
        ),
      [method, params] as const,
    );
  return { dapp, call };
}

function nextApproval(context: BrowserContext) {
  return context.waitForEvent("page", { predicate: (p) => p.url().includes("#/approve/"), timeout: 20_000 }).then(async (p) => {
    await p.waitForLoadState();
    await p.waitForSelector("button", { timeout: 20_000 });
    return p;
  });
}

async function connect(context: BrowserContext, call: Awaited<ReturnType<typeof openDapp>>["call"]) {
  const approval = nextApproval(context);
  const pending = call("tari_requestAccounts");
  const win = await approval;
  await expect(win.getByText(/Connection request/i).first()).toBeVisible();
  await win.getByRole("button", { name: "Connect" }).click().catch(() => {}); // the window closes itself
  return pending;
}

test.describe("onboarding", () => {
  test("boots to the welcome screen without errors", async ({ popup, errors }) => {
    await expect(popup.locator("#create")).toBeVisible();
    await expect(popup.locator("#import")).toBeVisible();
    await popup.waitForTimeout(1000);
    expect(errors).toEqual([]);
  });

  test("creates a wallet and lands on Home", async ({ popup }) => {
    const words = await createWallet(popup);
    expect(new Set(words).size).toBeGreaterThan(12);
    const s = await status(popup);
    expect(s.address).toMatch(/^component_[0-9a-f]{64}$/);
    expect(s.receiveAddress).toMatch(/^otl_1[a-z0-9]+$/); // mainnet by default
    expect(s.network).toBe("mainnet");
  });

  test("a wrong answer to the backup quiz does not create the wallet", async ({ popup }) => {
    await createWalletWithWrongQuiz(popup);
    await expect(popup.locator("#status")).toBeVisible();
    await expect(popup.locator("#addrPill")).toHaveCount(0);
  });

  test("rejects mismatched and weak passwords", async ({ popup }) => {
    await popup.click("#create");
    await popup.fill("#pw", PASSWORD);
    await popup.fill("#pw2", PASSWORD + "x");
    await popup.click("#submit");
    await expect(popup.locator("#status")).toBeVisible();
    await popup.fill("#pw", "password");
    await popup.fill("#pw2", "password");
    await popup.click("#submit");
    await expect(popup.locator("#status")).toBeVisible();
    await expect(popup.getByText("I've saved my recovery phrase")).toHaveCount(0);
  });

  test("rejects an invalid recovery phrase on import", async ({ popup }) => {
    await popup.click("#import");
    await popup.fill("#mnemonic", "not a real recovery phrase at all");
    await popup.fill("#pw", PASSWORD);
    await popup.fill("#pw2", PASSWORD);
    await popup.click("#submit");
    await expect(popup.locator("#status")).toBeVisible();
    await expect(popup.locator("#addrPill")).toHaveCount(0);
  });
});

test.describe("recovery", () => {
  test("importing a wallet's recovery phrase restores the same account", async ({ popup }) => {
    const words = await createWallet(popup);
    const original = await status(popup);

    // A brand-new browser profile, as on another machine.
    const ctx2 = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sapient-e2e-")), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    try {
      const sw = ctx2.serviceWorkers()[0] ?? (await ctx2.waitForEvent("serviceworker"));
      const page = await ctx2.newPage();
      await page.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
      await importWallet(page, words);
      const restored = await status(page);
      expect(restored.address).toBe(original.address);
      expect(restored.receiveAddress).toBe(original.receiveAddress);
    } finally {
      await ctx2.close();
    }
  });
});

test.describe("lock and unlock", () => {
  test("locks, refuses a wrong password, unlocks with the right one", async ({ popup }) => {
    await createWallet(popup);
    await popup.click("#settingsBtn");
    await popup.click("#lock");
    await expect(popup.locator("#unlock")).toBeVisible();

    await popup.fill("#pw", "Wrong-Password-1!");
    await popup.click("#unlock");
    await expect(popup.locator("#status")).toBeVisible();
    await expect(popup.locator("#addrPill")).toHaveCount(0);

    await popup.fill("#pw", PASSWORD);
    await popup.click("#unlock");
    await expectHome(popup);
  });

  test("a reopened popup is still unlocked within the auto-lock window", async ({ popup, context, extensionId }) => {
    await createWallet(popup);
    await popup.close();
    const again = await context.newPage();
    await again.goto(`chrome-extension://${extensionId}/popup.html`);
    await expectHome(again);
  });
});

test.describe("settings", () => {
  test("switching to Esmeralda changes the network and the address prefix", async ({ popup }) => {
    await createWallet(popup);
    await popup.click("#settingsBtn");
    await popup.selectOption("#network", "esmeralda");
    // Switching networks may ask for confirmation.
    const confirm = popup.getByRole("button", { name: /switch|confirm/i });
    if (await confirm.first().isVisible().catch(() => false)) await confirm.first().click();
    await expect.poll(async () => (await status(popup)).network, { timeout: 20_000 }).toBe("esmeralda");
    expect((await status(popup)).receiveAddress).toMatch(/^otl_esm_1/);
  });

  test("offers the expected auto-lock choices", async ({ popup }) => {
    await createWallet(popup);
    await popup.click("#settingsBtn");
    const values = await popup.$$eval("#autoLock option", (os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values).toEqual(["1", "5", "15", "30", "60", "0"]);
  });
});

test.describe("dApp API (window.tari)", () => {
  test("refuses an unconnected site", async ({ popup, context }) => {
    await createWallet(popup);
    const { call } = await openDapp(context);
    const r = await call("tari_getAccounts");
    // Either an error or an empty list: an unconnected site learns nothing about the wallet.
    if (r.ok !== undefined) expect(r.ok).toEqual([]);
    else expect(r.err).toBeTruthy();
    // Nothing that signs is reachable without connecting first.
    const sign = await call("tari_signWalletOwnershipChallenge", { challenge: "e2e-unconnected" });
    expect(sign.ok).toBeUndefined();
    expect(sign.err).toMatch(/not connected/i);
  });

  test("connects, reports the network, and signs an approved challenge", async ({ popup, context }) => {
    await createWallet(popup);
    const own = await status(popup);
    const { call } = await openDapp(context);

    const accounts = await connect(context, call);
    expect(accounts.err).toBeUndefined();
    expect(accounts.ok).toEqual([own.address]);

    const net = await call("tari_getNetwork");
    expect(net.ok).toBe("mainnet");

    const approval = nextApproval(context);
    const signing = call("tari_signWalletOwnershipChallenge", { challenge: "e2e-approve" });
    await (await approval).click("#approve").catch(() => {});
    const signed = await signing;
    expect(signed.err).toBeUndefined();
    const result = signed.ok as { signature?: unknown; walletAddress?: string };
    expect(result.signature).toBeTruthy();
    expect(result.walletAddress).toBe(own.receiveAddress);
  });

  test("Reject and closing the approval window both refuse with code 4001", async ({ popup, context }) => {
    await createWallet(popup);
    const { call } = await openDapp(context);
    await connect(context, call);

    let approval = nextApproval(context);
    let pending = call("tari_signWalletOwnershipChallenge", { challenge: "e2e-reject" });
    await (await approval).click("#reject").catch(() => {});
    let r = await pending;
    expect(r.code).toBe(4001);

    approval = nextApproval(context);
    pending = call("tari_signWalletOwnershipChallenge", { challenge: "e2e-close" });
    await (await approval).close();
    r = await pending;
    expect(r.code).toBe(4001);
  });

  test("a rejected connection leaves the site unconnected", async ({ popup, context }) => {
    await createWallet(popup);
    const { call } = await openDapp(context);
    const approval = nextApproval(context);
    const pending = call("tari_requestAccounts");
    await (await approval).click("#reject").catch(() => {});
    const r = await pending;
    expect(r.code).toBe(4001);
    const accounts = await call("tari_getAccounts");
    if (accounts.ok !== undefined) expect(accounts.ok).toEqual([]);
    else expect(accounts.err).toBeTruthy();
    const sign = await call("tari_signWalletOwnershipChallenge", { challenge: "e2e-unconnected" });
    expect(sign.ok).toBeUndefined();
    expect(sign.err).toMatch(/not connected/i);
  });

  test("requests are refused while the wallet is locked", async ({ popup, context }) => {
    await createWallet(popup);
    const { call } = await openDapp(context);
    await connect(context, call);
    await popup.click("#settingsBtn");
    await popup.click("#lock");
    await expect(popup.locator("#unlock")).toBeVisible();

    // Locked: a signing request must not produce a signature without the user unlocking.
    const pending = call("tari_signWalletOwnershipChallenge", { challenge: "e2e-locked" });
    const outcome = await Promise.race([
      pending,
      new Promise<{ ok: undefined; err: string; code: undefined }>((res) =>
        setTimeout(() => res({ ok: undefined, err: "still waiting (needs unlock)", code: undefined }), 8_000),
      ),
    ]);
    expect(outcome.ok).toBeUndefined();
  });
});
