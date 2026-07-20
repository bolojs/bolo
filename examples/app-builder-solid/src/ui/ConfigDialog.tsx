import { Eye, EyeOff } from "lucide-solid";
import { createEffect, createSignal, For, Show, onCleanup, type Component } from "solid-js";
import { listOpenRouterModels, type OpenRouterModel } from "../ai/providers";

export interface BuilderConfig {
  apiKey: string;
  planModelId: string;
  buildModelId: string;
  useSameModel: boolean;
}

interface Props {
  open: boolean;
  initial: BuilderConfig;
  onSave(config: BuilderConfig): void;
  onCancel?(): void;
  onForgetApiKey?(): void;
}

// ponytail: native HTML <dialog> element over Kobalte/@gc-solid.
// show()/close() + ::backdrop + ESC (cancel event) + inert background
// are all built-in. Cancels close the dialog only if onCancel was supplied
// (mirrors React version's onEscapeKeyDown behavior).
const ConfigDialog: Component<Props> = (props) => {
  const [apiKey, setApiKey] = createSignal(props.initial.apiKey);
  const [planModelId, setPlanModelId] = createSignal(props.initial.planModelId);
  const [buildModelId, setBuildModelId] = createSignal(props.initial.buildModelId);
  const [useSameModel, setUseSameModel] = createSignal(props.initial.useSameModel);
  const [showApiKey, setShowApiKey] = createSignal(false);
  const [models, setModels] = createSignal<OpenRouterModel[] | null>(null);
  const [modelsError, setModelsError] = createSignal<string | null>(null);

  // Sync local state from `initial` each time the dialog opens.
  // In Solid this is a single createEffect — no `cancelled` flag, no
  // `eslint-disable react-hooks/exhaustive-deps` like React needs.
  let lastOpen = false;
  createEffect(() => {
    const open = props.open;
    if (open && !lastOpen) {
      setApiKey(props.initial.apiKey);
      setPlanModelId(props.initial.planModelId);
      setBuildModelId(props.initial.buildModelId);
      setUseSameModel(props.initial.useSameModel);
    }
    lastOpen = open;
  });

  // Debounced model list fetch on apiKey change while open.
  createEffect(() => {
    const open = props.open;
    const key = apiKey();
    if (!open) return;
    const handle = setTimeout(() => {
      listOpenRouterModels(key || null)
        .then((list) => {
          setModels(list);
          setModelsError(null);
        })
        .catch((err) => setModelsError(err instanceof Error ? err.message : String(err)));
    }, 400);
    onCleanup(() => clearTimeout(handle));
  });

  const canSave = () =>
    apiKey().trim().length > 0 &&
    planModelId().trim().length > 0 &&
    (useSameModel() || buildModelId().trim().length > 0);

  const submit = () => {
    if (!canSave()) return;
    props.onSave({
      apiKey: apiKey().trim(),
      planModelId: planModelId().trim(),
      buildModelId: useSameModel() ? planModelId().trim() : buildModelId().trim(),
      useSameModel: useSameModel(),
    });
  };

  let ref: HTMLDialogElement | undefined;
  // Wire the open prop to <dialog>.showModal() / .close().
  createEffect(() => {
    if (!ref) return;
    if (props.open && !ref.open) ref.showModal();
    else if (!props.open && ref.open) ref.close();
  });

  return (
    <Show when={props.open}>
      <dialog
        ref={ref}
        class="backdrop:bg-black/50 open:animate-in open:fade-in-0 open:zoom-in-95 rounded-lg border border-border bg-background p-6 shadow-lg max-w-lg w-full"
        onClose={() => props.onCancel?.()}
        onCancel={(e) => {
          if (!props.onCancel) e.preventDefault();
        }}
      >
        <header class="mb-4 flex flex-col gap-1.5">
          <h2 class="text-lg font-semibold text-foreground">Configure OpenRouter</h2>
          <p class="text-sm text-muted-foreground">
            Your key is sent directly from this browser to OpenRouter and stored only in this tab's
            localStorage — see README.md "Security" for details. Get a key at{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              class="underline underline-offset-2"
            >
              openrouter.ai/keys
            </a>
            .
          </p>
        </header>

        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <label for="cfg-api-key" class="text-sm font-medium text-foreground">
              API key
            </label>
            <div class="relative">
              <input
                id="cfg-api-key"
                type={showApiKey() ? "text" : "password"}
                class="h-9 w-full rounded-md border border-input bg-transparent px-3 pr-9 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={apiKey()}
                onInput={(e) => setApiKey(e.currentTarget.value)}
                placeholder="sk-or-..."
                autocomplete="off"
                spellcheck={false}
              />
              <button
                type="button"
                class="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setShowApiKey((v) => !v)}
                title={showApiKey() ? "Hide API key" : "Show API key"}
                aria-label={showApiKey() ? "Hide API key" : "Show API key"}
              >
                <Show when={showApiKey()} fallback={<Eye class="size-4" />}>
                  <EyeOff class="size-4" />
                </Show>
              </button>
            </div>
          </div>

          <label class="flex items-center gap-2 text-sm font-normal text-foreground">
            <input
              type="checkbox"
              class="size-4 rounded border border-input"
              checked={useSameModel()}
              onChange={(e) => setUseSameModel(e.currentTarget.checked)}
            />
            Use the same model for planning and building
          </label>

          <div class="flex flex-col gap-1.5">
            <label for="cfg-plan-model" class="text-sm font-medium text-foreground">
              {useSameModel() ? "Model" : "Plan model"}
            </label>
            <input
              id="cfg-plan-model"
              list="app-builder-model-options"
              class="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={planModelId()}
              onInput={(e) => setPlanModelId(e.currentTarget.value)}
              placeholder="tencent/hy3:free"
              spellcheck={false}
            />
          </div>

          <Show when={!useSameModel()}>
            <div class="flex flex-col gap-1.5">
              <label for="cfg-build-model" class="text-sm font-medium text-foreground">
                Build model
              </label>
              <input
                id="cfg-build-model"
                list="app-builder-model-options"
                class="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={buildModelId()}
                onInput={(e) => setBuildModelId(e.currentTarget.value)}
                placeholder="tencent/hy3:free"
                spellcheck={false}
              />
            </div>
          </Show>

          <datalist id="app-builder-model-options">
            <For each={models() ?? []}>
              {(m) => <option value={m.id}>{m.name}</option>}
            </For>
          </datalist>

          <p class="text-xs text-muted-foreground" aria-live="polite">
            <Show when={modelsError()}>
              <span class="text-destructive">Couldn't load model list: {modelsError()}</span>
            </Show>
            <Show when={!models() && !modelsError()}>
              <span>Loading model list…</span>
            </Show>
            <Show when={models() && (models() ?? []).length > 0 && !modelsError()}>
              <span>{(models() ?? []).length} models available</span>
            </Show>
          </p>

          <footer class="flex flex-row justify-end gap-2 pt-2">
            <Show when={props.onForgetApiKey}>
              <button
                type="button"
                class="mr-auto inline-flex h-9 items-center justify-center rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
                onClick={() => props.onForgetApiKey?.()}
              >
                Forget API key
              </button>
            </Show>
            <Show when={props.onCancel}>
              <button
                type="button"
                class="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => props.onCancel?.()}
              >
                Cancel
              </button>
            </Show>
            <button
              type="button"
              class="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
              onClick={submit}
              disabled={!canSave()}
            >
              Save
            </button>
          </footer>
        </div>
      </dialog>
    </Show>
  );
};

export default ConfigDialog;
