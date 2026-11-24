// Turns coverage/coverage-summary.json into a Markdown table per source folder, plus the least
// covered large files. In CI it's appended to the job summary ($GITHUB_STEP_SUMMARY); locally it
// prints to stdout.
import { appendFileSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";

const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const pct = (c, t) => (t ? ((100 * c) / t).toFixed(1) : "–");
const folders = new Map();
const files = [];
for (const [file, v] of Object.entries(summary)) {
  if (file === "total") continue;
  const rel = relative(process.cwd(), file).split(sep).join("/");
  const folder = rel.split("/").slice(0, 2).join("/");
  const f = folders.get(folder) ?? { covered: 0, total: 0 };
  f.covered += v.lines.covered;
  f.total += v.lines.total;
  folders.set(folder, f);
  files.push({ rel, ...v.lines });
}

const t = summary.total;
const lines = [
  "## Unit-test coverage",
  "",
  `**Lines ${t.lines.pct}%** · statements ${t.statements.pct}% · branches ${t.branches.pct}% · functions ${t.functions.pct}%`,
  "",
  "UI code (popup, ui, mobile) is mostly covered by the Playwright end-to-end tests, which this doesn't count.",
  "",
  "| Folder | Lines covered | % |",
  "|---|---:|---:|",
  ...[...folders.entries()]
    .filter(([, f]) => f.total > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, f]) => `| \`${folder}\` | ${f.covered} / ${f.total} | ${pct(f.covered, f.total)} |`),
  "",
  "<details><summary>Least-covered files over 50 lines</summary>",
  "",
  "| File | Lines | % |",
  "|---|---:|---:|",
  ...files
    .filter((f) => f.total >= 50)
    .sort((a, b) => a.pct - b.pct || b.total - a.total)
    .slice(0, 15)
    .map((f) => `| \`${f.rel}\` | ${f.total} | ${f.pct} |`),
  "",
  "</details>",
  "",
];
const out = lines.join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
else console.log(out);
