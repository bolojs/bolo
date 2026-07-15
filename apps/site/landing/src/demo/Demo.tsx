/** @jsxImportSource solid-js */
import { createSignal, onMount } from "solid-js";
import { boot, type BrowserContainer } from "@bolojs/runtime";
import Terminal from "./Terminal";
import Editor from "./Editor";
import Preview from "./Preview";
import EditorTabs, { type EditorTab } from "./EditorTabs";
import ScenarioPicker from "./ScenarioPicker";
import ChipMarquee from "./ChipMarquee";
import { defaultScenario, type QuickAction, type Scenario } from "./scenarios";

declare global {
  // eslint-disable-next-line no-var
  var __preferLocalRolldown: boolean | undefined;
}

// @rolldown/browser is a same-origin bundled dependency of this app (unlike
// oxc-transform, which stays on esm.sh). The esm.sh-hosted build panics in
// real browsers — its WASI worker pool does `new Worker(new URL(...))` with
// no `{ type: 'module' }`, and classic workers can't load a cross-origin
// script — surfacing as a raw WASM "unreachable" trap (JavaScriptCore: hits
// this immediately on Safari/iOS; V8: printed as terminal output instead of
// throwing). See @bolojs/wasm-registry's bundle.ts for the CDN-fallback logic
// this flag opts out of.
globalThis.__preferLocalRolldown = true;

type BootState = "booting" | "installing" | "switching" | "ready" | "error";

const statusDotStyles: Record<BootState, string> = {
  booting: "bg-muted animate-pulse",
  installing: "bg-muted animate-pulse",
  switching: "bg-muted animate-pulse",
  ready: "bg-[var(--success)]",
  error: "bg-[var(--danger)]",
};

const statusLabels: Record<BootState, string> = {
  booting: "booting…",
  installing: "installing…",
  switching: "switching…",
  ready: "ready",
  error: "error",
};

export default function Demo() {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [lines, setLines] = createSignal<string[]>([]);
  const [activeScenario, setActiveScenario] = createSignal<Scenario>(defaultScenario);
  const [source, setSource] = createSignal(defaultScenario.files["index.ts"]);
  const [activeTab, setActiveTab] = createSignal<EditorTab>("code");
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [inputValue, setInputValue] = createSignal("");
  const [focusInput, setFocusInput] = createSignal(0);
  let container: BrowserContainer | undefined;

  const appendLine = (s: string) => setLines((prev) => [...prev, s]);

  const runToCompletion = async (proc: ReturnType<BrowserContainer["spawn"]>) => {
    const reader = proc.output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        appendLine(value);
      }
    } finally {
      reader.releaseLock();
    }
    return proc.exit;
  };

  const runCommand = async (command: string, args: string[]) => {
    if (!container) return;
    appendLine(`\r\n\x1b[2m~/demo $ ${[command, ...args].join(" ")}\x1b[0m\r\n`);
    const exitCode = await runToCompletion(container.spawn(command, args));
    appendLine(`\r\n\x1b[2mexit ${exitCode}\x1b[0m\r\n`);
  };

  const bootScenario = async (scenario: Scenario) => {
    try {
      if (container) {
        setBootState("switching");
        await container.teardown();
        container = undefined;
      } else {
        setBootState("booting");
      }

      setLines([]);
      setInputValue("");
      setActiveScenario(scenario);
      setSource(scenario.files["index.ts"]);
      setActiveTab("code");
      setPreviewUrl(null);

      container = await boot({
        workdirName: "/home/web",
        swPath: "/sw.js",
      });
      container.on("server-ready", (_port, url) => setPreviewUrl(url));

      await container.mount({
        "package.json": { file: { contents: scenario.files["package.json"] } },
        "index.ts": { file: { contents: scenario.files["index.ts"] } },
      });

      setBootState("installing");
      appendLine("\x1b[2m~/demo $ npm install\x1b[0m\r\n");
      await runToCompletion(container.spawn("npm", ["install", "--ignore-scripts"]));

      setBootState("ready");
    } catch (e) {
      console.error("[demo] Boot failed:", e);
      setBootState("error");
    }
  };

  onMount(() => {
    bootScenario(defaultScenario);
  });

  const handleSubmit = async (line: string) => {
    if (!container) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    await container.fs.writeFile(`${container.workdir}/index.ts`, source());
    const [command, ...args] = trimmed.split(/\s+/);
    if (!command) return;
    await runCommand(command, args);
  };

  const pasteCommand = (action: QuickAction) => {
    if (bootState() !== "ready") return;
    setInputValue([action.command, ...action.args].join(" "));
    setFocusInput((n) => n + 1);
  };

  return (
    <div class="demo-shell flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      <div class="flex shrink-0 items-center justify-between rounded-xl border border-border bg-[var(--surface-2)] px-3 py-1.5">
        <ScenarioPicker active={activeScenario()} disabled={bootState() !== "ready"} onSelect={bootScenario} />
      </div>

      <section
        class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-[var(--surface-2)] shadow-sm"
        style={{ flex: "1.6 1 0%", "min-height": "160px" }}
      >
        <EditorTabs
          activeTab={activeTab()}
          servesHttp={activeScenario().servesHttp}
          fileName={Object.keys(activeScenario().files).find((f) => f !== "package.json")!}
          onSelect={setActiveTab}
        />
        <div class="min-h-0 flex-1 overflow-hidden" classList={{ hidden: activeTab() !== "code" }}>
          <Editor value={source()} onChange={setSource} />
        </div>
        <div class="min-h-0 flex-1 overflow-hidden" classList={{ hidden: activeTab() !== "preview" }}>
          <Preview url={previewUrl()} />
        </div>
      </section>

      <div class="shrink-0">
        <ChipMarquee actions={activeScenario().quickActions} disabled={bootState() !== "ready"} onRun={pasteCommand} />
      </div>

      <section
        class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-[var(--surface-2)] shadow-sm"
        style={{ flex: "1 1 0%", "min-height": "100px" }}
      >
        <Terminal
          lines={lines()}
          disabled={bootState() !== "ready"}
          inputValue={inputValue()}
          focusTrigger={focusInput()}
          onSubmit={handleSubmit}
        />
      </section>

      <div class="flex shrink-0 items-center justify-end gap-2 text-[12px] leading-none text-muted">
        <span class={`size-2 rounded-full transition-colors duration-500 ${statusDotStyles[bootState()]}`} />
        <span>{statusLabels[bootState()]}</span>
      </div>
    </div>
  );
}
