import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import type { BrowserContainer } from "@bolojs/runtime";
import { createContainerTools } from "../container/tools";
import { getModel } from "./providers";

const PLAN_SYSTEM_PROMPT = `You are the planning step of an AI app builder. Given the user's
request and the conversation so far, write a short (2-5 bullet) plan of the concrete changes
you will make — files to write/edit, commands to run, in what order. Do not write file
contents or run anything; that happens in the next step. Keep it brief.`;

const BUILD_SYSTEM_PROMPT = `You are the build step of an AI app builder running inside a live
in-browser sandbox. A short plan for this turn appears earlier in the conversation —
execute it using tools (adapting if reality, e.g. file contents or command output, differs).
You can read/write files and run shell commands via tools — changes take effect immediately
in the user's live preview.

Available commands: "node", "bun", "npm" (including "npm install", "npm run dev"), plus
"runtime", "agent", "curl", "nc", "tcping". Everything else runs through a JS-only bash
clone (no real OS) — there is no "python"/"pip", "cargo", or "go"; don't attempt to use them.
The live preview only populates once "npm run dev" is running (the scaffold is a Vite project).

Guidelines:
- Prefer small, incremental edits over rewriting the whole project.
- After changing dependencies in package.json, run "npm install" before "npm run dev".
- The dev server, once started, hot-reloads on file writes — do not restart it for
  ordinary file edits, only when dependencies change.
- Keep responses brief; let the file/command tool calls speak for the change.`;

export interface ToolReceipt {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status: "running" | "done" | "error";
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  planText?: string;
  receipts: ToolReceipt[];
  /** Snapshot of which model produced the plan / build for this turn. */
  planModelId?: string;
  buildModelId?: string;
}

/**
 * Solid replacement for React's useBuilderChat hook. Accepts signal
 * accessors (factory functions) for reactive inputs so the chat always
 * reads the current value at call time — no stale closures, no
 * `useCallback` dep array, no `eslint-disable react-hooks/exhaustive-deps`.
 *
 * Streaming updates use `createStore` + `produce` for in-place mutation
 * of the last assistant turn, which is the Solid idiom for streaming
 * array+object state. Each text-delta / tool-event batch becomes a
 * single reactive commit without the React pattern of "spread prev, push
 * new last element".
 */
export function createBuilderChat(
  container: () => BrowserContainer | null,
  apiKey: () => string | null,
  planModelId: () => string,
  buildModelId: () => string,
  onOutput?: (line: string) => void,
) {
  const [turns, setTurns] = createStore<ChatTurn[]>([]);
  const [history, setHistory] = createSignal<ModelMessage[]>([]);
  const [busy, setBusy] = createSignal(false);

  const send = async (prompt: string) => {
    const c = container();
    const key = apiKey();
    if (!c || !key || busy()) return;
    setBusy(true);
    setTurns(
      produce((arr) => {
        arr.push({ role: "user", text: prompt, receipts: [] });
        arr.push({
          role: "assistant",
          text: "",
          planText: "",
          receipts: [],
          planModelId: planModelId(),
          buildModelId: buildModelId(),
        });
      }),
    );

    try {
      const baseMessages: ModelMessage[] = [...history(), { role: "user", content: prompt }];

      // Plan phase: reasoning only, no tools — produces a short plan the
      // build phase below is seeded with as conversation context.
      const planResult = streamText({
        model: getModel(key, planModelId()),
        system: PLAN_SYSTEM_PROMPT,
        messages: baseMessages,
      });

      for await (const part of planResult.fullStream) {
        if (part.type === "text-delta") {
          setTurns(
            produce((arr) => {
              const last = arr[arr.length - 1]!;
              last.planText = (last.planText ?? "") + part.text;
            }),
          );
        }
      }
      const planMessages = await planResult.responseMessages;

      // Build phase: executes the plan against the container via tools.
      const buildResult = streamText({
        model: getModel(key, buildModelId()),
        system: BUILD_SYSTEM_PROMPT,
        messages: [...baseMessages, ...planMessages],
        tools: createContainerTools(c, onOutput),
        stopWhen: stepCountIs(8),
      });

      for await (const part of buildResult.fullStream) {
        if (part.type === "text-delta") {
          setTurns(
            produce((arr) => {
              const last = arr[arr.length - 1]!;
              last.text += part.text;
            }),
          );
        } else if (part.type === "tool-call") {
          setTurns(
            produce((arr) => {
              const last = arr[arr.length - 1]!;
              last.receipts.push({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                status: "running",
              });
            }),
          );
        } else if (part.type === "tool-result") {
          setTurns(
            produce((arr) => {
              const last = arr[arr.length - 1]!;
              const r = last.receipts.find((x) => x.toolCallId === part.toolCallId);
              if (r) {
                r.output = part.output;
                r.status = "done";
              }
            }),
          );
        } else if (part.type === "tool-error") {
          setTurns(
            produce((arr) => {
              const last = arr[arr.length - 1]!;
              const r = last.receipts.find((x) => x.toolCallId === part.toolCallId);
              if (r) {
                r.output = part.error;
                r.status = "error";
              }
            }),
          );
        }
      }

      const buildMessages = await buildResult.responseMessages;
      setHistory((prev) => [...prev, { role: "user", content: prompt }, ...planMessages, ...buildMessages]);
    } catch (err) {
      setTurns(
        produce((arr) => {
          const last = arr[arr.length - 1]!;
          if (!last.text) {
            last.text = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return { turns, busy, send };
}
