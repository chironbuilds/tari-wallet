// Release-integrity checks on the built artifacts (run after `pnpm package` and `pnpm build:mobile`).
// Catches the mistakes that tests of the code itself can't: mismatched version numbers, a manifest
// pointing at files the build didn't produce, permission creep, a loosened CSP, remote code, a
// store zip Chrome can't read, and bundles that suddenly balloon.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
};
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const sizeOf = (dir) => walk(dir).reduce((n, f) => n + statSync(f).size, 0);

// ---- versions agree everywhere a release carries one
const pkg = json("package.json");
const manifest = json("manifest.json");
const gradle = readFileSync(join(root, "android/app/build.gradle"), "utf8");
const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1];
const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
check(manifest.version === pkg.version, `manifest.json version ${manifest.version} = package.json ${pkg.version}`);
check(versionName === pkg.version, `Android versionName ${versionName} = package.json ${pkg.version}`);
check(Number.isInteger(versionCode) && versionCode > 0, `Android versionCode ${versionCode} is a positive integer`);
check(/^\d+\.\d+\.\d+$/.test(pkg.version), `version ${pkg.version} is plain x.y.z (the Chrome Web Store rejects anything else)`);

// ---- the built extension manifests (Chrome, and Firefox: same extension, event-page background)
// Permission creep is what store review and users notice; change these lists deliberately.
const EXPECTED_PERMISSIONS = ["alarms", "storage"];
const EXPECTED_HOSTS = ["http://127.0.0.1/*", "http://localhost/*", "https://*.tari.com/*"];
const dist = join(root, "dist");
const firefoxDist = join(root, "dist-firefox");

function checkManifest(name, dir) {
  const built = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  check(built.manifest_version === 3, `${name}: built manifest is Manifest V3`);
  check(built.version === pkg.version, `${name}: built manifest version ${built.version} = ${pkg.version}`);
  const referenced = new Set([
    built.background?.service_worker,
    ...(built.background?.scripts ?? []),
    built.action?.default_popup,
    ...Object.values(built.icons ?? {}),
    ...Object.values(built.action?.default_icon ?? {}),
    ...(built.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
    ...(built.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []),
  ]);
  referenced.delete(undefined);
  for (const file of referenced) check(existsSync(join(dir, file)), `${name}: manifest references existing file ${file}`);
  check(
    JSON.stringify([...(built.permissions ?? [])].sort()) === JSON.stringify(EXPECTED_PERMISSIONS),
    `${name}: permissions are exactly ${EXPECTED_PERMISSIONS.join(", ")} (got ${(built.permissions ?? []).join(", ")})`,
  );
  check(
    JSON.stringify([...(built.host_permissions ?? [])].sort()) === JSON.stringify(EXPECTED_HOSTS),
    `${name}: host_permissions are exactly ${EXPECTED_HOSTS.join(", ")}`,
  );
  const csp = built.content_security_policy?.extension_pages ?? "";
  const scriptSrc = csp.match(/script-src([^;]*)/)?.[1].trim().split(/\s+/) ?? [];
  check(
    scriptSrc.length > 0 && scriptSrc.every((s) => s === "'self'" || s === "'wasm-unsafe-eval'"),
    `${name}: extension CSP script-src allows only 'self' and 'wasm-unsafe-eval' (got: ${scriptSrc.join(" ")})`,
  );
  return built;
}

const chromeBuilt = checkManifest("chrome", dist);
check(typeof chromeBuilt.background?.service_worker === "string", "chrome: background is a service worker");
const firefoxBuilt = checkManifest("firefox", firefoxDist);
check(
  Array.isArray(firefoxBuilt.background?.scripts) && !firefoxBuilt.background.service_worker,
  "firefox: background is an event page (background.scripts), not a service worker",
);
const gecko = firefoxBuilt.browser_specific_settings?.gecko ?? {};
check(gecko.id === "sapient@erebuslab", `firefox: gecko add-on id is stable (got ${gecko.id}); changing it orphans every install`);
check(Number.parseFloat(gecko.strict_min_version) >= 128, "firefox: strict_min_version is at least 128 (MAIN-world content scripts)");
check(JSON.stringify(gecko.data_collection_permissions?.required) === '["none"]', "firefox: declares no data collection");
check(!("minimum_chrome_version" in firefoxBuilt), "firefox: no Chrome-only manifest keys");

// ---- no remote code, no eval, in either bundle
const mobile = join(root, "dist-mobile");
for (const [name, dir] of [
  ["extension", dist],
  ["firefox", firefoxDist],
  ["mobile", mobile],
]) {
  const files = walk(dir);
  const html = files.filter((f) => f.endsWith(".html"));
  const js = files.filter((f) => f.endsWith(".js"));
  const remote = html.filter((f) => /<(script|link)[^>]+(src|href)=["']https?:\/\//i.test(readFileSync(f, "utf8")));
  check(remote.length === 0, `${name}: no HTML loads scripts or styles from a remote URL${remote.length ? ` (${remote.join(", ")})` : ""}`);
  const evals = js.filter((f) => /\beval\(|new Function\(/.test(readFileSync(f, "utf8")));
  check(evals.length === 0, `${name}: no eval()/new Function() in the bundle${evals.length ? ` (${evals.join(", ")})` : ""}`);
  check(js.some((f) => statSync(f).size > 0) && files.some((f) => f.endsWith(".wasm")), `${name}: bundle includes its JS and wasm`);
}
const mobileHtml = readFileSync(join(mobile, "index.html"), "utf8");
check(/http-equiv="Content-Security-Policy"/i.test(mobileHtml), "mobile: index.html carries a Content-Security-Policy");
check(!/script-src[^;"]*'unsafe-eval'/.test(mobileHtml), "mobile: CSP does not allow 'unsafe-eval'");

// ---- size budgets (generous; a sudden jump means a dependency or asset slipped in)
const MB = 1024 * 1024;
const distSize = sizeOf(dist);
const firefoxSize = sizeOf(firefoxDist);
check(firefoxSize < 8 * MB, `firefox bundle ${(firefoxSize / MB).toFixed(1)} MB is under 8 MB`);
const mobileSize = sizeOf(mobile);
check(distSize < 8 * MB, `extension bundle ${(distSize / MB).toFixed(1)} MB is under 8 MB`);
check(mobileSize < 10 * MB, `mobile bundle ${(mobileSize / MB).toFixed(1)} MB is under 10 MB`);

// ---- the store packages: the Chrome Web Store zip and the addons.mozilla.org .xpi
function checkZip(label, zipPath, dir, command) {
  if (!existsSync(zipPath)) {
    check(false, `${label} ${zipPath} exists (run pnpm ${command})`);
  } else {
    const zip = readFileSync(zipPath);
    const entries = [];
    // Walk the central directory (end-of-central-directory record is the last 22 bytes, no comment).
    const eocd = zip.length - 22;
    check(zip.readUInt32LE(eocd) === 0x06054b50, `${label} has a valid end-of-central-directory record`);
    let p = zip.readUInt32LE(eocd + 16);
    const count = zip.readUInt16LE(eocd + 10);
    for (let i = 0; i < count; i++) {
      const nameLen = zip.readUInt16LE(p + 28);
      const extraLen = zip.readUInt16LE(p + 30);
      const commentLen = zip.readUInt16LE(p + 32);
      const localOffset = zip.readUInt32LE(p + 42);
      const method = zip.readUInt16LE(p + 10);
      const compSize = zip.readUInt32LE(p + 20);
      entries.push({ name: zip.toString("utf8", p + 46, p + 46 + nameLen), localOffset, method, compSize });
      p += 46 + nameLen + extraLen + commentLen;
    }
    check(entries.length === walk(dir).length, `${label} has every dist file (${entries.length} of ${walk(dir).length})`);
    check(entries.every((e) => !e.name.includes("\\")), `${label} entry names use forward slashes only`);
    const man = entries.find((e) => e.name === "manifest.json");
    check(!!man, `${label} has manifest.json at its root`);
    if (man) {
      const lp = man.localOffset;
      const start = lp + 30 + zip.readUInt16LE(lp + 26) + zip.readUInt16LE(lp + 28);
      const raw = zip.subarray(start, start + man.compSize);
      const text = (man.method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
      check(JSON.parse(text).version === pkg.version, `${label}'s manifest.json decompresses and has the release version`);
    }
  }
}
checkZip("store zip", join(root, `sapient-wallet-${pkg.version}.zip`), dist, "package");
checkZip("Firefox .xpi", join(root, `sapient-wallet-firefox-${pkg.version}.xpi`), firefoxDist, "package:firefox");

if (failures.length) {
  console.error(`\n${failures.length} release check(s) failed.`);
  process.exit(1);
}
console.log("\nAll release checks passed.");
