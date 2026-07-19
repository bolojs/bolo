import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { listOpenRouterModels, type OpenRouterModel } from "../ai/providers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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

export default function ConfigDialog({ open, initial, onSave, onCancel, onForgetApiKey }: Props) {
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [planModelId, setPlanModelId] = useState(initial.planModelId);
  const [buildModelId, setBuildModelId] = useState(initial.buildModelId);
  const [useSameModel, setUseSameModel] = useState(initial.useSameModel);
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setApiKey(initial.apiKey);
    setPlanModelId(initial.planModelId);
    setBuildModelId(initial.buildModelId);
    setUseSameModel(initial.useSameModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      listOpenRouterModels(apiKey || null)
        .then((list) => {
          setModels(list);
          setModelsError(null);
        })
        .catch((err) => setModelsError(err instanceof Error ? err.message : String(err)));
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [open, apiKey]);

  const canSave = apiKey.trim().length > 0 && planModelId.trim().length > 0 && (useSameModel || buildModelId.trim().length > 0);

  const submit = () => {
    if (!canSave) return;
    onSave({
      apiKey: apiKey.trim(),
      planModelId: planModelId.trim(),
      buildModelId: useSameModel ? planModelId.trim() : buildModelId.trim(),
      useSameModel,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel?.()}>
      <DialogContent showCloseButton={Boolean(onCancel)} onEscapeKeyDown={(e) => !onCancel && e.preventDefault()} onPointerDownOutside={(e) => !onCancel && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Configure OpenRouter</DialogTitle>
          <DialogDescription>
            Your key is sent directly from this browser to OpenRouter and stored only in this tab's
            localStorage — see README.md "Security" for details. Get a key at{" "}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="underline">
              openrouter.ai/keys
            </a>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cfg-api-key">API key</Label>
          <div className="relative">
            <Input
              id="cfg-api-key"
              type={showApiKey ? "text" : "password"}
              className="pr-8 font-mono"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-or-..."
              autoComplete="off"
              spellCheck={false}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => setShowApiKey((prev) => !prev)}
                  aria-label={showApiKey ? "Hide API key" : "Show API key"}
                >
                  {showApiKey ? <EyeOff /> : <Eye />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showApiKey ? "Hide API key" : "Show API key"}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <Label className="flex items-center gap-2 font-normal">
          <Checkbox checked={useSameModel} onCheckedChange={(checked) => setUseSameModel(checked === true)} />
          Use the same model for planning and building
        </Label>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cfg-plan-model">{useSameModel ? "Model" : "Plan model"}</Label>
          <Input
            id="cfg-plan-model"
            list="app-builder-model-options"
            className="font-mono"
            value={planModelId}
            onChange={(e) => setPlanModelId(e.target.value)}
            placeholder="tencent/hy3:free"
            spellCheck={false}
          />
        </div>

        {!useSameModel && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfg-build-model">Build model</Label>
            <Input
              id="cfg-build-model"
              list="app-builder-model-options"
              className="font-mono"
              value={buildModelId}
              onChange={(e) => setBuildModelId(e.target.value)}
              placeholder="tencent/hy3:free"
              spellCheck={false}
            />
          </div>
        )}

        <datalist id="app-builder-model-options">
          {models?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>

        <p className="text-xs text-muted-foreground" aria-live="polite">
          {modelsError && <span className="text-destructive">Couldn't load model list: {modelsError}</span>}
          {!models && !modelsError && <span>Loading model list…</span>}
          {models && models.length > 0 && <span>{models.length} models available</span>}
        </p>

        <DialogFooter>
          {onForgetApiKey && (
            <Button type="button" variant="destructive" onClick={onForgetApiKey} className="sm:mr-auto">
              Forget API key
            </Button>
          )}
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="button" onClick={submit} disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
