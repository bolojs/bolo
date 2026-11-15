import { build } from "esbuild";
import fs from "node:fs"; import path from "node:path";
const q = {
  name: "vite-queries",
  setup(b) {
    b.onResolve({ filter: /\?(raw|asset|url)$/ }, (a) => {
      const clean = a.path.replace(/\?.*$/, "");
      const p = clean.startsWith("@/") ? path.resolve("src", clean.slice(2)) : path.resolve(a.resolveDir, clean);
      return { path: p, namespace: "rawq", pluginData: a.path.match(/\?(\w+)$/)[1] };
    });
    b.onLoad({ filter: /.*/, namespace: "rawq" }, (a) => ({
      contents: `export default ${JSON.stringify(a.pluginData === "raw" ? fs.readFileSync(a.path, "utf8") : a.path)}`, loader: "js",
    }));
  },
};
await build({
  entryPoints: ["web/host.ts"], bundle: true, platform: "node", format: "esm", outfile: ".web/out/host.mjs",
  alias: { electron: "./web/electron-stub.ts", "@": "./src" },
  external: ["better-sqlite3", "node-pty", "dugite", "ssh2", "cpu-features", "dyad-keychain-reader", "@parcel/watcher", "fsevents", "electron-log", "update-electron-app"].filter((x) => x !== "electron-log" && x !== "update-electron-app"),
  banner: { js: "import {createRequire as __cr} from 'node:module'; import __p from 'node:path'; import {fileURLToPath as __f} from 'node:url'; const require=__cr(import.meta.url); const __filename=__f(import.meta.url); const __dirname=__p.dirname(__filename);" },
  plugins: [q], loader: { ".md": "text", ".sql": "text", ".json": "json" }, logLevel: "warning",
});
