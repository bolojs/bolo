/** @jsxImportSource solid-js */
import { createSignal, Show } from "solid-js";
import type { BrowserContainer } from "@bolojs/runtime";
import { createVibeChat } from "../ai/chat";
import {
  clearStoredApiKey,
  getStoredApiKey,
  getStoredModelId,
  getStoredProvider,
  setStoredApiKey,
  setStoredModelId,
  setStoredProvider,
} from "../ai/providers";
import { deleteProjectSnapshot } from "../persist";
import { exportProjectZip } from "../exportZip";
import VibeChat from "./VibeChat";
import ConfigDialog, { type VibeConfig } from "./ConfigDialog";

interface Props {
  getContainer: () => BrowserContainer | undefined;
  onOutput(line: string): void;
  ready: boolean;
}

export default function VibeApp(props: Props) {
  const [config, setConfig] = createSignal<VibeConfig>({
    provider: getStoredProvider(),
    apiKey: getStoredApiKey() ?? "",
    modelId: getStoredModelId(),
  });
  const [configOpen, setConfigOpen] = createSignal(false);

  const chat = createVibeChat({
    getContainer: props.getContainer,
    provider: () => config().provider,
    apiKey: () => config().apiKey || null,
    modelId: () => config().modelId,
    onOutput: (line) => props.onOutput(line),
  });

  const canSend = () => props.ready && (config().provider === "mock" || config().apiKey.length > 0);
  const placeholder = () =>
    !props.ready
      ? "Booting the sandbox…"
      : canSend()
        ? "Describe what to build or change…"
        : "Open Settings to set a provider or an OpenRouter API key…";

  const saveConfig = (next: VibeConfig) => {
    setConfig(next);
    setStoredProvider(next.provider);
    setStoredModelId(next.modelId);
    if (next.apiKey) setStoredApiKey(next.apiKey);
    else clearStoredApiKey();
    setConfigOpen(false);
  };

  const handleExport = async () => {
    const container = props.getContainer();
    if (!container) return;
    const blob = await exportProjectZip(container);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "bolo-vibe-project.zip";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleReset = async () => {
    if (!window.confirm("Delete the saved project from this browser? The page will reload.")) return;
    await deleteProjectSnapshot("default").catch(() => {});
    localStorage.removeItem("bolo-vibe:restore-skipped");
    location.reload();
  };

  return (
    <div class="flex h-full min-h-0 flex-col" data-panel="chat">
      <div class="shrink-0 border-b border-border px-3 py-1.5">
        <p class="text-[11px] leading-snug text-muted" data-testid="key-banner">
          Your API key stays in this browser: it is stored in localStorage and sent only to the
          provider you configure, never to bolo.
        </p>
        <div class="mt-1 flex items-center gap-2 text-[11px]">
          <button
            type="button"
            class="rounded border border-border px-2 py-0.5 text-muted hover:text-fg"
            onClick={() => setConfigOpen(true)}
            data-testid="open-config"
          >
            Settings
          </button>
          <button
            type="button"
            class="rounded border border-border px-2 py-0.5 text-muted hover:text-fg"
            disabled={!props.ready}
            onClick={() => void handleExport()}
          >
            Export zip
          </button>
          <button
            type="button"
            class="rounded border border-border px-2 py-0.5 text-muted hover:text-fg"
            onClick={() => void handleReset()}
          >
            Reset project
          </button>
          <span class="ml-auto font-mono text-muted">
            {config().provider === "mock" ? "mock provider" : config().modelId}
          </span>
        </div>
      </div>
      <div class="min-h-0 flex-1">
        <VibeChat chat={chat} canSend={canSend()} placeholder={placeholder()} />
      </div>
      <Show when={configOpen()}>
        <ConfigDialog
          initial={config()}
          onSave={saveConfig}
          onCancel={() => setConfigOpen(false)}
        />
      </Show>
    </div>
  );
}
