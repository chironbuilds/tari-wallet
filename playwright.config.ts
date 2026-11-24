import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against the real builds: `dist/` loaded as an unpacked extension in Chromium,
// and `dist-mobile/` (the Android app's web bundle) at phone size. Build both first:
//   pnpm build && pnpm build:mobile && pnpm test:e2e
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node e2e/serve.mjs dist-mobile 5180",
    url: "http://127.0.0.1:5180/dapp.html",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "extension", testMatch: /extension\..*spec\.ts/ },
    {
      name: "mobile",
      testMatch: /mobile\..*spec\.ts/,
      use: { ...devices["Pixel 7"], baseURL: "http://127.0.0.1:5180" },
    },
  ],
});
