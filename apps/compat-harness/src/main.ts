import { boot, type BrowserContainer } from "@browser-containers/runtime";
import { NodeTestRunner, type ModuleManifest, type TestResult } from "./runner.js";

export interface ExecResult {
  exitCode: number;
  output: string;
  duration?: number;
}

export interface CompatHarness {
  /** True once `boot()` has resolved and `run()`/`exec()` are safe to call. */
  ready: boolean;
  boot(): Promise<void>;
  /** Writes `source` to `path` under the container workdir. */
  write(path: string, source: string): Promise<void>;
  /** Runs `node <path>` and returns the combined stdout+stderr text, exit code, and elapsed time. */
  exec(path: string): Promise<ExecResult>;
  /**
   * Writes `source` to `path` and runs it via `node <path>`, returning the combined
   * stdout+stderr text and exit code. Kept for backwards compatibility.
   */
  run(path: string, source: string): Promise<Omit<ExecResult, "duration">>;
  teardown(): Promise<void>;
}

declare global {
  interface Window {
    __compatHarness: CompatHarness;
    __testResults: { module: string; results: TestResult[] }[] | null;
    __runNodeTests(): Promise<{ module: string; results: TestResult[] }[]>;
  }
}

let container: BrowserContainer | undefined;

const readAll = async (stream: ReadableStream<string>): Promise<string> => {
  const reader = stream.getReader();
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += value;
  }
  return output;
};

const normalize = (path: string): string => (path.startsWith("/") ? path : `/${path}`);

window.__compatHarness = {
  ready: false,

  boot: async () => {
    container = await boot({ workdirName: "/home/harness" });
    window.__compatHarness.ready = true;
  },

  write: async (path, source) => {
    if (!container) throw new Error("CompatHarness: boot() must resolve before write()");
    const rel = normalize(path);
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    if (dir) await container.fs.mkdir(container.workdir + dir, { recursive: true });
    await container.fs.writeFile(container.workdir + rel, source);
  },

  exec: async (path) => {
    if (!container) throw new Error("CompatHarness: boot() must resolve before exec()");
    const rel = normalize(path);
    const start = performance.now();
    const proc = container.spawn("node", [rel]);
    const [output, exitCode] = await Promise.all([readAll(proc.output), proc.exit]);
    const duration = performance.now() - start;
    return { exitCode, output, duration };
  },

  run: async (path, source) => {
    await window.__compatHarness.write(path, source);
    const { exitCode, output } = await window.__compatHarness.exec(path);
    return { exitCode, output };
  },

  teardown: async () => {
    await container?.teardown();
    container = undefined;
    window.__compatHarness.ready = false;
  },
};

window.__testResults = null;

window.__runNodeTests = async () => {
  const response = await fetch("/src/manifest.json");
  const manifest = (await response.json()) as ModuleManifest;
  const runner = new NodeTestRunner(manifest);
  await runner.boot();
  const results = await runner.runAll();
  await runner.teardown();
  window.__testResults = results;
  console.table(
    results.flatMap((m) =>
      m.results.map((r) => ({
        module: m.module,
        file: r.file.split("/").pop() ?? r.file,
        status: r.status,
        duration: r.duration ? `${r.duration.toFixed(0)}ms` : "n/a",
      })),
    ),
  );
  return results;
};

const statusEl = document.getElementById("status");
const bootBtn = document.getElementById("bootBtn") as HTMLButtonElement | null;
const runBtn = document.getElementById("runBtn") as HTMLButtonElement | null;
const resultsEl = document.getElementById("results");

const renderResults = (
  results: { module: string; results: TestResult[] }[],
  container: HTMLElement | null,
): void => {
  if (!container) return;
  const rows = results.flatMap((m) =>
    m.results.flatMap((r) => {
      const fileName = r.file.split("/").pop() ?? r.file;
      const header = document.createElement("div");
      header.className = r.status;
      header.innerHTML = `<strong>${m.module} / ${fileName}</strong>: ${r.status} ${
        r.duration ? `(${r.duration.toFixed(0)}ms)` : ""
      }`;
      const pre = document.createElement("pre");
      pre.textContent = r.output;
      return [header, pre];
    }),
  );
  container.replaceChildren(...rows);
};

if (statusEl && bootBtn && runBtn) {
  bootBtn.addEventListener("click", async () => {
    statusEl.textContent = "booting...";
    try {
      await window.__compatHarness.boot();
      statusEl.textContent = "ready";
      runBtn.disabled = false;
    } catch (err) {
      statusEl.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    statusEl.textContent = "running...";
    resultsEl?.replaceChildren();
    try {
      const results = await window.__runNodeTests();
      statusEl.textContent = "done";
      renderResults(results, resultsEl);
    } catch (err) {
      statusEl.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      runBtn.disabled = false;
    }
  });
}
