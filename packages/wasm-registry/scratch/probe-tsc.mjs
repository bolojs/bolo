import { VfsBus } from "@bolojs/fs";
import { PackageManager } from "@bolojs/pm";
const vfs = new VfsBus();
const cwd = "/home/web/app";
vfs.hot.mkdirSync(cwd, { recursive: true });
vfs.hot.writeFileSync(`${cwd}/package.json`, JSON.stringify({ name: "probe", version: "1.0.0" }));
const pm = new PackageManager({ vfs, cwd, stdout:()=>{}, stderr:()=>{} });
await pm.install(["typescript"]);
// inspect
const nm = `${cwd}/node_modules/typescript`;
console.log("pkg exists:", vfs.hot.existsSync(nm));
try {
  const pj = JSON.parse(vfs.hot.readFileSync(`${nm}/package.json`,"utf8"));
  console.log("version:", pj.version, "main:", pj.main, "module:", pj.module, "exports:", JSON.stringify(pj.exports));
} catch(e){ console.log("read err", e.message); }
console.log("readdir node_modules:", vfs.hot.readdirSync(`${cwd}/node_modules`).slice(0,20));
