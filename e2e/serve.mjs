// Static server for the end-to-end tests (started by playwright.config.ts):
//   /            -> dist-mobile/ (the Android app's web bundle, run in a phone-sized browser)
//   /dapp.html   -> a blank page for the extension tests to call window.tari from
// Unknown paths fall back to the app's index.html, as the Capacitor WebView does.
import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "dist-mobile");
const port = Number(process.argv[3] ?? 5180);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (path === "/dapp.html") {
      res.setHeader("content-type", types[".html"]);
      res.end("<!doctype html><meta charset=utf-8><title>Test dApp</title><body>Test dApp</body>");
      return;
    }
    let file = normalize(join(root, path));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) file = join(root, "index.html");
    res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  })
  .listen(port, "127.0.0.1", () => console.log(`e2e server on http://127.0.0.1:${port} serving ${root}`));
