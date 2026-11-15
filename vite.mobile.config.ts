// Build for the Android app (Capacitor): the same popup UI and wallet core as the extension, from
// mobile.html, without the CRX plugin. Output goes to dist-mobile/, which capacitor.config.ts
// points the native project at.
import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import pkg from "./package.json" with { type: "json" };

/** Capacitor serves index.html; the entry is mobile.html so it can sit beside the extension's popup.html. */
function entryAsIndexHtml(): Plugin {
  return {
    name: "entry-as-index-html",
    apply: "build",
    closeBundle() {
      const from = resolve("dist-mobile", "mobile.html");
      if (existsSync(from)) renameSync(from, resolve("dist-mobile", "index.html"));
    },
  };
}

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), entryAsIndexHtml()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "es2022",
    outDir: "dist-mobile",
    emptyOutDir: true,
    rollupOptions: {
      input: { index: "mobile.html" },
      output: {
        codeSplitting: true,
      },
    },
  },
});
