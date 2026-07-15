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

type BootState = "booting" | "installing" | "switching" | "ready" | "error";

const statusStyles: Record<BootState, string> = {
  booting: "bg-white/5 text-muted",
  installing: "bg-white/5 text-muted",
  switching: "bg-white/5 text-muted",
  ready: "bg-[var(--success-bg)] text-[var(--success)]",
  error: "bg-[var(--danger-bg)] text-[var(--danger)]",
};

const panelShell =
  "flex min-h-0 flex-col overflow-hidden rounded-[1.25rem] bg-white/[0.03] p-1 ring-1 ring-white/[0.08] shadow-[inset_0_1px_1px_rgba(255,255,255,0.04)]";

const innerCard =
  "flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1rem] bg-[var(--surface-2)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]";

export default function Demo() {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [lines, setLines] = createSignal<string[]>([]);
  const [activeScenario, setActiveScenario] = createSignal<Scenario>(defaultScenario);
  const [source, setSource] = createSignal(defaultScenario.files["index.js"]);
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
      setSource(scenario.files["index.js"]);
      setActiveTab("code");
      setPreviewUrl(null);

      container = await boot({
        workdirName: "/home/web",
        swPath: "/sw.js",
      });
      container.on("server-ready", (_port, url) => setPreviewUrl(url));

      await container.mount({
        "package.json": { file: { contents: scenario.files["package.json"] } },
        "index.js": { file: { contents: scenario.files["index.js"] } },
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
    await container.fs.writeFile(`${container.workdir}/index.js`, source());
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
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <header class="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <span class="text-[13px] font-semibold tracking-tight text-fg">bolo</span>
        <ScenarioPicker active={activeScenario()} disabled={bootState() !== "ready"} onSelect={bootScenario} />
        <span
          class={`ml-auto rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${statusStyles[bootState()]}`}
        >
          {bootState()}
        </span>
      </header>

      <main class="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
        <div class={panelShell} style={{ flex: "1.6 1 0%", "min-height": "180px" }}>
          <section class={innerCard}>
            <EditorTabs activeTab={activeTab()} servesHttp={activeScenario().servesHttp} onSelect={setActiveTab} />
            <div class="min-h-0 flex-1 overflow-hidden" classList={{ hidden: activeTab() !== "code" }}>
              <Editor value={source()} onChange={setSource} />
            </div>
            <div class="min-h-0 flex-1 overflow-hidden" classList={{ hidden: activeTab() !== "preview" }}>
              <Preview url={previewUrl()} />
            </div>
          </section>
        </div>

        <div class="shrink-0">
          <ChipMarquee
            actions={activeScenario().quickActions}
            disabled={bootState() !== "ready"}
            onRun={pasteCommand}
          />
        </div>

        <div class={panelShell} style={{ flex: "1 1 0%", "min-height": "120px" }}>
          <section class={innerCard}>
            <Terminal
              lines={lines()}
              disabled={bootState() !== "ready"}
              inputValue={inputValue()}
              focusTrigger={focusInput()}
              onSubmit={handleSubmit}
            />
          </section>
        </div>
      </main>
    </div>
  );
}
