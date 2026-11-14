import { VfsBus } from "@bolojs/fs";
import { PackageManager } from "@bolojs/pm";
import { bundleEntry } from "@bolojs/registry/bundle";
import * as nws from "@bolojs/node-web-shims";
import { createRequire } from "node:module";
const require = createRequire("/home/own-agents/src/bolo/.worktrees/npm-fails/package.json");
const matrix = require("/home/own-agents/src/bolo/.worktrees/npm-fails/apps/compat-harness/src/package-matrix.json");
const name = process.argv[2];
const specs = process.argv[3] ? process.argv[3].split(",") : null;
const vfs = new VfsBus();
const cwd = "/home/web/app";
vfs.hot.mkdirSync(cwd, { recursive: true });
vfs.hot.writeFileSync(`${cwd}/package.json`, JSON.stringify({ name: "probe", version: "1.0.0" }));
const pm = new PackageManager({ vfs, cwd, stdout:(s)=>process.stdout.write(s), stderr:(s)=>process.stderr.write(s) });
const entry = matrix.packages.find((p) => p.name === name);
const source = entry.source ?? `${entry.bind ?? `import ${name.replace(/[^a-zA-Z0-9_$]/g,'_')} from '${name}';`}\nlet __r; try { __r = await (${entry.probe}); } catch(e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1);} if(!__r){console.error('falsy');process.exit(1);} console.log('PASS');`;
// extract install specs like the harness: from|import 'spec'
const found = new Set();
for (const m of source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?['"]([^'"\n]+)['"]/g)) {
  const s = m[1];
  if (s.startsWith("node:")||s.startsWith(".")||s.startsWith("/")||s.includes("://")) continue;
  found.add(s);
}
for (const s of specs ?? []) found.add(s);
console.error("INSTALL:", [...found]);
await pm.install([...found]);
vfs.hot.mkdirSync(`${cwd}/probe`, { recursive: true });
vfs.hot.writeFileSync(`${cwd}/probe/entry.mjs`, source);
const shims = { ...nws,
  fs: nws.createFsShim ? nws.createFsShim({vfs}) : {}, "fs/promises": nws.createFsShim ? nws.createFsShim({vfs}).promises : {},
  "stream/web": nws.streamWeb, "stream/promises": nws.streamPromises, "stream/consumers": nws.streamConsumers,
  zlib: nws.zlib, assert: nws.assert, buffer: nws.buffer, events: nws.events, path: nws.path, url: nws.url, util: nws.util, os: nws.os, crypto: nws.crypto, querystring: nws.querystring, stream: nws.stream, timers: nws.timers, timers_promises: nws.timers_promises,
  process: { platform:'linux', arch:'x64', env:{NODE_ENV:'development'}, argv:['node','p'], cwd:()=>cwd, exit:(c)=>{throw new Error('exit '+c)}, on:()=>{}, off:()=>{}, listenerCount:()=>0, stdout:{write:(s)=>__BUF.push(''+s)}, stderr:{write:(s)=>__BUF.push(''+s)} } };
let code, warnings;
try { ({ code, warnings } = await bundleEntry(`${cwd}/probe/entry.mjs`, { vfs, cwd, getShim:(b)=>shims[b] })); }
catch(e) { console.error("BUNDLE ERROR:", e.message?.slice(0,500)); process.exit(1); }
for (const w of warnings) console.error("WARN:", typeof w === 'string' ? w.slice(0,200) : JSON.stringify(w).slice(0,200));
globalThis.__BUF=[]; globalThis.__browserContainers = { shims };
try {
  const url = "data:text/javascript," + encodeURIComponent(code);
  const mod = await import(url);
  console.error("EXPORTS:", Object.keys(mod).slice(0,15));
  console.error("DEFAULT:", typeof mod.default);
} catch(e) { console.error("EVAL ERROR:", (e?.stack ?? String(e)).slice(0,800)); }
console.error("OUT:", (globalThis.__BUF||[]).join("").slice(0,600));
