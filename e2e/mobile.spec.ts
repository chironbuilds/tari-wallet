// The Android app's web bundle (dist-mobile/) at phone size in Chromium. Capacitor's web fallbacks
// stand in for the native plugins, so this covers the app's own UI: onboarding, tabs, lock/unlock,
// recovery and layout. Native-only parts (biometrics, camera, WalletConnect) are not exercised.
import { test, expect, type Page } from "@playwright/test";
import { PASSWORD, createWallet, expectHome, importWallet, trackErrors } from "./helpers";

const TABS = ["home", "activity", "dapps", "settings"] as const;

async function open(page: Page): Promise<string[]> {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator("#create")).toBeVisible({ timeout: 30_000 });
  return errors;
}

/** True when the page scrolls sideways at the current width (content wider than the screen). */
async function overflowsHorizontally(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const app = document.getElementById("app");
    return doc.scrollWidth > doc.clientWidth + 1 || (!!app && app.scrollWidth > app.clientWidth + 1);
  });
}

test("boots to the welcome screen without errors", async ({ page }) => {
  const errors = await open(page);
  await expect(page.locator("#import")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);
  expect(await overflowsHorizontally(page)).toBe(false);
});

test("creates a wallet; every tab opens and fits the screen", async ({ page }) => {
  const errors = await open(page);
  await createWallet(page);
  await expect(page.locator("#tab-bar")).toBeVisible();
  for (const tab of TABS) {
    await page.click(`#tab-bar [data-tab="${tab}"]`);
    await expect(page.locator(`#tab-bar [data-tab="${tab}"]`)).toHaveAttribute("aria-current", /page|true/);
    await page.waitForTimeout(400); // screen transition
    expect(await overflowsHorizontally(page), `tab ${tab} overflows sideways`).toBe(false);
  }
  expect(errors).toEqual([]);
});

test("fits a small 360px-wide phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page);
  await createWallet(page);
  for (const tab of TABS) {
    await page.click(`#tab-bar [data-tab="${tab}"]`);
    await page.waitForTimeout(400);
    expect(await overflowsHorizontally(page), `tab ${tab} overflows sideways at 360px`).toBe(false);
  }
});

test("locks from Settings and unlocks only with the right password", async ({ page }) => {
  await open(page);
  await createWallet(page);
  await page.click('#tab-bar [data-tab="settings"]');
  await page.click("#lock");
  await expect(page.locator("#unlock")).toBeVisible();
  await expect(page.locator("#tab-bar")).toBeHidden();

  await page.fill("#pw", "Wrong-Password-1!");
  await page.click("#unlock");
  await expect(page.locator("#status")).toBeVisible();

  await page.fill("#pw", PASSWORD);
  await page.click("#unlock");
  await expectHome(page);
});

test("importing the recovery phrase on another device restores the same account", async ({ page, browser }) => {
  await open(page);
  const words = await createWallet(page);
  const original = await page.locator("#addrPill").innerText();

  const other = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  try {
    const page2 = await other.newPage();
    await page2.goto("http://127.0.0.1:5180/");
    await expect(page2.locator("#import")).toBeVisible({ timeout: 30_000 });
    await importWallet(page2, words);
    expect(await page2.locator("#addrPill").innerText()).toBe(original);
  } finally {
    await other.close();
  }
});
