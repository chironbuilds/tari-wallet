// Build for Firefox: the same extension as vite.config.ts, written to dist-firefox/. Firefox has no
// MV3 service workers, so the background runs as an event page (background.scripts), and AMO wants
// a gecko add-on id, a minimum version and a data-collection declaration. Everything else in the
// manifest is shared with Chrome.
import { crx, type ManifestV3Export } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import chromeManifest from "./manifest.json" with { type: "json" };

const { minimum_chrome_version: _chromeOnly, background, ...shared } = chromeManifest;

const manifest = {
  ...shared,
  background: { scripts: [background.service_worker], type: background.type },
  browser_specific_settings: {
    gecko: {
      id: "sapient@erebuslab",
      // 128 for "world": "MAIN" content scripts (the injected provider); 140 (142 on Android) for the
      // data_collection_permissions key AMO now requires.
      strict_min_version: "142.0",
      data_collection_permissions: { required: ["none"] },
    },
  },
} as unknown as ManifestV3Export;

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), crx({ manifest, browser: "firefox" })],
  build: {
    target: "es2022",
    outDir: "dist-firefox",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: false,
      },
    },
  },
});
