import { defineConfig } from "vitest/config";

// A separate config from vite.config.ts deliberately: that one wires up the CRX/wasm/top-level-await
// plugins needed to package the extension, none of which the unit tests below need — they only
// exercise pure logic (parsing, validation, error classification), so keeping this config minimal
// keeps the test run fast and independent of the extension build pipeline.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
