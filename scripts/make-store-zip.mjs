// Builds a Chrome-Web-Store-ready zip of dist/ with POSIX forward-slash entry names.
// Needed because PowerShell's Compress-Archive / System.IO.Compression.ZipFile write
// backslash-separated entry names on Windows, which Chrome's zip reader (spec-compliant,
// forward-slash-only) treats as literal characters in a flat filename instead of a directory
// separator -- breaking the extension's own manifest-relative asset paths on upload.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const outPath = join(root, `sapient-wallet-${version}.zip`);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dosDate };
}

const files = walk(distDir).sort();
const localChunks = [];
const centralChunks = [];
let offset = 0;
const { time, dosDate } = dosDateTime(new Date());

for (const absPath of files) {
  const nameForZip = relative(distDir, absPath).split("\\").join("/");
  const nameBuf = Buffer.from(nameForZip, "utf8");
  const data = readFileSync(absPath);
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const useStore = compressed.length >= data.length;
  const payload = useStore ? data : compressed;
  const method = useStore ? 0 : 8;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt16LE(time, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(payload.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  localChunks.push(localHeader, nameBuf, payload);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(method, 10);
  centralHeader.writeUInt16LE(time, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(payload.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(offset, 42);

  centralChunks.push(centralHeader, nameBuf);
  offset += localHeader.length + nameBuf.length + payload.length;
}

const centralDirStart = offset;
const centralDir = Buffer.concat(centralChunks);
offset += centralDir.length;

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralDir.length, 12);
eocd.writeUInt32LE(centralDirStart, 16);
eocd.writeUInt16LE(0, 20);

writeFileSync(outPath, Buffer.concat([...localChunks, centralDir, eocd]));
console.log(`Wrote ${outPath} (${files.length} files)`);
