import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import manifest from "./manifest.json" with { type: "json" };

export default defineConfig({
  plugins: [wasm(), crx({ manifest })],
  build: {
    target: "es2022",
    // The wasm-bindgen "bundler" output eagerly instantiates on import (top-level
    // wasm.__wbindgen_start()), so wasm bytes must not be split into a lazy async chunk.
    rollupOptions: {
      output: {
        inlineDynamicImports: false,
      },
    },
  },
});
