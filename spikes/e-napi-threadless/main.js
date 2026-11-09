// Spike (e): can napi-rs wasm run WITHOUT SharedArrayBuffer / cross-origin
// isolation? Three probes:
//   A. import @rolldown/browser (threaded wasi-threads build) in this context
//   B. instantiate the rolldown wasm directly with a non-shared memory
//   C. load a REAL threadless (wasm32-wasip1) napi package, oxc-parser, and
//      parse with it — proves the threadless mechanism works in this context
const result = {
  spike: "e",
  url: location.href,
  crossOriginIsolated: globalThis.crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  userAgent: navigator.userAgent,
  probes: {},
};

const report = (name, fn) => async () => {
  const t = performance.now();
  try {
    const value = await fn();
    result.probes[name] = { ok: true, ms: Math.round(performance.now() - t), value };
  } catch (error) {
    result.probes[name] = {
      ok: false,
      ms: Math.round(performance.now() - t),
      error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
      stack: String(error?.stack ?? "").split("\n").slice(0, 6).join("\n"),
    };
  }
};

const sharedMemoryAlloc = report("sharedMemoryAlloc", () => {
  const mem = new WebAssembly.Memory({ initial: 10, maximum: 10, shared: true });
  return mem.buffer.constructor.name;
});

const importRolldown = report("importRolldownBrowser", async () => {
  const mod = await import("@rolldown/browser");
  return `imported, rolldown=${typeof mod.rolldown}`;
});

const instantiateRolldownNonShared = report("rolldownWasmNonSharedMemory", async () => {
  const wasmUrl = "/node_modules/@rolldown/browser/dist/rolldown-binding.wasm32-wasi.wasm";
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`wasm fetch ${res.status}`);
  const bytes = await res.arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  const stub = new Proxy(
    {},
    {
      get: () =>
        new Proxy(
          {},
          {
            get: (t, name) =>
              name === "memory"
                ? new WebAssembly.Memory({ initial: 16384, maximum: 65536 })
                : () => 0,
          },
        ),
    },
  );
  await WebAssembly.instantiate(module, stub);
  return "instantiated";
});

const loadThreadlessOxc = report("oxcParserWasip1Threadless", async () => {
  const mod = await import("@oxc-parser/binding-wasm32-wasip1");
  const parsed = mod.parseSync
    ? mod.parseSync("probe.ts", "export const x: number = 1;")
    : null;
  return {
    target: mod.__napiBindingTarget,
    exports: Object.keys(mod).slice(0, 12),
    parseOk: parsed ? (parsed.errors?.length ?? 0) === 0 : "no parseSync",
    programKind: parsed?.program?.type ?? null,
  };
});

const run = async () => {
  await sharedMemoryAlloc();
  await importRolldown();
  await instantiateRolldownNonShared();
  await loadThreadlessOxc();
  globalThis.__result = result;
};

run();
