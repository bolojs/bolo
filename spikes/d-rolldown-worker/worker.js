// Runs INSIDE a dedicated Worker. Bundles a 2-file project with one
// npm-style bare import through a virtual-fs rolldown plugin.
const FILES = {
  "/src/entry.js": `import { shout } from './util.js';\nimport { pad } from 'spike-lib';\nexport const out = () => shout(pad('ok', 8));\n`,
  "/src/util.js": `export const shout = (s) => s.toUpperCase() + '!';\n`,
  "/node_modules/spike-lib/package.json": `{"name":"spike-lib","version":"1.0.0","type":"module","main":"index.js"}`,
  "/node_modules/spike-lib/index.js": `export const pad = (s, n) => s.padStart(n, '*');\n`,
};

const dirname = (p) => p.slice(0, p.lastIndexOf("/")) || "/";

const vfsPlugin = {
  name: "spike-vfs",
  resolveId(id, importer) {
    if (id.startsWith("/")) return FILES[id] != null ? id : null;
    if (id.startsWith(".")) {
      const base = dirname(importer ?? "/src/entry.js");
      for (const cand of [
        `${base}/${id}`,
        `${base}/${id}.js`,
        `${base}/${id}/index.js`,
      ]) {
        const normalized = `/${cand.split("/").filter((s) => s && s !== ".").join("/")}`;
        if (FILES[normalized] != null) return normalized;
      }
      return null;
    }
    const pkgDir = `/node_modules/${id}`;
    if (FILES[`${pkgDir}/package.json`] != null) {
      const pkg = JSON.parse(FILES[`${pkgDir}/package.json`]);
      const main = `${pkgDir}/${pkg.module ?? pkg.main ?? "index.js"}`;
      if (FILES[main] != null) return main;
    }
    if (FILES[`${pkgDir}/index.js`] != null) return `${pkgDir}/index.js`;
    return null;
  },
  load(id) {
    if (FILES[id] == null) return null;
    if (id.endsWith("package.json")) {
      return { code: `export default ${FILES[id]};`, moduleSideEffects: "no-treeshake" };
    }
    return { code: FILES[id], moduleSideEffects: "no-treeshake" };
  },
};

globalThis.onmessage = async (event) => {
  if (event.data?.type !== "run") return;
  const out = { type: "done" };
  try {
    out.isolatedInWorker = globalThis.crossOriginIsolated;
    out.sabInWorker = typeof SharedArrayBuffer;
    out.nestedWorkerAllowed = typeof Worker === "function";

    // Minimal node:process stub — the browser build reads process.cwd() when
    // no `cwd` option is passed, and process.nextTick internally. Mirrors the
    // GLOBALS_BANNER stub wasm-registry prepends for bundled apps.
    globalThis.process ??= {
      cwd: () => "/",
      env: {},
      versions: {},
      nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    };

    const t0 = performance.now();
    const mod = await import("@rolldown/browser");
    out.coldStartMs = Math.round(performance.now() - t0);

    const t1 = performance.now();
    const bundle = await mod.rolldown({
      input: "/src/entry.js",
      cwd: "/",
      plugins: [vfsPlugin],
    });
    const generated = await bundle.generate({ format: "iife", name: "spikeBundle" });
    out.bundleMs = Math.round(performance.now() - t1);
    await bundle.close();

    const code = generated.output[0].code;
    out.outputBytes = code.length;
    out.outputContainsPad = code.includes("padStart");
    out.outputContainsShout = code.includes("toUpperCase");
    out.evalResult = new Function(`${code}\n return spikeBundle.out();`)();
    out.workerHeapMB =
      typeof performance.memory === "object"
        ? Math.round((performance.memory.usedJSHeapSize / 1024 / 1024) * 10) / 10
        : null;
    out.verdict = "PASS";
  } catch (error) {
    out.verdict = "FAIL";
    out.error = `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
    out.stack = String(error?.stack ?? "").split("\n").slice(0, 8).join("\n");
  }
  postMessage(out);
};
