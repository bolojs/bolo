// Classic worker for spike (a). Exercises importScripts, fetch, and a dynamic
// import() attempt from a classic-script context.
const out = { ok: [], err: [], progress: [] };
const step = (m) => {
  out.progress.push(m);
  postMessage({ progress: m });
};
const timeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ":hung")), ms))]);

const jobs = [];

step("loaded");
try {
  importScripts("/a/synth-dep.js?w=imp-synth&synth=1");
  out.ok.push("importScripts-synth:" + globalThis.__syntheticDep);
} catch (e) {
  out.err.push("importScripts-synth:" + e.message);
}
step("past-importScripts-synth");

try {
  importScripts("/a/classic-dep.js?w=imp&pt=1");
  out.ok.push("importScripts");
} catch (e) {
  out.err.push("importScripts:" + e.message);
}
step("past-importScripts");

jobs.push(
  timeout(fetch("/a/data2.json?w=cfetch"), 4000, "fetch")
    .then((r) => r.text().then(() => out.ok.push("fetch:" + r.status)))
    .catch((e) => out.err.push("fetch:" + e.message)),
);

jobs.push(
  timeout(import("/a/dyn.js?w=cdyn"), 4000, "dyn-import")
    .then(() => out.ok.push("dyn-import"))
    .catch((e) => out.err.push("dyn-import:" + e.message)),
);

Promise.allSettled(jobs).then(() => postMessage({ done: out }));
