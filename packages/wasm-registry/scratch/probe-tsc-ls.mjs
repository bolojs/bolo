import { VfsBus } from "@bolojs/fs";
import { PackageManager } from "@bolojs/pm";
const vfs=new VfsBus(); const cwd="/home/web/app";
vfs.hot.mkdirSync(cwd,{recursive:true});
vfs.hot.writeFileSync(`${cwd}/package.json`,JSON.stringify({name:"p",version:"1.0.0"}));
const pm=new PackageManager({vfs,cwd,stdout:()=>{},stderr:()=>{}});
await pm.install(["typescript@5.9.3"]);
console.log("nm:", vfs.hot.readdirSync(`${cwd}/node_modules`));
console.log(".bolo:", vfs.hot.readdirSync(`${cwd}/node_modules/.bolo`));
try { console.log("readlink typescript:", vfs.hot.readlinkSync?.(`${cwd}/node_modules/typescript`)); } catch(e){ console.log("rl err", e.message); }
try { console.log("stat:", JSON.stringify(vfs.hot.lstatSync(`${cwd}/node_modules/typescript`))); } catch(e){ console.log("stat err", e.message); }
