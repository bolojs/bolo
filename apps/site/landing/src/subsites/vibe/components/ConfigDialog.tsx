/** @jsxImportSource solid-js */
import { createSignal, For, Show } from "solid-js";
import { listOpenRouterModels, type OpenRouterModel, type VibeProviderId } from "../ai/providers";

export interface VibeConfig {
  provider: VibeProviderId;
  apiKey: string;
  modelId: string;
}

interface Props {
  initial: VibeConfig;
  onSave(config: VibeConfig): void;
  onCancel(): void;
}

export default function ConfigDialog(props: Props) {
  const [provider, setProvider] = createSignal<VibeProviderId>(props.initial.provider);
  const [apiKey, setApiKey] = createSignal(props.initial.apiKey);
  const [modelId, setModelId] = createSignal(props.initial.modelId);
  const [showApiKey, setShowApiKey] = createSignal(false);
  const [models, setModels] = createSignal<OpenRouterModel[] | null>(null);
  const [modelsError, setModelsError] = createSignal<string | null>(null);

  const loadModels = async (key: string) => {
    setModels(null);
    setModelsError(null);
    try {
      setModels(await listOpenRouterModels(key || null));
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : String(err));
    }
  };

  const isMock = () => provider() === "mock";
  const canSave = () =>
    isMock() || (apiKey().trim().length > 0 && modelId().trim().length > 0);

  const submit = () => {
    if (!canSave()) return;
    props.onSave({
      provider: provider(),
      apiKey: apiKey().trim(),
      modelId: modelId().trim() || "tencent/hy3:free",
    });
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Configure AI provider"
      data-testid="vibe-config-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div class="flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-[var(--surface-2)] p-4 shadow-lg">
        <div>
          <h2 class="text-[15px] font-semibold">Configure AI provider</h2>
          <p class="mt-1 text-[12px] text-muted">
            Your key is sent directly from this browser to the provider and stored only in this
            tab's localStorage. Get an OpenRouter key at{" "}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" class="underline">
              openrouter.ai/keys
            </a>
            . It never touches bolo infrastructure.
          </p>
        </div>

        <label class="flex flex-col gap-1 text-[12px] font-medium">
          Provider
          <select
            id="vibe-provider"
            class="rounded-md border border-border bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--accent)]"
            value={provider()}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setProvider(value === "mock" ? "mock" : "openrouter");
              if (value === "openrouter") void loadModels(apiKey());
            }}
          >
            <option value="openrouter">OpenRouter (bring your own key)</option>
            <option value="mock">Mock (deterministic, no network)</option>
          </select>
        </label>

        <Show when={!isMock()}>
          <label class="flex flex-col gap-1 text-[12px] font-medium">
            API key
            <div class="relative">
              <input
                id="vibe-api-key"
                type={showApiKey() ? "text" : "password"}
                class="w-full rounded-md border border-border bg-transparent px-2 py-1.5 pr-16 font-mono text-[12px] outline-none focus:border-[var(--accent)]"
                value={apiKey()}
                placeholder="sk-or-..."
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => setApiKey(e.currentTarget.value)}
              />
              <button
                type="button"
                class="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-fg"
                onClick={() => setShowApiKey((prev) => !prev)}
                aria-label={showApiKey() ? "Hide API key" : "Show API key"}
              >
                {showApiKey() ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <label class="flex flex-col gap-1 text-[12px] font-medium">
            Model
            <input
              id="vibe-model"
              list="vibe-model-options"
              class="rounded-md border border-border bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--accent)]"
              value={modelId()}
              placeholder="tencent/hy3:free"
              spellcheck={false}
              onInput={(e) => setModelId(e.currentTarget.value)}
            />
          </label>

          <datalist id="vibe-model-options">
            <For each={models() ?? []}>{(m) => <option value={m.id}>{m.name}</option>}</For>
          </datalist>

          <p class="text-[11px] text-muted" aria-live="polite">
            <Show when={modelsError()}>
              <span class="text-[var(--danger)]">Couldn't load model list: {modelsError()}</span>
            </Show>
            <Show when={!models() && !modelsError()}>Loading model list…</Show>
            <Show when={models() && models()!.length > 0}>{models()!.length} models available</Show>
          </p>
        </Show>

        <Show when={isMock()}>
          <p class="rounded-md border border-border bg-[var(--surface-1)] px-2 py-1.5 text-[11px] text-muted">
            The mock provider replays a fixed script (write src/App.jsx, run npm run dev) with no
            network access. Used by the automated e2e suite.
          </p>
        </Show>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-[12px] text-muted hover:text-fg"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
            disabled={!canSave()}
            onClick={submit}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
