// Module worker for spike (a). Exercises a static import (already fetched at
// instantiation), a dynamic import() of a URL, and fetch().
import "./static-dep.js?w=static&pt=1";

const out = { ok: [], err: [], progress: [] };
const step = (m) => {
  out.progress.push(m);
  postMessage({ progress: m });
};
const timeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ":hung")), ms))]);

step("loaded");
try {
  await timeout(import("/a/dyn.js?w=dyn"), 4000, "dyn-import");
  out.ok.push("dyn-import");
} catch (e) {
  out.err.push("dyn-import:" + e.message);
}

try {
  const r = await timeout(fetch("/a/data.json?w=modfetch"), 4000, "fetch");
  await r.text();
  out.ok.push("fetch:" + r.status);
} catch (e) {
  out.err.push("fetch:" + e.message);
}

postMessage({ done: out });
