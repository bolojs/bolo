/** @jsxImportSource solid-js */
import "../../demo/client-globals";
import { createSignal, onMount } from "solid-js";
import { getLogger } from "@bolojs/log/browser";
import type { BrowserContainer, ReplResult } from "@bolojs/runtime";
import { bootSubsite } from "../shared/boot";
import { installSwErrorTracking, observePreviewUrl } from "../shared/sw-handlers";
import Terminal from "../ui/Terminal";
import Preview from "../ui/Preview";
import SplitPane from "../ui/SplitPane";

declare global {
  var __preferLocalRolldown: boolean | undefined;
}

// See Demo.tsx: the esm.sh-hosted rolldown build panics in real browsers, so
// opt into the same-origin bundled dependency.
globalThis.__preferLocalRolldown = true;

const logger = getLogger(["bolo", "site-landing", "sandbox"]);

type BootState = "booting" | "ready" | "error";
type TerminalTab = "script" | "repl";

const statusLabels: Record<BootState, string> = {
  booting: "booting…",
  ready: "ready",
  error: "error",
};

const statusDotStyles: Record<BootState, string> = {
  booting: "bg-muted animate-pulse",
  ready: "bg-[var(--success)]",
  error: "bg-[var(--danger)]",
};

const STARTER_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    { name: "bolo-sandbox", private: true, type: "module" },
    null,
    2,
  ),
  "index.js": 'console.log("Hello from the bolo sandbox");\nconsole.log("node " + process.version);\n',
  "chalk-demo.js":
    'import chalk from "chalk";\nconsole.log("chalk says " + chalk.green("hello"));\n',
  "server.js":
    'import { createServer } from "node:http";\n\nconst server = createServer((_req, res) => {\n  res.writeHead(200, { "content-type": "text/plain" });\n  res.end("hello from the sandbox server");\n});\nserver.listen(3000, () => console.log("sandbox server listening on 3000"));\n',
};

interface ExampleChip {
  label: string;
  tab: TerminalTab;
  command: string;
  note: string;
}

const CHIPS: ExampleChip[] = [
  { label: "Run index.js", tab: "script", command: "node index.js", note: "run a script" },
  { label: "Install chalk", tab: "script", command: "npm install chalk", note: "npm install" },
  { label: "Try chalk", tab: "script", command: "node chalk-demo.js", note: "use the package" },
  { label: "Start HTTP server", tab: "script", command: "node server.js", note: "http server" },
  { label: "REPL: open a function", tab: "repl", command: "const twice = (n) => {", note: "repl continuation" },
];

export default function SandboxApp() {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [tab, setTab] = createSignal<TerminalTab>("script");
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [scriptLines, setScriptLines] = createSignal<string[]>([]);
  const [replLines, setReplLines] = createSignal<string[]>([]);
  const [replStarted, setReplStarted] = createSignal(false);
  const [scriptInput, setScriptInput] = createSignal({ value: "", trigger: 0 });
  const [replInput, setReplInput] = createSignal({ value: "", trigger: 0 });
  let container: BrowserContainer | undefined;
  let replStartPromise: Promise<void> | null = null;

  const appendScript = (s: string) => setScriptLines((prev) => [...prev, s]);
  const appendRepl = (s: string) => setReplLines((prev) => [...prev, s]);

  const runToCompletion = async (proc: ReturnType<BrowserContainer["spawn"]>) => {
    const reader = proc.output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        appendScript(value);
      }
    } finally {
      reader.releaseLock();
    }
    return proc.exit;
  };

  const runScriptCommand = async (line: string) => {
    if (!container) return;
    const [command, ...args] = line.split(/\s+/);
    if (!command) return;
    appendScript(`\r\n\x1b[2m~/project $ ${line}\x1b[0m\r\n`);
    const exitCode = await runToCompletion(container.spawn(command, args));
    appendScript(`\r\n\x1b[2mexit ${exitCode}\x1b[0m\r\n`);
  };

  const startRepl = (): Promise<void> => {
    if (!container) return Promise.resolve();
    replStartPromise ??= (async () => {
      appendRepl("\x1b[2mStarting Node.js REPL…\x1b[0m\r\n");
      await container?.startRepl();
      appendRepl("\x1b[2mWelcome to Node.js REPL. Type \".exit\" to leave.\x1b[0m\r\n");
      setReplStarted(true);
    })().catch((err: unknown) => {
      replStartPromise = null;
      throw err;
    });
    return replStartPromise;
  };

  const submitReplLine = async (line: string): Promise<{ continuation?: boolean } | void> => {
    if (!container) return;
    if (line.trim() === ".exit") {
      container.exitRepl();
      setReplStarted(false);
      replStartPromise = null;
      appendRepl("\r\n\x1b[2mREPL closed. Switch back anytime.\x1b[0m\r\n");
      return;
    }
    const result: ReplResult = await container.evalRepl(line);
    if (result.error) {
      appendRepl(`\x1b[31m${result.error}\x1b[0m\r\n`);
    } else if (result.value !== undefined) {
      appendRepl(`${result.value}\r\n`);
    }
    return result.continuation ? { continuation: true } : {};
  };

  const switchTab = (next: TerminalTab) => {
    setTab(next);
    if (next === "repl") void startRepl().catch((err: unknown) => {
      logger.error("repl start failed", { error: err instanceof Error ? err.message : String(err) });
    });
  };

  const runChip = (chip: ExampleChip) => {
    if (tab() !== chip.tab) switchTab(chip.tab);
    if (chip.tab === "script") {
      setScriptInput((prev) => ({ value: chip.command, trigger: prev.trigger + 1 }));
    } else {
      // Wait for the REPL terminal to mount and the session to start before
      // injecting; the input effect fires on the signal change either way,
      // and evalRepl queues behind startRepl via the container.
      void startRepl()
        .catch(() => {})
        .finally(() => setReplInput((prev) => ({ value: chip.command, trigger: prev.trigger + 1 })));
    }
  };

  onMount(() => {
    installSwErrorTracking();
    (async () => {
      try {
        container = await bootSubsite("sandbox");
        observePreviewUrl(container, setPreviewUrl);
        await container.mount(
          Object.fromEntries(
            Object.entries(STARTER_FILES).map(([name, contents]) => [
              name,
              { file: { contents } },
            ]),
          ),
        );
        appendScript("\x1b[2mWelcome to the bolo sandbox. Pick an example below or type a command.\x1b[0m\r\n");
        setBootState("ready");
      } catch (err) {
        logger.error("sandbox boot failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        setBootState("error");
      }
    })();
  });

  const terminal = () => {
    const active = tab();
    return (
      <Terminal
        lines={active === "script" ? scriptLines() : replLines()}
        disabled={bootState() !== "ready" || (active === "repl" && !replStarted())}
        inputValue={active === "script" ? scriptInput().value : replInput().value}
        focusTrigger={active === "script" ? scriptInput().trigger : replInput().trigger}
        onSubmit={(line) => (active === "script" ? runScriptCommand(line) : submitReplLine(line))}
      />
    );
  };

  return (
    <div
      data-subsite="sandbox"
      data-panels="terminal"
      data-boot-state={bootState()}
      data-terminal-tab={tab()}
      class="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div class="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-[var(--surface-2)] shadow-sm">
        {previewUrl() ? (
          <SplitPane
            direction="row"
            initialRatio={0.55}
            dataPanel="terminal-preview"
            first={terminal()}
            second={<Preview url={previewUrl()} />}
          />
        ) : (
          terminal()
        )}
      </div>
      <div class="flex shrink-0 flex-wrap items-center gap-2 pt-2">
        <div role="tablist" aria-label="Terminal mode" class="flex overflow-hidden rounded-lg border border-border">
          {(["script", "repl"] as const).map((name) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab() === name}
              data-tab={name}
              class="px-3 py-1.5 text-[12.5px] leading-none transition-colors"
              classList={{
                "bg-[var(--accent)] text-white": tab() === name,
                "text-muted hover:text-[var(--fg)]": tab() !== name,
              }}
              onClick={() => switchTab(name)}
            >
              {name === "script" ? "Script" : "REPL"}
            </button>
          ))}
        </div>
        {CHIPS.map((chip) => (
          <button
            type="button"
            class="rounded-full border border-border px-3 py-1.5 text-[12.5px] leading-none text-muted transition-colors hover:border-[var(--accent)] hover:text-[var(--fg)] disabled:opacity-40"
            disabled={bootState() !== "ready"}
            title={chip.note}
            onClick={() => runChip(chip)}
          >
            {chip.label}
          </button>
        ))}
        <span class="ml-auto flex items-center gap-2 text-[12px] leading-none text-muted">
          <span class={`size-2 rounded-full transition-colors duration-500 ${statusDotStyles[bootState()]}`} />
          <span>{statusLabels[bootState()]}</span>
        </span>
      </div>
    </div>
  );
}
