/** @jsxImportSource solid-js */
import "../../../demo/client-globals";
import { createSignal, getOwner, onMount, runWithOwner } from "solid-js";
import type { JSX } from "solid-js";
import { getLogger } from "@bolojs/log/browser";
import type { BrowserContainer, ReplResult } from "@bolojs/runtime";
import { bootSubsite } from "../../shared/boot";
import { installSwErrorTracking } from "../../shared/sw-handlers";
import Terminal from "../../ui/Terminal";
import WorkbenchShell from "../../workbench/WorkbenchShell";
import { createWorkbenchTabs } from "../../workbench/tabs";
import type { PanelView, SidebarView, StatusItem } from "../../workbench/types";
import { vibeStarterTree } from "../scaffold";
import VibeApp from "./VibeApp";
import VibePreview, { createVibePreview } from "./VibePreview";

declare global {
  var __preferLocalRolldown: boolean | undefined;
}

// See Demo.tsx: the esm.sh-hosted rolldown build panics in real browsers, so
// opt into the same-origin bundled dependency.
globalThis.__preferLocalRolldown = true;

const logger = getLogger(["bolo", "site-landing", "subsite", "vibe"]);

type BootState = "booting" | "installing" | "ready" | "error";

const statusLabels: Record<BootState, string> = {
  booting: "booting…",
  installing: "installing…",
  ready: "ready",
  error: "error",
};

const statusDotStyles: Record<BootState, string> = {
  booting: "bg-muted animate-pulse",
  installing: "bg-muted animate-pulse",
  ready: "bg-[var(--success)]",
  error: "bg-[var(--danger)]",
};

/**
 * The /vibe workbench on the shared shell: the assistant chat in the
 * contextual sidebar, a pinned Preview tab in the shared tab strip, and the
 * shell terminal in the collapsible bottom panel.
 *
 * The chat is a sidebar rather than a tab because it is the subsite's
 * primary surface — it must stay visible while the preview is inspected.
 */
export default function VibeWorkbench() {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [lines, setLines] = createSignal<string[]>([]);
  const [inputValue, setInputValue] = createSignal("");
  const [replActive, setReplActive] = createSignal(false);
  const vibePreview = createVibePreview();
  const tabs = createWorkbenchTabs();
  // The preview tab is pinned from the start: before the dev server exists
  // it shows the "no server yet" hint, so the strip is never empty.
  tabs.open({
    id: "preview",
    kind: "preview",
    title: "Preview",
    closable: false,
    render: () => <VibePreview html={vibePreview.html()} />,
  });
  let container: BrowserContainer | undefined;
  let currentProcess: ReturnType<BrowserContainer["spawn"]> | null = null;

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

  onMount(() => {
    installSwErrorTracking();
    void (async () => {
      try {
        container = await bootSubsite("vibe");
        await container.mount(vibeStarterTree);
        setBootState("installing");
        appendLine("\x1b[2m~/project $ npm install\x1b[0m\r\n");
        await runToCompletion(container.spawn("npm", ["install", "--ignore-scripts"]));
        appendLine("\r\n\x1b[2mexit 0\x1b[0m\r\n");
        setBootState("ready");
      } catch (err) {
        logger.error("vibe boot failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        setBootState("error");
      }
    })();
  });

  const runCommand = async (command: string, args: string[]) => {
    if (!container) return;
    const proc = container.spawn(command, args);
    currentProcess = proc;
    try {
      const exitCode = await runToCompletion(proc);
      appendLine(`\r\n\x1b[2mexit ${exitCode}\x1b[0m\r\n`);
    } finally {
      currentProcess = null;
    }
  };

  const enterRepl = async () => {
    if (!container) return;
    await container.startRepl();
    appendLine("\r\n\x1b[2mWelcome to Node.js REPL. Type \".exit\" to leave.\x1b[0m\r\n");
    setReplActive(true);
  };

  const handleReplLine = async (line: string): Promise<{ continuation?: boolean } | void> => {
    if (!container) return;
    if (line.trim() === ".exit") {
      container.exitRepl();
      setReplActive(false);
      appendLine("\r\n");
      return;
    }
    const result: ReplResult = await container.evalRepl(line);
    if (result.error) {
      appendLine(`\x1b[2m${result.error}\x1b[0m\r\n`);
    } else if (result.value !== undefined) {
      appendLine(`${result.value}\r\n`);
    }
    return result.continuation ? { continuation: true } : {};
  };

  const handleSubmit = async (line: string): Promise<{ continuation?: boolean } | void> => {
    setInputValue("");
    if (!container) return;
    if (replActive()) return handleReplLine(line);
    const trimmed = line.trim();
    if (!trimmed) return;
    const [command, ...args] = trimmed.split(/\s+/);
    if (!command) return;
    if (command === "node" && args.length === 0) {
      await enterRepl();
      return;
    }
    await runCommand(command, args);
  };

  // The chat lives in the sidebar and must survive collapse/expand, so it is
  // built once under this component's owner.
  const owner = getOwner();
  let chatEl: JSX.Element | undefined;
  const chat = () =>
    (chatEl ??= runWithOwner(owner, () => (
      <VibeApp
        getContainer={() => container}
        onOutput={appendLine}
        onDevServer={() => {
          void vibePreview.refresh().catch((err) =>
            logger.error("vibe preview refresh failed", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }}
        ready={bootState() === "ready"}
      />
    )));

  const sidebarViews: SidebarView[] = [
    {
      id: "chat",
      title: "Assistant",
      width: 380,
      render: () => chat(),
    },
  ];

  const bottomPanels: PanelView[] = [
    {
      id: "terminal",
      title: "Terminal",
      render: () => (
        <Terminal
          lines={lines()}
          disabled={bootState() !== "ready"}
          inputValue={inputValue()}
          prompt={replActive() ? "\x1b[36m>\x1b[0m " : "\x1b[36m~/project\x1b[0m $ "}
          onSubmit={handleSubmit}
          onInterrupt={() => currentProcess?.kill()}
        />
      ),
    },
  ];

  const statusItems: StatusItem[] = [
    {
      id: "boot-state",
      side: "left",
      render: () => (
        <span class="flex items-center gap-2">
          <span
            class={`size-2 rounded-full transition-colors duration-500 ${statusDotStyles[bootState()]}`}
          />
          <span>{statusLabels[bootState()]}</span>
        </span>
      ),
    },
    {
      id: "terminal-toggle",
      side: "right",
      render: (ctx) => (
        <button
          type="button"
          aria-expanded={ctx.panelVisible()}
          class="rounded px-1.5 py-0.5 transition-colors hover:text-fg"
          classList={{ "text-fg": ctx.panelVisible() }}
          onClick={() => ctx.togglePanel()}
        >
          Terminal
        </button>
      ),
    },
  ];

  return (
    <WorkbenchShell
      subsite="vibe"
      panels={["chat", "preview", "terminal"]}
      bootState={bootState()}
      sidebar={sidebarViews}
      tabs={tabs}
      bottom={bottomPanels}
      status={statusItems}
    />
  );
}
