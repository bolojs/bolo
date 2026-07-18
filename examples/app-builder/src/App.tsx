import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useContainer } from "./container/useContainer";
import { listFilesRecursive } from "./container/tools";
import { exportProjectZip } from "./container/exportZip";
import { useBuilderChat } from "./ai/useBuilderChat";
import {
  clearStoredApiKey,
  getStoredApiKey,
  getStoredBuildModelId,
  getStoredPlanModelId,
  getStoredUseSameModel,
  setStoredApiKey,
  setStoredBuildModelId,
  setStoredPlanModelId,
  setStoredUseSameModel,
} from "./ai/providers";
import Chat from "./ui/Chat";
import FileTree from "./ui/FileTree";
import Editor from "./ui/Editor";
import Terminal from "./ui/Terminal";
import Preview from "./ui/Preview";
import Tabs, { type PreviewTab } from "./ui/Tabs";
import ConfigDialog, { type BuilderConfig } from "./ui/ConfigDialog";
import TopBar from "./ui/TopBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const THEME_STORAGE_KEY = "bolo-app-builder:theme";

type Theme = "dark" | "light";

const getInitialTheme = (): Theme => {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
};

export default function App() {
  const { container, status, previewUrl, lines, runCommand, appendLine, saveSnapshot } = useContainer();
  const [apiKey, setApiKey] = useState<string | null>(() => getStoredApiKey());
  const [planModelId, setPlanModelId] = useState(() => getStoredPlanModelId());
  const [buildModelId, setBuildModelId] = useState(() => getStoredBuildModelId());
  const [useSameModel, setUseSameModel] = useState(() => getStoredUseSameModel());
  const [configOpen, setConfigOpen] = useState(() => !getStoredApiKey());

  // Persist a dev-injected key into localStorage once, so subsequent reloads
  // don't depend on the Vite dev plugin re-injecting (e.g. after `pnpm dev`
  // restarts). localStorage always wins after this point — explicit user
  // overrides via the dialog take priority forever.
  useEffect(() => {
    if (apiKey && !localStorage.getItem("bolo-app-builder:openrouter-api-key")) {
      setStoredApiKey(apiKey);
    }
  }, [apiKey]);
  const [tab, setTab] = useState<PreviewTab>("preview");
  const [theme, setTheme] = useState<Theme>(() => {
    const t = getInitialTheme();
    applyTheme(t);
    return t;
  });
  const [files, setFiles] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeContents, setActiveContents] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { turns, busy, send } = useBuilderChat(container, apiKey, planModelId, buildModelId, appendLine);

  const refreshFiles = async () => {
    if (!container) return;
    const list = await listFilesRecursive(container, container.workdir);
    setFiles(list.map((f) => f.slice(container.workdir.length + 1)));
  };

  useEffect(() => {
    if (status === "ready") refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Tool calls (writeFile/deleteFile/runCommand) mutate the container's fs
  // out-of-band from React state; re-list after every assistant turn settles.
  useEffect(() => {
    if (!busy && turns.length > 0) refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  useEffect(() => {
    if (!container || !activePath) {
      setActiveContents("");
      return;
    }
    let cancelled = false;
    container.fs.readFile(`${container.workdir}/${activePath}`).then((contents) => {
      if (!cancelled) {
        setActiveContents(contents);
        setSaveState("saved");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [container, activePath]);

  useEffect(() => {
    return () => {
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    };
  }, []);

  const handleEditorChange = async (value: string) => {
    setActiveContents(value);
    if (!container || !activePath) return;
    await container.fs.writeFile(`${container.workdir}/${activePath}`, value);

    setSaveState("dirty");
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(async () => {
      setSaveState("saving");
      await saveSnapshot();
      setSaveState("saved");
    }, 600);
  };

  const handleConfigSave = (config: BuilderConfig) => {
    setStoredApiKey(config.apiKey);
    setStoredPlanModelId(config.planModelId);
    setStoredBuildModelId(config.buildModelId);
    setStoredUseSameModel(config.useSameModel);
    setApiKey(config.apiKey);
    setPlanModelId(config.planModelId);
    setBuildModelId(config.buildModelId);
    setUseSameModel(config.useSameModel);
    setConfigOpen(false);
  };

  const handleForgetApiKey = () => {
    clearStoredApiKey();
    setApiKey(null);
    setConfigOpen(true);
  };

  const handleTerminalSubmit = async (line: string) => {
    const [command, ...args] = line.split(/\s+/).filter(Boolean);
    if (!command) return;
    await runCommand(command, args);
  };

  const handleExport = () => {
    if (container) void exportProjectZip(container);
  };

  const toggleTheme = () => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      localStorage.setItem(THEME_STORAGE_KEY, next);
      return next;
    });
  };

  return (
    <TooltipProvider>
    <div className="flex h-screen flex-col">
    <TopBar
      status={status}
      theme={theme}
      onToggleTheme={toggleTheme}
      onOpenConfig={() => setConfigOpen(true)}
      onExport={handleExport}
      exportDisabled={!container || status !== "ready"}
    />
    <Group orientation="horizontal" className="min-h-0 flex-1">
      <Panel defaultSize="22%" minSize="15%" maxSize="40%">
      <aside className="flex h-full min-h-0 flex-col border-r border-border">
        {apiKey ? (
          <Chat turns={turns} busy={busy} disabled={status !== "ready"} onSend={send} />
        ) : (
          <div className="p-3 text-[13px]">Configure OpenRouter to start building.</div>
        )}
      </aside>
      </Panel>
      <Separator className="w-px bg-border" />
      <Panel>
      <Group orientation="vertical">
      <Panel defaultSize="75%" minSize="30%" className="flex min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
          <Tabs active={tab} onSelect={setTab} />
          {tab === "code" && activePath && (
            <span className="flex items-center gap-1 text-[11px] opacity-60">
              <span
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  saveState === "saved" && "bg-status-ok",
                  saveState === "saving" && "bg-status-pending",
                  saveState === "dirty" && "bg-muted-foreground",
                )}
              />
              {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Unsaved"}
            </span>
          )}
        </div>
        {tab === "code" ? (
          <Group orientation="horizontal" className="min-h-0 flex-1">
            <Panel defaultSize="20%" minSize="12%" maxSize="40%">
              <FileTree files={files} activePath={activePath} onSelect={setActivePath} />
            </Panel>
            <Separator className="w-px bg-border" />
            <Panel>
              {activePath ? (
                <Editor path={activePath} value={activeContents} theme={theme} onChange={handleEditorChange} />
              ) : (
                <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
                  Select a file
                </div>
              )}
            </Panel>
          </Group>
        ) : (
          <div className="min-h-0 flex-1">
            <Preview url={previewUrl} />
          </div>
        )}
      </Panel>
      <Separator className="h-px bg-border" />
      <Panel defaultSize="25%" minSize="10%" className="min-h-0">
        <Terminal lines={lines} disabled={status !== "ready"} theme={theme} onSubmit={handleTerminalSubmit} />
      </Panel>
      </Group>
      </Panel>
    </Group>
    </div>

    <ConfigDialog
      open={configOpen}
      initial={{ apiKey: apiKey ?? "", planModelId, buildModelId, useSameModel }}
      onSave={handleConfigSave}
      onCancel={apiKey ? () => setConfigOpen(false) : undefined}
      onForgetApiKey={apiKey ? handleForgetApiKey : undefined}
    />
    </TooltipProvider>
  );
}
