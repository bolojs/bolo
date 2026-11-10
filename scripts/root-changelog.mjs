#!/usr/bin/env node
// Aggregates per-package changeset CHANGELOGs into the root CHANGELOG.md.
//   node scripts/root-changelog.mjs           prepend the section for the current @bolojs/runtime version
//   node scripts/root-changelog.mjs --notes   print that version's section (used for the GitHub Release body)
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const rootLog = join(root, "CHANGELOG.md");
const HEADER = "# Changelog\n\nUser-facing changes across all `@bolojs/*` packages. Per-package details live in each `packages/*/CHANGELOG.md`.\n";
const version = JSON.parse(readFileSync(join(root, "packages/runtime/package.json"), "utf8")).version;
const marker = `## ${version}`;

const sectionOf = (text, v) => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `## ${v}` || l.startsWith(`## ${v} `));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join("\n").trimEnd();
};

if (process.argv.includes("--notes")) {
  const section = existsSync(rootLog) ? sectionOf(readFileSync(rootLog, "utf8"), version) : null;
  if (!section) throw new Error(`No ${marker} section in CHANGELOG.md`);
  console.log(section.split("\n").slice(1).join("\n").trim());
  process.exit(0);
}

const current = existsSync(rootLog) ? readFileSync(rootLog, "utf8") : "";
if (sectionOf(current, version)) {
  console.log(`CHANGELOG.md already has ${marker}; nothing to do.`);
  process.exit(0);
}

const entries = new Map(); // dedupe key -> { kind, text, pkgs }
for (const dir of readdirSync(join(root, "packages"))) {
  const pj = join(root, "packages", dir, "package.json");
  const cl = join(root, "packages", dir, "CHANGELOG.md");
  if (!existsSync(pj) || !existsSync(cl)) continue;
  const pkg = JSON.parse(readFileSync(pj, "utf8"));
  if (pkg.private) continue;
  const section = sectionOf(readFileSync(cl, "utf8"), version);
  if (!section) continue;
  let kind = "";
  let block = [];
  const flush = () => {
    const text = block.join("\n").trimEnd();
    block = [];
    if (!text || text.startsWith("- Updated dependencies")) return;
    const key = text.match(/`([0-9a-f]{7})`/)?.[1] ?? text;
    const hit = entries.get(key) ?? { kind, text, pkgs: [] };
    hit.pkgs.push(pkg.name);
    entries.set(key, hit);
  };
  for (const line of section.split("\n").slice(1)) {
    if (line.startsWith("### ")) { flush(); kind = line.slice(4).trim(); continue; }
    if (line.startsWith("- ")) flush();
    if (kind) block.push(line);
  }
  flush();
}

const order = ["Major Changes", "Minor Changes", "Patch Changes"];
const date = new Date().toISOString().slice(0, 10);
let out = `${marker} - ${date}\n`;
for (const kind of order) {
  const items = [...entries.values()].filter((e) => e.kind === kind);
  if (!items.length) continue;
  out += `\n### ${kind}\n\n${items.map((e) => `${e.text}\n\n  Packages: ${e.pkgs.join(", ")}`).join("\n\n")}\n`;
}
if (entries.size === 0) out += "\nDependency updates and internal changes only.\n";

const body = current.startsWith("# Changelog") ? current.replace(/^# Changelog[\s\S]*?\n(?=## |$)/, "") : current;
writeFileSync(rootLog, `${HEADER}\n${out}${body ? `\n${body.trimStart()}` : ""}`);
console.log(`CHANGELOG.md: added ${marker} (${entries.size} entries).`);
