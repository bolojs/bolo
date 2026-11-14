import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { LanguageModelV2, LanguageModelV2StreamPart } from "@ai-sdk/provider";

export const DEFAULT_MODEL_ID = "tencent/hy3:free";
export const MOCK_MODEL_ID = "bolo/mock-vibe";

export type VibeProviderId = "openrouter" | "mock";

const API_KEY_STORAGE = "bolo-vibe:openrouter-api-key";
const PROVIDER_STORAGE = "bolo-vibe:provider";
const MODEL_STORAGE = "bolo-vibe:model-id";

// BYOK: the key lives only in this tab's localStorage and is sent directly
// from the browser to OpenRouter. It never touches bolo infrastructure.
export function getStoredApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE);
}

export function setStoredApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE, key);
}

export function clearStoredApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE);
}

export function getStoredProvider(): VibeProviderId {
  const v = localStorage.getItem(PROVIDER_STORAGE);
  return v === "mock" ? "mock" : "openrouter";
}

export function setStoredProvider(provider: VibeProviderId): void {
  localStorage.setItem(PROVIDER_STORAGE, provider);
}

export function getStoredModelId(): string {
  return localStorage.getItem(MODEL_STORAGE) ?? DEFAULT_MODEL_ID;
}

export function setStoredModelId(id: string): void {
  localStorage.setItem(MODEL_STORAGE, id);
}

export function getModel(
  provider: VibeProviderId,
  apiKey: string,
  modelId: string = DEFAULT_MODEL_ID,
): LanguageModel {
  if (provider === "mock") return createMockVibeModel();
  const openrouter = createOpenRouter({
    apiKey,
    appName: "bolo vibe subsite",
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
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  });
  if (!res.ok) throw new Error(`Failed to list OpenRouter models: ${res.status}`);
  const body = (await res.json()) as { data: Array<{ id: string; name?: string }> };
  return body.data
    .map((m) => ({ id: m.id, name: m.name ?? m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// The marker the mock build step writes into src/App.jsx. E2E asserts on it.
export const MOCK_MARKER = "Built by the bolo mock provider";

const MOCK_APP_JSX = `export default function App() {
  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>${MOCK_MARKER}</h1>
      <p>The mock provider wrote this file and started the dev server.</p>
    </div>
  );
}
`;

const MOCK_PLAN_TEXT =
  "Plan:\n- Write src/App.jsx with a branded hello component\n- Start the dev server with npm run dev\n";

const MOCK_BUILD_TEXT = "Wrote src/App.jsx and started the dev server. Preview should update shortly.";

function chunkDeltas(text: string): string[] {
  return text.match(/.{1,24}/gs) ?? [text];
}

/**
 * Deterministic in-browser model used when the provider is set to "mock"
 * (via the config dialog or localStorage). Plan calls (no tools offered)
 * stream a canned plan; build calls stream a writeFile of src/App.jsx
 * followed by `npm run dev`, then a short summary. This keeps e2e free of
 * network access and credentials.
 */
export function createMockVibeModel(): LanguageModelV2 {
  let buildCalls = 0;
  const streamScript = (parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> => {
    let index = 0;
    return new ReadableStream<LanguageModelV2StreamPart>({
      async pull(controller) {
        // Small delays make streaming observable in the UI and deterministic
        // enough for tests (well under any UI wait timeout).
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (index >= parts.length) {
          controller.close();
          return;
        }
        const part = parts[index++];
        if (part) controller.enqueue(part);
      },
    });
  };
  const finish = (text: string): LanguageModelV2StreamPart[] => {
    const usage = { inputTokens: 0, outputTokens: Math.ceil(text.length / 4), totalTokens: Math.ceil(text.length / 4) };
    return [{ type: "finish", finishReason: "stop", usage }];
  };
  return {
    specificationVersion: "v2",
    provider: "bolo",
    modelId: MOCK_MODEL_ID,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("The bolo mock provider only supports streaming.");
    },
    async doStream(options) {
      void options;
      const hasTools = (options.tools?.length ?? 0) > 0;
      const afterTools = options.prompt[options.prompt.length - 1]?.role === "tool";
      const parts: LanguageModelV2StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (!hasTools) {
        parts.push({ type: "text-start", id: "plan-text" });
        for (const delta of chunkDeltas(MOCK_PLAN_TEXT)) {
          parts.push({ type: "text-delta", id: "plan-text", delta });
        }
        parts.push({ type: "text-end", id: "plan-text" });
        parts.push(...finish(MOCK_PLAN_TEXT));
      } else if (afterTools) {
        parts.push({ type: "text-start", id: "build-text" });
        for (const delta of chunkDeltas(MOCK_BUILD_TEXT)) {
          parts.push({ type: "text-delta", id: "build-text", delta });
        }
        parts.push({ type: "text-end", id: "build-text" });
        parts.push(...finish(MOCK_BUILD_TEXT));
      } else {
        buildCalls += 1;
        parts.push({
          type: "tool-call",
          toolCallId: `mock-write-${buildCalls}`,
          toolName: "writeFile",
          input: JSON.stringify({ path: "src/App.jsx", contents: MOCK_APP_JSX }),
        });
        parts.push({
          type: "tool-call",
          toolCallId: `mock-dev-${buildCalls}`,
          toolName: "runCommand",
          input: JSON.stringify({ command: "npm", args: ["run", "dev"] }),
        });
        parts.push({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
      }
      return { stream: streamScript(parts) };
    },
  };
}
