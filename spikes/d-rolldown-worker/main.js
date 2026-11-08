const result = {
  spike: "d",
  url: location.href,
  crossOriginIsolated: globalThis.crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  userAgent: navigator.userAgent,
  notes: [],
};

const heapBefore =
  typeof performance.memory === "object" ? performance.memory.usedJSHeapSize : null;

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const tSpawn = performance.now();

worker.addEventListener("error", (event) => {
  result.verdict = "FAIL";
  result.error = `worker error: ${event.message} at ${event.filename}:${event.lineno}`;
  globalThis.__result = result;
});

worker.addEventListener("message", async (event) => {
  const data = event.data;
  if (data.type === "progress") {
    result.notes.push(data.note);
    return;
  }
  const heapAfter =
    typeof performance.memory === "object" ? performance.memory.usedJSHeapSize : null;
  result.pageHeapDeltaMB =
    heapBefore != null && heapAfter != null
      ? Math.round(((heapAfter - heapBefore) / 1024 / 1024) * 10) / 10
      : null;
  result.spawnToFirstResultMs = Math.round(performance.now() - tSpawn);
  Object.assign(result, data);
  if (typeof performance.measureMemory === "function") {
    try {
      const m = await performance.measureMemory({ detailed: true });
      result.measureMemoryMB = Math.round((m.bytes / 1024 / 1024) * 10) / 10;
      result.measureMemoryBreakdown = m.breakdown?.map((b) => ({
        mb: Math.round((b.bytes / 1024 / 1024) * 10) / 10,
        types: b.types,
        url: b.attribution?.[0]?.url ?? null,
        scope: b.attribution?.[0]?.scope ?? null,
      }));
    } catch (e) {
      result.measureMemoryError = String(e);
    }
  }
  globalThis.__result = result;
});

worker.postMessage({ type: "run", tSpawn });
