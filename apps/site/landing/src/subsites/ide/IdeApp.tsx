/** @jsxImportSource solid-js */
import "../../demo/client-globals";
import { createSignal, getOwner, onMount, runWithOwner } from "solid-js";
import type { JSX } from "solid-js";
import { getLogger } from "@bolojs/log/browser";
import type { BrowserContainer, ReplResult } from "@bolojs/runtime";
import type { FileSystemTree } from "@bolojs/runtime";
import { bootSubsite, getBootedVfs } from "../shared/boot";
import { installSwErrorTracking } from "../shared/sw-handlers";
import { startPreviewServers, waitForPreview } from "../shared/preview-servers";
import Terminal from "../ui/Terminal";
import Editor, { type EditorDocument } from "../ui/Editor";
import Preview from "../ui/Preview";
import FileTree from "../ui/FileTree";
import WorkbenchShell from "../workbench/WorkbenchShell";
import { createWorkbenchTabs } from "../workbench/tabs";
import type { PanelView, SidebarView, StatusItem } from "../workbench/types";
import { IDE_TEMPLATES, type IdeTemplate } from "./templates";

declare global {
  var __preferLocalRolldown: boolean | undefined;
}

// See Demo.tsx: the esm.sh-hosted rolldown build panics in real browsers, so
// opt into the same-origin bundled dependency.
globalThis.__preferLocalRolldown = true;

const logger = getLogger(["bolo", "site-landing", "subsite", "ide"]);

type BootState = "booting" | "picking" | "installing" | "ready" | "error";

const statusLabels: Record<BootState, string> = {
  booting: "booting…",
  picking: "pick a template",
  installing: "installing…",
  ready: "ready",
  error: "error",
};

const statusDotStyles: Record<BootState, string> = {
  booting: "bg-muted animate-pulse",
  picking: "bg-muted",
  installing: "bg-muted animate-pulse",
  ready: "bg-[var(--success)]",
  error: "bg-[var(--danger)]",
};

/** Nest a flat "src/main.tsx" -> contents map into a FileSystemTree. */
const templateToTree = (files: Record<string, string>): FileSystemTree => {
  const tree: FileSystemTree = {};
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split("/");
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      const existing = node[part];
      if (existing && "directory" in existing) {
        node = existing.directory;
      } else {
        const directory: FileSystemTree = {};
        node[part] = { directory };
        node = directory;
      }
    }
    node[parts[parts.length - 1]!] = { file: { contents } };
  }
  return tree;
};

const fileName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const codeTabId = (path: string) => `code:${path}`;

/**
 * The /ide workbench on the shared shell: an Explorer sidebar (file tree),
 * a tab strip hosting code tabs plus a pinned Preview tab, and a terminal
 * in the collapsible bottom panel.
 *
 * Preview wiring: the runtime's own BrowserViteServer answers top-page
 * requests, but the preview iframe is a separate client at "/__preview/"
 * (root-SW scope), which the subsite's "/ide/sw.js" cannot control. So the
 * IDE pairs with the root SW itself and serves the iframe through a
 * dedicated BrowserViteServer over the same VfsBus (see
 * shared/preview-servers.ts). Editor writes flow through the runtime's
 * VfsBus watch into broadcastHmr plus the debounced "bolo-preview" reload
 * the Preview panel listens on.
 */
export default function IdeApp() {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [documents, setDocuments] = createSignal<EditorDocument[]>([]);
  const [lines, setLines] = createSignal<string[]>([]);
  const [inputValue, setInputValue] = createSignal("");
  const [replActive, setReplActive] = createSignal(false);
  const tabs = createWorkbenchTabs();
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

  const runCommand = async (command: string, args: string[]) => {
    if (!container) return;
    appendLine(`\r\n\x1b[2m~/project $ ${[command, ...args].join(" ")}\x1b[0m\r\n`);
    const proc = container.spawn(command, args);
    currentProcess = proc;
    try {
      const exitCode = await runToCompletion(proc);
      appendLine(`\r\n\x1b[2mexit ${exitCode}\x1b[0m\r\n`);
    } finally {
      currentProcess = null;
    }
  };

  /**
   * One shared Editor reparented into the active code tab's body, so the
   * workbench strip owns file tabs while the Editor keeps its per-path
   * CodeMirror states (history and cursor survive tab switches). Created
   * under this component's owner: an element created inside a conditional
   * branch is disposed with it, which would destroy the EditorView.
   */
  const activeCodePath = () => {
    const id = tabs.activeId();
    return id?.startsWith("code:") ? id.slice("code:".length) : null;
  };

  const owner = getOwner();
  let editorEl: JSX.Element | undefined;
  const editor = () =>
    (editorEl ??= runWithOwner(owner, () => (
      <Editor
        documents={documents()}
        activePath={activeCodePath()}
        showTabs={false}
        onSelect={() => {}}
        onClose={(path) => tabs.close(codeTabId(path))}
        onChange={handleChange}
      />
    )));

  const openFile = async (path: string) => {
    if (!container) return;
    const contents = await container.fs.readFile(path).catch(() => "");
    setDocuments((docs) =>
      docs.some((d) => d.path === path) ? docs : [...docs, { path, contents }],
    );
    const id = codeTabId(path);
    tabs.open({
      id,
      kind: "code",
      title: fileName(path),
      onClose: () => setDocuments((docs) => docs.filter((d) => d.path !== path)),
      render: () => <div class="h-full min-h-0">{tabs.activeId() === id ? editor() : null}</div>,
    });
  };

  const handleChange = (path: string, contents: string) => {
    setDocuments((docs) => docs.map((d) => (d.path === path ? { ...d, contents } : d)));
    void container?.fs.writeFile(path, contents).catch((err: unknown) => {
      logger.error("editor write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const enterRepl = async () => {
    if (!container) return;
    await container.startRepl();
    appendLine('\r\n\x1b[2mWelcome to Node.js REPL. Type ".exit" to leave.\x1b[0m\r\n');
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

  const selectTemplate = async (template: IdeTemplate) => {
    if (!container) return;
    try {
      setBootState("installing");
      tabs.open({
        id: "preview",
        kind: "preview",
        title: "Preview",
        closable: false,
        render: () => <Preview url={previewUrl()} />,
      });
      appendLine(`\x1b[2mCreating project from template: ${template.name}\x1b[0m\r\n`);
      await container.mount(templateToTree(template.files));
      await openFile(`${container.workdir}/${template.entry}`).catch(() => {});
      appendLine("\x1b[2m~/project $ npm install\x1b[0m\r\n");
      await runToCompletion(container.spawn("npm", ["install"]));
      appendLine("\r\n\x1b[2mexit 0\x1b[0m\r\n");
      const previewServers = await startPreviewServers(
        getBootedVfs(),
        container.workdir ?? "/home/web",
      );
      // Next is served by NextDevServer directly; there is no `next dev` process.
      if (template.kind === "vite") await runCommand("npm", ["run", "dev"]);
      else appendLine("\x1b[2mNext dev server mounted at /__next/\x1b[0m\r\n");
      setPreviewUrl(await waitForPreview(previewServers, template.previewBase));
      tabs.activate("preview");
      setBootState("ready");
    } catch (err) {
      logger.error("template setup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      setBootState("error");
    }
  };

  onMount(() => {
    installSwErrorTracking();
    void (async () => {
      try {
        container = await bootSubsite("ide");
        setBootState("picking");
      } catch (err) {
        logger.error("ide boot failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        setBootState("error");
      }
    })();
  });

  const templatePicker = () => (
    <div
      data-panel="templates"
      class="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6"
    >
      <div class="w-full max-w-md">
        <h2 class="mb-1 text-[15px] font-semibold text-fg">Start a project</h2>
        <p class="mb-4 text-[12.5px] text-muted">
          Pick a template. bolo installs dependencies and serves the dev preview in your browser.
        </p>
        <div class="flex flex-col gap-2">
          {IDE_TEMPLATES.map((template) => (
            <button
              type="button"
              data-template={template.id}
              disabled={bootState() !== "picking"}
              class="rounded-lg border border-border bg-[var(--surface-2)] p-3 text-left transition-colors disabled:cursor-wait disabled:opacity-50 hover:border-[color-mix(in_srgb,var(--fg)_30%,transparent)]"
              onClick={() => void selectTemplate(template)}
            >
              <span class="block text-[13px] font-medium text-fg">{template.name}</span>
              <span class="block text-[12px] text-muted">{template.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  const sidebarViews: SidebarView[] = [
    {
      id: "explorer",
      title: "Explorer",
      width: 240,
      render: () => (
        <FileTree
          vfs={getBootedVfs()}
          root={container?.workdir ?? "/home/web"}
          activePath={activeCodePath()}
          onSelect={(path) => void openFile(path)}
          exclude={(path) => path.includes("node_modules") || path.includes("/.npm-cache/")}
        />
      ),
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

  const picking = () =>
    bootState() === "picking" || bootState() === "booting" || bootState() === "error";

  return (
    <WorkbenchShell
      subsite="ide"
      panels={["file-tree", "editor", "preview", "terminal"]}
      bootState={bootState() === "booting" || bootState() === "error" ? bootState() : "ready"}
      attrs={{ "data-project-state": bootState }}
      sidebar={sidebarViews}
      tabs={tabs}
      bottom={bottomPanels}
      status={statusItems}
      placeholder={picking() ? templatePicker() : null}
    />
  );
}
