/** @jsxImportSource solid-js */
import "../../demo/client-globals";
import { createSignal, onMount } from "solid-js";
import { getLogger } from "@bolojs/log/browser";
import type { BrowserContainer, ReplResult } from "@bolojs/runtime";
import type { FileSystemTree } from "@bolojs/runtime";
import { BrowserViteServer } from "@bolojs/vite-server";
import { NextDevServer } from "@bolojs/next-server";
import { SWSandbox } from "@bolojs/sandbox";
import { bootSubsite, getBootedVfs } from "../shared/boot";
import { installSwErrorTracking } from "../shared/sw-handlers";
import Terminal from "../ui/Terminal";
import Editor, { type EditorDocument } from "../ui/Editor";
import Preview from "../ui/Preview";
import FileTree from "../ui/FileTree";
import SplitPane from "../ui/SplitPane";
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

const VITE_BASE = "/__preview/";
const NEXT_BASE = "/__next/";
const PREVIEW_SW_PATH = "/sw.js";

/**
 * The /ide workbench, StackBlitz-embed style: file tree + editor on the
 * left, live preview on the right, terminal drawer underneath.
 *
 * Preview wiring: the runtime's own BrowserViteServer answers top-page
 * requests, but the preview iframe is a separate client at "/__preview/"
 * (root-SW scope), which the subsite's "/ide/sw.js" cannot control. So the
 * IDE pairs with the root SW itself and serves the iframe through a
 * dedicated BrowserViteServer over the same VfsBus. Editor writes flow
 * through the runtime's VfsBus watch into broadcastHmr plus the debounced
 * "bolo-preview" reload the Preview panel listens on.
 */
export default function IdeApp() {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [documents, setDocuments] = createSignal<EditorDocument[]>([]);
  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [lines, setLines] = createSignal<string[]>([]);
  const [inputValue, setInputValue] = createSignal("");
  const [replActive, setReplActive] = createSignal(false);
  let container: BrowserContainer | undefined;
  let previewServer: BrowserViteServer | undefined;
  let nextServer: NextDevServer | undefined;
  let rootSandbox: SWSandbox | undefined;

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
    const exitCode = await runToCompletion(container.spawn(command, args));
    appendLine(`\r\n\x1b[2mexit ${exitCode}\x1b[0m\r\n`);
  };

  const openFile = async (path: string) => {
    if (!container) return;
    const contents = await container.fs.readFile(path).catch(() => "");
    setDocuments((docs) =>
      docs.some((d) => d.path === path) ? docs : [...docs, { path, contents }],
    );
    setActivePath(path);
  };

  const handleChange = (path: string, contents: string) => {
    setDocuments((docs) => docs.map((d) => (d.path === path ? { ...d, contents } : d)));
    void container?.fs.writeFile(path, contents).catch((err: unknown) => {
      logger.error("editor write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const handleClose = (path: string) => {
    setDocuments((docs) => {
      const next = docs.filter((d) => d.path !== path);
      if (activePath() === path) setActivePath(next[next.length - 1]?.path ?? null);
      return next;
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

  /** Serve the iframes (root-SW scope) through dedicated dev servers. */
  const startPreviewServers = async () => {
    const vfs = getBootedVfs();
    const workdir = container?.workdir ?? "/home/web";
    previewServer = new BrowserViteServer({ vfs, root: workdir, base: VITE_BASE });
    await previewServer.start();
    nextServer = new NextDevServer({ vfs, root: workdir, base: NEXT_BASE.replace(/\/$/, "") });
    await nextServer.start();
    rootSandbox = await SWSandbox.create({
      origin: globalThis.location.origin,
      swPath: PREVIEW_SW_PATH,
    });
    const withIsolationHeaders = (response: Response) => {
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Embedder-Policy", "credentialless");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
    rootSandbox.onFetch(async (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith(VITE_BASE)) {
        const serverUrl = new URL(req.url);
        serverUrl.pathname = url.pathname.replace(/^\/(__preview)/, "") || "/";
        return withIsolationHeaders(await previewServer!.onFetch(serverUrl.toString(), req));
      }
      if (url.pathname.startsWith(NEXT_BASE)) {
        const response = await nextServer!.onFetch(req.url, req);
        if (response) return withIsolationHeaders(response);
      }
      throw new Error("not handled");
    });
  };

  /** The initial "server-ready" fires during boot before listeners attach,
   *  so poll the preview URL from the (SW-controlled) top page until the
   *  Vite server actually serves HTML, then reveal the iframe. */
  const waitForPreview = async (base: string): Promise<void> => {
    const url = new URL(base, globalThis.location.origin).href;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        const body = await response.text();
        if (response.status === 200 && body.includes("<")) {
          setPreviewUrl(url);
          return;
        }
      } catch {
        // SW not ready yet; retry.
      }
      if (Date.now() > deadline) {
        throw new Error("Preview server did not serve HTML within 30s");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  const selectTemplate = async (template: IdeTemplate) => {
    if (!container) return;
    try {
      setBootState("installing");
      appendLine(`\x1b[2mCreating project from template: ${template.name}\x1b[0m\r\n`);
      await container.mount(templateToTree(template.files));
      await openFile(`${container.workdir}/${template.entry}`).catch(() => {});
      appendLine("\x1b[2m~/project $ npm install\x1b[0m\r\n");
      await runToCompletion(container.spawn("npm", ["install"]));
      appendLine("\r\n\x1b[2mexit 0\x1b[0m\r\n");
      await startPreviewServers();
      // Next is served by NextDevServer directly; there is no `next dev` process.
      if (template.kind === "vite") await runCommand("npm", ["run", "dev"]);
      else appendLine("\x1b[2mNext dev server mounted at /__next/\x1b[0m\r\n");
      await waitForPreview(template.previewBase);
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

  const terminal = () => (
    <Terminal
      lines={lines()}
      disabled={bootState() !== "ready"}
      inputValue={inputValue()}
      onSubmit={handleSubmit}
    />
  );

  const workbench = () =>
    bootState() === "picking" || bootState() === "booting" || bootState() === "error" ? (
      templatePicker()
    ) : (
      <SplitPane
        direction="row"
        initialRatio={0.2}
        dataPanel="workbench"
        first={
          <FileTree
            vfs={getBootedVfs()}
            root={container?.workdir ?? "/home/web"}
            activePath={activePath()}
            onSelect={(path) => void openFile(path)}
            exclude={(path) => path.includes("node_modules") || path.includes("/.npm-cache/")}
          />
        }
        second={
          <SplitPane
            direction="column"
            initialRatio={0.68}
            dataPanel="workbench-main"
            first={
              <SplitPane
                direction="row"
                initialRatio={0.55}
                dataPanel="editor-preview"
                first={
                  <Editor
                    documents={documents()}
                    activePath={activePath()}
                    onSelect={setActivePath}
                    onClose={handleClose}
                    onChange={handleChange}
                  />
                }
                second={<Preview url={previewUrl()} />}
              />
            }
            second={terminal()}
          />
        }
      />
    );

  return (
    <div
      data-subsite="ide"
      data-panels="file-tree editor preview terminal"
      data-boot-state={bootState() === "booting" || bootState() === "error" ? bootState() : "ready"}
      data-project-state={bootState()}
      class="flex h-full min-h-0 flex-col gap-2 overflow-hidden"
    >
      <div class="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-[var(--surface-2)] shadow-sm">
        {workbench()}
      </div>
      <div class="flex shrink-0 items-center justify-end gap-2 text-[12px] leading-none text-muted">
        <span
          class={`size-2 rounded-full transition-colors duration-500 ${statusDotStyles[bootState()]}`}
        />
        <span>{statusLabels[bootState()]}</span>
      </div>
    </div>
  );
}
