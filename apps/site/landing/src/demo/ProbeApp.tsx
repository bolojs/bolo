/** @jsxImportSource solid-js */
import { createSignal, onMount } from "solid-js";
import { boot, type BrowserContainer } from "@bolojs/runtime";

/**
 * Headless probe endpoint for agents and scripts. Boots the runtime, then:
 *
 *   GET /probe/                  -> info JSON (no code given)
 *   GET /probe/?run=<b64url>     -> evaluate, JSON result
 *
 * `run` accepts base64url (preferred: no escaping issues) or raw source.
 * The page is one <pre> holding machine-shaped JSON, so a headless browser
 * (Playwright, puppeteer, playwright-cli) reads textContent — no selector
 * knowledge needed:
 *
 *   playwright-cli goto "<url>"; playwright-cli eval "document.body.textContent"
 *
 * The code runs through `node -e` inside the container, so it gets the same
 * surface an agent would write against: `require`, `console.log`, top-level
 * await inside an async function, and a non-zero exit code on throw.
 *
 * Response shape is stable for machines:
 *   { ok, result | error, durationMs, runtime: { version, node } }
 */

interface ProbeResult {
  ok: boolean;
  result?: string | undefined;
  error?: string | undefined;
  durationMs: number;
  runtime: { version: string; node: string };
}

declare global {
  interface Window {
    /** Set by an embedder (or a test) to supply code without a query param. */
    __boloProbeCode?: string;
  }
}

const RUNTIME_VERSION = "0.x"; // resolved from the container at runtime

const encodeResult = (r: ProbeResult) => JSON.stringify(r, null, 2);

/** Accepts base64url or raw source for `run`. */
const decodeRun = (raw: string): string => {
  // Base64url detection: no whitespace, only b64url alphabet, and decodes to
  // printable text. Raw source almost always contains a space or newline.
  const isB64 = /^[A-Za-z0-9_-]+$/.test(raw);
  if (isB64) {
    try {
      const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (/^[\x09\x0a\x0d\x20-\x7e]+$/.test(text)) return text;
    } catch {
      // fall through to raw
    }
  }
  return raw;
};

export default function ProbeApp() {
  const [state, setState] = createSignal<"booting" | "ready" | "error">("booting");
  const [output, setOutput] = createSignal<string>("");

  const emit = (r: ProbeResult) => {
    const text = encodeResult(r);
    setOutput(text);
    // Machine-readable status: agents can read document.title, humans see it
    // in the tab. `ok |` prefix makes success greppable.
    document.title = (r.ok ? "ok | " : "error | ") + "bolo probe";
  };

  const infoResult = (durationMs: number): ProbeResult => ({
    ok: true,
    result: JSON.stringify({
      runtime: "bolo",
      version: RUNTIME_VERSION,
      probe: {
        usage: "GET /probe/?run=<base64url code>  (raw source also accepted)",
        returns: "{ ok, result | error, durationMs, runtime }",
        runs: "node -e inside the container: require, console.log and async/await all work",
      },
    }),
    durationMs,
    runtime: { version: RUNTIME_VERSION, node: "in-container" },
  });

  onMount(async () => {
    const t0 = performance.now();
    let container: BrowserContainer | undefined;
    try {
      container = await boot({ workdirName: "/home/web", swPath: "/sw.js" });
      const runtimeInfo = { version: RUNTIME_VERSION, node: "in-container" };
      setState("ready");

      const params = new URLSearchParams(location.search);
      const runParam = params.get("run");
      let code: string | null = runParam !== null ? decodeRun(runParam) : null;

      if (code === null && typeof window.__boloProbeCode === "string") {
        code = window.__boloProbeCode;
      }

      if (code === null) {
        emit(infoResult(performance.now() - t0));
        return;
      }

      const started = performance.now();
      // `node -e` gives the snippet the real CommonJS surface (require,
      // console, process) plus async/await. The process streams output and
      // reports the exit code, which is exactly the agent-facing contract.
      //
      // The user's code is evaluated as the *body* of an async function via
      // eval, so multi-statement snippets (const, throw, await) work as
      // written. The eval completion value is printed unless undefined, so
      // `1+1` answers `2` while `console.log("hi")` doesn't double-print.
      // The code travels inline (JSON-stringified), because `node -e <script>
      // -- <arg>` argv propagation is unreliable through the shell quoter.
      const wrapped = [
        `(async () => {`,
        `  const __v = await eval(${JSON.stringify(code)});`,
        `  if (__v !== undefined) console.log(typeof __v === "string" ? __v : JSON.stringify(__v, null, 2));`,
        `})().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });`,
      ].join("\n");
      const proc = container.spawn("node", ["-e", wrapped]);
      const reader = proc.output.getReader();
      let out = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out += value;
        }
      } finally {
        reader.releaseLock();
      }
      const exitCode = await proc.exit;
      const durationMs = performance.now() - started;
      const trimmed = out.trim();
      // stdout and stderr share one stream, so on failure the text is the
      // error — don't also report it as a result.
      emit({
        ok: exitCode === 0,
        result: exitCode === 0 ? trimmed || undefined : undefined,
        error: exitCode === 0 ? undefined : trimmed || `exit code ${exitCode}`,
        durationMs: Math.round(durationMs * 100) / 100,
        runtime: runtimeInfo,
      });
    } catch (e) {
      setState("error");
      emit({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Math.round((performance.now() - t0) * 100) / 100,
        runtime: { version: RUNTIME_VERSION, node: "unbooted" },
      });
    }
  });

  return (
    <pre
      id="probe-output"
      class="m-0 min-h-screen w-full overflow-auto p-4 font-mono text-[13px] leading-relaxed"
      data-state={state()}
    >
      {output() || "booting…"}
    </pre>
  );
}
