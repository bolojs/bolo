import { VfsBus } from "@bolojs/fs";
import { PackageManager } from "@bolojs/pm";
const vfs=new VfsBus(); const cwd="/home/web/app";
vfs.hot.mkdirSync(cwd,{recursive:true});
vfs.hot.writeFileSync(`${cwd}/package.json`,JSON.stringify({name:"p",version:"1.0.0"}));
const pm=new PackageManager({vfs,cwd,stdout:()=>{},stderr:()=>{}});
await pm.install(["vite"]);
const base=`${cwd}/node_modules/vite`;
const nm = `${cwd}/node_modules`;
console.log("nm:", vfs.hot.readdirSync(nm));
console.log(".bolo:", vfs.hot.readdirSync(`${nm}/.bolo`));
// find rolldown
const rolldownDir = `${nm}/.bolo/rolldown@4.62.2`;
