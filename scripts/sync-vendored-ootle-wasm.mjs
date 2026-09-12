// pnpm's `overrides` doesn't reliably collapse every nested resolution of a `file:` dependency
// (confirmed: @tari-project/ootle-secret-key-wallet and the vendored @tari-project/ootle both still
// pull their own copy of the real registry package into the pnpm store, even with a matching
// override). Rather than fight the package manager's resolution algorithm, this runs after every
// install and directly overwrites every store copy with the vendored one, so the extension never
// silently ships two different wasm binaries -- one carrying the confidential-transfer patch, one not.
import { existsSync, cpSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(root, "vendor", "ootle-wasm-patched");
const vendorReal = realpathSync(vendorDir);

function findNestedCopies(dir, depth = 0) {
  if (depth > 8) return [];
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name === "ootle-wasm" && existsSync(join(full, "ootle_wasm_bg.wasm"))) {
      if (realpathSync(full) !== vendorReal) found.push(full);
    }
    if (entry.name === "node_modules" || entry.name.startsWith("@") || entry.name === ".bin" || entry.name === ".pnpm" || entry.name.startsWith("@tari-project+")) {
      found.push(...findNestedCopies(full, depth + 1));
    }
  }
  return found;
}

const nodeModules = join(root, "node_modules");
if (existsSync(nodeModules) && existsSync(vendorDir)) {
  const nested = findNestedCopies(nodeModules);
  for (const dir of nested) {
    try {
      for (const file of ["ootle_wasm.js", "ootle_wasm_bg.js", "ootle_wasm_bg.wasm", "ootle_wasm.d.ts", "ootle_wasm_bg.wasm.d.ts"]) {
        const src = join(vendorDir, file);
        const dest = join(dir, file);
        if (existsSync(src) && realpathSync(src) !== (existsSync(dest) ? realpathSync(dest) : "")) {
          cpSync(src, dest);
        }
      }
      console.log(`[sync-vendored-ootle-wasm] synced vendor build into ${dir}`);
    } catch (e) {
      console.warn(`[sync-vendored-ootle-wasm] skipped ${dir}: ${e.message}`);
    }
  }
}
