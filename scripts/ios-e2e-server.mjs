// CI helper for the iOS screenshot tour (src/mobile/e2e.ts). Runs on the macOS runner beside a
// booted simulator; the app (built with VITE_E2E_SHOTS=http://127.0.0.1:8765) calls:
//   /shot?name=X  -> simulator screenshot to $OUT/$PREFIX-X.png, then replies (the app waits)
//   /log?msg=M    -> printed to the job log
//   /done         -> exits 0
// Usage: UDID=<sim udid> PREFIX=iPhone16 OUT=shots node scripts/ios-e2e-server.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";

const { UDID, PREFIX = "sim", OUT = "shots", PORT = "8765" } = process.env;
if (!UDID) throw new Error("UDID is required");
mkdirSync(OUT, { recursive: true });
let failures = 0;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (url.pathname === "/shot") {
    const name = (url.searchParams.get("name") ?? "shot").replace(/[^\w.-]/g, "_");
    try {
      execFileSync("xcrun", ["simctl", "io", UDID, "screenshot", `${OUT}/${PREFIX}-${name}.png`], { stdio: "ignore" });
      console.log(`shot ${PREFIX}-${name}`);
    } catch (e) {
      console.log(`shot ${name} failed: ${e.message}`);
    }
  } else if (url.pathname === "/log") {
    const msg = url.searchParams.get("msg") ?? "";
    if (msg.startsWith("FAIL")) failures++;
    console.log(`[${PREFIX}] ${msg}`);
  } else if (url.pathname === "/done") {
    console.log(`[${PREFIX}] tour done, ${failures} failed step(s)`);
    res.end("ok");
    setTimeout(() => process.exit(failures ? 1 : 0), 100);
    return;
  }
  res.end("ok");
}).listen(Number(PORT), "127.0.0.1", () => console.log(`screenshot server on 127.0.0.1:${PORT} for ${PREFIX}`));
