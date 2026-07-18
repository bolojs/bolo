import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export const DEFAULT_MODEL_ID = "tencent/hy3:free";

const API_KEY_STORAGE = "bolo-app-builder:openrouter-api-key";
const PLAN_MODEL_STORAGE = "bolo-app-builder:plan-model-id";
const BUILD_MODEL_STORAGE = "bolo-app-builder:build-model-id";
const SAME_MODEL_STORAGE = "bolo-app-builder:use-same-model";

// BYOK: the key lives only in this tab's localStorage and is sent directly
// from the browser to OpenRouter (no server in this example to proxy or
// hold it). Anyone with page-script access (a browser extension, an XSS in
// this app, or devtools) can read it — do not paste a key you are not
// willing to rotate. See README.md "Security" for the full writeup.
//
// Dev-only fallback: the Vite plugin in `vite.config.ts` (dev mode only)
// injects a `window.__OPENROUTER_DEV_KEY__` from `OPENROUTER_API_KEY` in
// `examples/app-builder/.env`, so agent QA / fresh dev tabs can boot without
// the manual config-dialog paste. localStorage always wins once the user has
// set a key — the dev key is purely a fill-the-blank default.
export function getDevApiKey(): string | null {
  if (typeof window === "undefined") return null;
  const v = (window as unknown as { __OPENROUTER_DEV_KEY__?: unknown }).__OPENROUTER_DEV_KEY__;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function getStoredApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE) ?? getDevApiKey();
}

export function setStoredApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE, key);
}

export function clearStoredApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE);
}

export function getStoredPlanModelId(): string {
  return (
    localStorage.getItem(PLAN_MODEL_STORAGE) ??
    import.meta.env.VITE_OPENROUTER_MODEL_ID ??
    DEFAULT_MODEL_ID
  );
}

export function setStoredPlanModelId(id: string): void {
  localStorage.setItem(PLAN_MODEL_STORAGE, id);
}

export function getStoredBuildModelId(): string {
  return (
    localStorage.getItem(BUILD_MODEL_STORAGE) ??
    import.meta.env.VITE_OPENROUTER_MODEL_ID ??
    DEFAULT_MODEL_ID
  );
}

export function setStoredBuildModelId(id: string): void {
  localStorage.setItem(BUILD_MODEL_STORAGE, id);
}

export function getStoredUseSameModel(): boolean {
  const v = localStorage.getItem(SAME_MODEL_STORAGE);
  return v === null ? true : v === "true";
}

export function setStoredUseSameModel(value: boolean): void {
  localStorage.setItem(SAME_MODEL_STORAGE, String(value));
}

export function getModel(apiKey: string, modelId: string = DEFAULT_MODEL_ID): LanguageModel {
  const openrouter = createOpenRouter({
    apiKey,
    appName: "bolo app-builder example",
  });
  return openrouter.chat(modelId);
}

export interface OpenRouterModel {
  id: string;
  name: string;
}

// OpenRouter's /models endpoint is OpenAI-compatible and public (it works
// without a key), but we pass the key along when we have one anyway.
export async function listOpenRouterModels(apiKey?: string | null): Promise<OpenRouterModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!res.ok) throw new Error(`Failed to list OpenRouter models: ${res.status}`);
  const body = (await res.json()) as { data: Array<{ id: string; name?: string }> };
  return body.data
    .map((m) => ({ id: m.id, name: m.name ?? m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
