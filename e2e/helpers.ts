import { expect, type Page } from "@playwright/test";

export const PASSWORD = "E2e-Test-Pass-7q!";

/** Collects uncaught page errors and console errors so a test can assert the page ran clean. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Network failures to the live indexer are not app bugs; the app shows its own offline state.
    if (/Failed to load resource|net::ERR_|Failed to fetch/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

/** Fills the password form (create or import). */
async function fillPasswords(page: Page, password = PASSWORD) {
  await page.fill("#pw", password);
  await page.fill("#pw2", password);
  await page.click("#submit");
}

/** Reads the recovery phrase off the backup screen. */
async function readBackupWords(page: Page): Promise<string[]> {
  await page.getByText("I've saved my recovery phrase").waitFor();
  const words = await page.$$eval("#app li, #app [class*=word]", (els) =>
    els.map((e) => (e as HTMLElement).innerText.replace(/^\d+\s*/, "").trim()).filter(Boolean),
  );
  expect(words.length, "recovery phrase word count").toBe(24);
  return words;
}

/** Answers the "confirm your recovery phrase" quiz (three random words) from `words`. */
async function answerQuiz(page: Page, words: string[], wrong = false) {
  for (const label of await page.$$("#app label")) {
    const n = Number(((await label.innerText()).match(/\d+/) ?? ["0"])[0]);
    const word = wrong ? "wrongword" : words[n - 1]!;
    await label.evaluate((l, w) => {
      const input = l.nextElementSibling as HTMLInputElement;
      input.value = w;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, word);
  }
  await page.click("#confirm");
}

/** Creates a new wallet from the welcome screen and returns its recovery phrase. Ends on Home. */
export async function createWallet(page: Page): Promise<string[]> {
  await page.click("#create");
  await fillPasswords(page);
  const words = await readBackupWords(page);
  await page.getByText("I've saved my recovery phrase").click();
  await answerQuiz(page, words);
  await expectHome(page);
  return words;
}

/** Starts creating a wallet and answers the backup quiz wrongly; the wallet must not be created. */
export async function createWalletWithWrongQuiz(page: Page) {
  await page.click("#create");
  await fillPasswords(page);
  const words = await readBackupWords(page);
  await page.getByText("I've saved my recovery phrase").click();
  await answerQuiz(page, words, true);
}

/** Imports a wallet from a recovery phrase. Ends on Home. */
export async function importWallet(page: Page, words: string[]) {
  await page.click("#import");
  await page.fill("#mnemonic", words.join(" "));
  await fillPasswords(page);
  await expectHome(page);
}

export async function expectHome(page: Page) {
  await expect(page.locator("#addrPill")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Account 1").first()).toBeVisible();
}
