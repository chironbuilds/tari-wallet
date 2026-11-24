import { defineConfig } from "vitest/config";

// A separate config from vite.config.ts deliberately: that one wires up the CRX/wasm/top-level-await
// plugins needed to package the extension, none of which the unit tests below need — they only
// exercise pure logic (parsing, validation, error classification), so keeping this config minimal
// keeps the test run fast and independent of the extension build pipeline.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // @tari-project/ootle >= 0.19 imports @tari-project/ootle-ts-bindings at runtime, whose ESM uses
    // extensionless relative imports plain Node cannot resolve; let Vite transform the deps instead.
    server: { deps: { inline: true } },
    // `pnpm test:coverage`. Unit-test coverage only: the UI (popup/main.ts, ui/, mobile/) is mostly
    // exercised by the Playwright suite in e2e/, which this doesn't count. The floors sit just under
    // today's figures so coverage can only go up; raise them as tests are added.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      reporter: ["text-summary", "html", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 13,
        branches: 14,
        functions: 16,
        lines: 13,
        // The pure logic (seed format, storage, formatting, validation) is where unit tests belong.
        "src/lib/**/*.ts": { lines: 75, statements: 74 },
      },
    },
  },
});
