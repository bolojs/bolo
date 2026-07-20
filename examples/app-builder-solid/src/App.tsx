import {
  createSignal,
  onMount,
  onCleanup,
  Show,
  createEffect,
  For,
  Switch,
  Match,
} from "solid-js";
import { PanelGroup, Panel, ResizeHandle } from "solid-resizable-panels";
import { boot, type BrowserContainer } from "@bolojs/runtime";
import { starterTree } from "./container/scaffold";
import {
  loadProjectSnapshot,
  restoreProjectSnapshot,
  saveProjectSnapshot,
} from "./container/persist";
import { exportProjectZip } from "./container/exportZip";
import { listFilesRecursive } from "./container/tools";
import { cn } from "./lib/utils";
import { Chat } from "./ui/Chat";
import FileTree from "./ui/FileTree";
import Editor from "./ui/Editor";
import Terminal from "./ui/Terminal";
import Preview from "./ui/Preview";
import Tabs, { type PreviewTab } from "./ui/Tabs";
import TopBar, { type Status } from "./ui/TopBar";
import { type BuilderConfig, default as ConfigDialog } from "./ui/ConfigDialog";
import { createBuilderChat } from "./ai/useBuilderChat";
import { useIsMobile } from "./hooks/use-mobile";
import {
  getStoredApiKey,
  setStoredApiKey,
  clearStoredApiKey,
  getStoredPlanModelId,
  setStoredPlanModelId,
  getStoredBuildModelId,
  setStoredBuildModelId,
  getStoredUseSameModel,
  setStoredUseSameModel,
} from "./ai/providers";

const PROJECT_ID = "default";
const THEME_KEY = "bolo-app-builder:theme";

function readInitialTheme(): "dark" | "light" {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Host component — full Solid port of
 * `examples/app-builder/src/App.tsx` (300 LOC React).
 *
 * Layout: desktop 3-pane resizable (Chat | Editor+Preview | Terminal),
 * mobile vertical tabbed. Wires FileTree, Editor, Terminal, Preview into
 * signals — no `useContainer` hook indirection, no `useEffect`/`useRef`
 * dance. State lives in signals; imperative bridges (Editor/Terminal/Preview)
 * take accessor-driven props and rely on Solid's reactive disposal.
 *
 * Boot path ported from `useContainer.ts`. Save-state debounce replaced
 * with a plain setTimeout + onCleanup pair (no `useRef<setTimeout>`).
 */
export default function App() {
  const isMobile = useIsMobile();
  const [status, setStatus] = createSignal<Status>("booting");
  const [error, setError] = createSignal<string>("");
  const [theme, setTheme] = createSignal<"dark" | "light">(readInitialTheme());
  const [configOpen, setConfigOpen] = createSignal(false);

  const [apiKey, setApiKey] = createSignal<string | null>(getStoredApiKey());
  const [planModelId, setPlanModelIdId] = createSignal(getStoredPlanModelId());
  const [buildModelId, setBuildModelIdId] = createSignal(getStoredBuildModelId());
  const [useSameModel, setUseSameModelFlag] = createSignal(getStoredUseSameModel());

  // Layout / file state.
  const [tab, setTab] = createSignal<PreviewTab>("preview");
  const [files, setFiles] = createSignal<string[]>([]);
  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [activeContents, setActiveContents] = createSignal("");
  const [saveState, setSaveState] = createSignal<"saved" | "saving" | "dirty">(
    "saved",
  );
  const [lines, setLines] = createSignal<string[]>([]);
  const [previewUrl, setPreviewUrl] = createSignal("");

  let container: BrowserContainer | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const appendLine = (line: string) =>
    setLines((prev) => [...prev, line]);
  const saveSnapshot = () => saveProjectSnapshot(PROJECT_ID);

  const chat = createBuilderChat(
    () => container,
    () => apiKey() ?? "",
    () => planModelId(),
    () => (useSameModel() ? planModelId() : buildModelId()),
    appendLine,
  );

  // Theme apply + persist.
  createEffect(() => {
    const t = theme();
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem(THEME_KEY, t);
  });

  // Auto-open ConfigDialog if no key on first ready.
  let autoOpenDone = false;
  createEffect(() => {
    if (status() === "ready" && !autoOpenDone) {
      autoOpenDone = true;
      if (!apiKey()) setConfigOpen(true);
    }
  });

  // Refresh file list on ready (after npm install settles).
  let lastFilesRefresh = 0;
  const refreshFiles = async () => {
    const c = container;
    if (!c) return;
    const list = await listFilesRecursive(c, c.workdir);
    setFiles(list.map((f) => f.slice(c.workdir.length + 1)));
    lastFilesRefresh = Date.now();
  };
  createEffect(() => {
    if (status() === "ready") void refreshFiles();
  });
  // Tool calls mutate container.fs out-of-band; re-list after each turn.
  createEffect(() => {
    if (!chat.busy() && chat.turns.length > 0) void refreshFiles();
  });

  // Read active file contents when activePath changes.
  createEffect(() => {
    const path = activePath();
    if (!container || !path) {
      setActiveContents("");
      return;
    }
    let cancelled = false;
    container.fs
      .readFile(`${container.workdir}/${path}`)
      .then((contents) => {
        if (!cancelled) {
          setActiveContents(contents);
          setSaveState("saved");
        }
      })
      .catch((err) => {
        if (!cancelled) console.error("[app-builder-solid] readFile:", err);
      });
    onCleanup(() => {
      cancelled = true;
    });
  });

  const handleEditorChange = async (value: string) => {
    setActiveContents(value);
    const path = activePath();
    const c = container;
    if (!c || !path) return;
    await c.fs.writeFile(`${c.workdir}/${path}`, value);
    setSaveState("dirty");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      setSaveState("saving");
      try {
        await saveSnapshot();
      } finally {
        setSaveState("saved");
      }
    }, 600);
  };

  const handleTerminalSubmit = async (line: string) => {
    if (!container) return;
    const [command, ...args] = line.split(/\s+/).filter(Boolean);
    if (!command) return;
    appendLine(`$ ${line}`);
    try {
      const proc = container.spawn(command, args);
      const reader = proc.output.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer +=
          typeof value === "string"
            ? value
            : decoder.decode(value, { stream: true });
        const newLines = buffer.split("\n");
        buffer = newLines.pop() ?? "";
        for (const ln of newLines) appendLine(ln);
      }
      if (buffer) appendLine(buffer);
      const code = await proc.exit;
      if (code !== 0) appendLine(`[exit ${code}]`);
    } catch (err) {
      appendLine(
        `[error] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const toggleTheme = () =>
    setTheme((t) => (t === "dark" ? "light" : "dark"));

  const onExport = async () => {
    if (!container) return;
    try {
      await exportProjectZip(container);
    } catch (err) {
      console.error("[app-builder-solid] export failed:", err);
    }
  };

  const onConfigSave = (cfg: BuilderConfig) => {
    setStoredApiKey(cfg.apiKey);
    setStoredPlanModelId(cfg.planModelId);
    setStoredBuildModelId(cfg.buildModelId);
    setStoredUseSameModel(cfg.useSameModel);
    setApiKey(cfg.apiKey);
    setPlanModelIdId(cfg.planModelId);
    setBuildModelIdId(cfg.buildModelId);
    setUseSameModelFlag(cfg.useSameModel);
    setConfigOpen(false);
  };

  const onConfigCancel = () => setConfigOpen(false);
  const onForgetApiKey = () => {
    clearStoredApiKey();
    setApiKey(null);
    setConfigOpen(false);
  };

  const configInitial = (): BuilderConfig => ({
    apiKey: apiKey() ?? "",
    planModelId: planModelId(),
    buildModelId: buildModelId(),
    useSameModel: useSameModel(),
  });

  onMount(async () => {
    try {
      const c = await boot({ workdirName: "/home/web", swPath: "/sw.js" });
      container = c;

      // server-ready → preview URL.
      // ponytail: container.on("server-ready", cb) passes (port, url); we only
      // need the url for the iframe.
      c.on?.("server-ready", (_port: number, url: string) => setPreviewUrl(url));

      const snap = await loadProjectSnapshot(PROJECT_ID);
      if (snap) {
        restoreProjectSnapshot(snap);
      } else {
        await c.mount(starterTree);
      }

      setStatus("installing");
      appendLine("$ npm install --ignore-scripts");
      const proc = c.spawn("npm", ["install", "--ignore-scripts"]);
      const reader = proc.output.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer +=
          typeof value === "string"
            ? value
            : decoder.decode(value, { stream: true });
        const newLines = buffer.split("\n");
        buffer = newLines.pop() ?? "";
        for (const ln of newLines) appendLine(ln);
      }
      if (buffer) appendLine(buffer);
      const code = await proc.exit;
      if (code !== 0) appendLine(`[exit ${code}]`);
      await saveSnapshot();

      setStatus("ready");
    } catch (err) {
      console.error("[app-builder-solid] boot failed:", err);
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  });

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer);
    container?.teardown();
    container = null;
  });

  const SaveIndicator = () => (
    <span class="flex items-center gap-1 text-[11px] opacity-60">
      <span
        class={cn(
          "inline-block size-1.5 rounded-full",
          saveState() === "saved" && "bg-status-ok",
          saveState() === "saving" && "bg-status-pending",
          saveState() === "dirty" && "bg-muted-foreground",
        )}
      />
      {saveState() === "saved"
        ? "Saved"
        : saveState() === "saving"
          ? "Saving…"
          : "Unsaved"}
    </span>
  );

  const ChatOrPlaceholder = () => (
    <Show
      when={apiKey()}
      fallback={
        <div class="p-3 text-[13px]">Configure OpenRouter to start building.</div>
      }
    >
      <Chat
        turns={chat.turns}
        busy={chat.busy()}
        disabled={status() !== "ready"}
        onSend={chat.send}
      />
    </Show>
  );

  const CodePane = () => (
    <PanelGroup direction="row" class="min-h-0 flex-1">
      <Panel id="filetree" initialSize={20} minSize={12} maxSize={40}>
        <FileTree
          files={files()}
          activePath={activePath()}
          onSelect={setActivePath}
        />
      </Panel>
      <ResizeHandle class="w-px bg-border" />
      <Panel id="editor">
        <Show
          when={activePath()}
          fallback={
            <div class="flex h-full items-center justify-center text-[13px] text-muted-foreground">
              Select a file
            </div>
          }
        >
          {(path) => (
            <Editor
              path={path()}
              value={activeContents()}
              theme={theme()}
              onChange={handleEditorChange}
            />
          )}
        </Show>
      </Panel>
    </PanelGroup>
  );

  return (
    <div class="flex h-screen flex-col">
      <TopBar
        status={status()}
        theme={theme()}
        onToggleTheme={toggleTheme}
        onOpenConfig={() => setConfigOpen(true)}
        onExport={onExport}
        exportDisabled={status() !== "ready"}
      />

      <Show when={status() !== "ready"}>
        <div class="flex-1 min-h-0 flex items-center justify-center font-mono p-8 text-center">
          <Switch>
            <Match when={status() === "booting"}>
              <p>Booting container…</p>
            </Match>
            <Match when={status() === "installing"}>
              <div>
                <p>Installing dependencies (this can take ~30s on first run)…</p>
                <p class="mt-2 text-sm opacity-70">
                  See terminal pane once ready.
                </p>
              </div>
            </Match>
            <Match when={status() === "error"}>
              <div>
                <p>
                  Boot failed: <code>{error()}</code>
                </p>
                <p class="mt-2 text-sm opacity-70">
                  See browser console for details.
                </p>
              </div>
            </Match>
          </Switch>
        </div>
      </Show>

      <Show when={status() === "ready"}>
        <Show
          when={isMobile()}
          fallback={
            <PanelGroup direction="row" class="min-h-0 flex-1">
              <Panel id="chat" initialSize={22} minSize={15} maxSize={40}>
                <aside class="flex h-full min-h-0 flex-col border-r border-border">
                  <ChatOrPlaceholder />
                </aside>
              </Panel>
              <ResizeHandle class="w-px bg-border" />
              <Panel id="center">
                <PanelGroup direction="column">
                  <Panel
                    id="center-top"
                    initialSize={75}
                    minSize={30}
                    class="flex min-h-0 flex-col"
                  >
                    <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
                      <Tabs active={tab()} onSelect={setTab} />
                      <Show when={tab() === "code" && activePath()}>
                        <SaveIndicator />
                      </Show>
                    </div>
                    <Show
                      when={tab() === "code"}
                      fallback={
                        <div class="min-h-0 flex-1">
                          <Preview url={previewUrl()} />
                        </div>
                      }
                    >
                      <CodePane />
                    </Show>
                  </Panel>
                  <ResizeHandle class="h-px bg-border" />
                  <Panel id="terminal" initialSize={25} minSize={10} class="min-h-0">
                    <Terminal
                      lines={lines()}
                      disabled={status() !== "ready"}
                      theme={theme()}
                      onSubmit={handleTerminalSubmit}
                    />
                  </Panel>
                </PanelGroup>
              </Panel>
            </PanelGroup>
          }
        >
          {/* Mobile: vertical tabbed layout. */}
          <div class="flex min-h-0 flex-1 flex-col">
            <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
              <Tabs active={tab()} onSelect={setTab} mobile />
              <Show when={tab() === "code" && activePath()}>
                <SaveIndicator />
              </Show>
            </div>
            <Show when={tab() === "chat"}>
              <div class="min-h-0 flex-1">
                <ChatOrPlaceholder />
              </div>
            </Show>
            <Show when={tab() === "preview"}>
              <div class="min-h-0 flex-1">
                <Preview url={previewUrl()} />
              </div>
            </Show>
            <Show when={tab() === "code"}>
              <div class="flex min-h-0 flex-1 flex-col">
                <div class="max-h-[35vh] shrink-0 overflow-auto border-b border-border">
                  <FileTree
                    files={files()}
                    activePath={activePath()}
                    onSelect={setActivePath}
                  />
                </div>
                <div class="min-h-0 flex-1">
                  <Show
                    when={activePath()}
                    fallback={
                      <div class="flex h-full items-center justify-center text-[13px] text-muted-foreground">
                        Select a file
                      </div>
                    }
                  >
                    {(path) => (
                      <Editor
                        path={path()}
                        value={activeContents()}
                        theme={theme()}
                        onChange={handleEditorChange}
                      />
                    )}
                  </Show>
                </div>
              </div>
            </Show>
            <Show when={tab() === "terminal"}>
              <Terminal
                lines={lines()}
                disabled={status() !== "ready"}
                theme={theme()}
                onSubmit={handleTerminalSubmit}
              />
            </Show>
          </div>
        </Show>
      </Show>

      <ConfigDialog
        open={configOpen()}
        initial={configInitial()}
        onSave={onConfigSave}
        onCancel={onConfigCancel}
        onForgetApiKey={onForgetApiKey}
      />
    </div>
  );
}
