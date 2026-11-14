import { VfsBus } from "@bolojs/fs";
import { PackageManager } from "@bolojs/pm";
import { bundleEntry } from "@bolojs/registry/bundle";
import * as nws from "@bolojs/node-web-shims";
const vfs=new VfsBus(); const cwd="/home/web/app";
vfs.hot.mkdirSync(`${cwd}/probe`,{recursive:true});
vfs.hot.writeFileSync(`${cwd}/package.json`,JSON.stringify({name:"p",version:"1.0.0"}));
const pm=new PackageManager({vfs,cwd,stdout:()=>{},stderr:()=>{}});
await pm.install(["@rollup/wasm-node"]);
vfs.hot.writeFileSync(`${cwd}/probe/entry.mjs`, `import * as rollup from 'rollup';\nexport const ok = typeof rollup.rollup === 'function';`);
const shims = { ...nws, "stream/web": nws.streamWeb, "stream/promises": nws.streamPromises, "stream/consumers": nws.streamConsumers,
  fs: nws.fs ?? {}, module: nws.module, child_process: nws.child_process };
// no getShim for fs etc -> external warnings, but check rollup import path resolution
const { code, warnings } = await bundleEntry(`${cwd}/probe/entry.mjs`, { vfs, cwd, getShim:(b)=>shims[b] });
console.log("WARN:", warnings.slice(0,5));
console.log("has rollup fn:", /rollup/.test(code));
