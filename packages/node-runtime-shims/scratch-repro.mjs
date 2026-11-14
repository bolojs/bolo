// Node-side repro of the compat-harness package probes.
// Installs packages into a VfsBus, bundles a probe with bundleEntry,
// and evaluates the bundle to print the resulting shape.
import { VfsBus } from "@bolojs/fs";
import { PackageManager } from "@bolojs/pm";
import { bundleEntry } from "@bolojs/registry/bundle";
import { createRequire } from "node:module";

const require = createRequire("/home/own-agents/src/bolo/.worktrees/npm-fails/package.json");
const matrix = require("/home/own-agents/src/bolo/.worktrees/npm-fails/apps/compat-harness/src/package-matrix.json");

const names = process.argv[2].split(",");
const extra = (process.env.EXTRA ?? "").split(",").filter(Boolean);
const probeOverride = process.argv[3];

const vfs = new VfsBus();
const shims = buildShims("/home/web/app");
function buildShims(cwd) {
  return {
    ...nws,
    process: {
      platform: 'linux', arch: 'x64', env: { NODE_ENV: 'development' },
      argv: ['node', 'probe'], cwd: () => cwd, exit: (c) => { throw new Error('exit ' + c); },
      on: () => {}, off: () => {}, listenerCount: () => 0,
      stdout: { write: (s) => process.stdout.write(s) },
      stderr: { write: (s) => process.stderr.write(s) },
    },
  };
}
const cwd = "/home/web/app";
vfs.hot.mkdirSync(cwd, { recursive: true });
vfs.hot.writeFileSync(`${cwd}/package.json`, JSON.stringify({ name: "probe", version: "1.0.0" }));

const pm = new PackageManager({
  vfs,
  cwd,
  stdout: (s) => process.stdout.write(`[pm] ${s}`),
  stderr: (s) => process.stderr.write(`[pm-err] ${s}`),
});
await pm.install([...names, ...extra]);

const entry = matrix.packages.find((p) => p.name === names[0]);
let source = probeOverride ?? (entry?.source ?? "");
if (!probeOverride && entry && !entry.source) {
  source = `import ${entry.name.replace(/[^a-zA-Z0-9_$]/g, "_")} from '${entry.name}';\nlet __r; try { __r = await (${entry.probe}); } catch(e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1);} if(!__r){console.error('falsy');process.exit(1);} console.log('PASS');`;
}
if (probeOverride) source = probeOverride;

vfs.hot.mkdirSync(`${cwd}/probe`, { recursive: true });
vfs.hot.writeFileSync(`${cwd}/probe/entry.mjs`, source);

const { code, warnings } = await bundleEntry(`${cwd}/probe/entry.mjs`, {
  vfs,
  cwd,
  getShim: (builtin) => shims[builtin],
});
console.log("=== WARNINGS ===");
for (const w of warnings) console.log(" -", w);
if (process.env.DUMP) console.log("=== CODE ===\n" + code);

import * as nws from "@bolojs/node-web-shims";
import { createFsShim } from "@bolojs/node-runtime-shims";
globalThis.__browserContainers = {
  shims: {
    process: {
      platform: 'linux', arch: 'x64', env: { NODE_ENV: 'development' },
      argv: ['node'], cwd: () => cwd, exit: (c) => { throw new Error('exit ' + c); },
      on: () => {}, off: () => {}, listenerCount: () => 0,
      stdout: { write: (s) => process.stdout.write(s) },
      stderr: { write: (s) => process.stderr.write(s) },
    },
    buffer: { Buffer: globalThis.Buffer },
    events: { EventEmitter: class EventEmitter {} },
    path: globalThis.__proto__,
    url: {},
    stream: {},
    fs: {},
    os: {},
    util: {},
    crypto: {},
  },
};
const url = "data:text/javascript," + encodeURIComponent(code);
try {
  const mod = await import(url);
  console.log("=== EXPORTS ===", Object.keys(mod));
  console.log("=== DEFAULT ===", typeof mod.default, mod.default && Object.keys(mod.default).slice(0, 20));
  if (process.env.EVAL) {
    const fn = new Function("console", "process", "globalThis", code + "\n//# sourceURL=probe");
    fn(console, { exit: (c) => { throw new Error("exit " + c); }, argv: [], env: {} }, globalThis);
  }
} catch (e) {
  console.log("=== EVAL ERROR ===\n" + (e?.stack ?? String(e)));
}
