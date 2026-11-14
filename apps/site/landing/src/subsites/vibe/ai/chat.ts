import { createStore, produce } from "solid-js/store";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import type { BrowserContainer } from "@bolojs/runtime";
import { createContainerTools } from "./tools";
import { getModel, type VibeProviderId } from "./providers";
import { saveProjectSnapshot } from "../persist";

const PLAN_SYSTEM_PROMPT = `You are the planning step of an AI app builder. Given the user's
request and the conversation so far, write a short (2-5 bullet) plan of the concrete changes
you will make — files to write/edit, commands to run, in what order. Do not write file
contents or run anything; that happens in the next step. Keep it brief.`;

const BUILD_SYSTEM_PROMPT = `You are the build step of an AI app builder running inside a live
in-browser sandbox. A short plan for this turn appears earlier in the conversation —
execute it using tools (adapting if reality, e.g. file contents or command output, differs).
You can read/write files and run shell commands via tools — changes take effect immediately
in the user's live preview.

Available commands: "node", "npm" (including "npm install", "npm run dev"), "npx", "git".
Everything else is rejected by the allowlist. There is no "python"/"pip", "cargo", or "go";
don't attempt to use them. The live preview only populates once "npm run dev" is running
(the scaffold is a Vite project).

Guidelines:
- Never ask the user for secrets, tokens, or credentials; nothing in this project needs them.
- Prefer small, incremental edits over rewriting the whole project.
- After changing dependencies in package.json, run "npm install" before "npm run dev".
- The dev server, once started, reloads on file writes — do not restart it for
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
  modelId?: string;
}

export interface VibeChatState {
  turns: ChatTurn[];
  busy: boolean;
}

export interface VibeChatOptions {
  getContainer: () => BrowserContainer | undefined;
  provider: () => VibeProviderId;
  apiKey: () => string | null;
  modelId: () => string;
  onOutput?: (line: string) => void;
  onDevServer?: () => void;
  onTurnComplete?: () => void;
}

/**
 * Framework-agnostic chat controller (Solid store underneath) driving the
 * two-phase plan/build loop ported from examples/app-builder, hardened for
 * the subsite: allowlisted tools, container scoping, snapshot persistence
 * after every completed turn.
 */
export function createVibeChat(options: VibeChatOptions) {
  const [state, setState] = createStore<VibeChatState>({ turns: [], busy: false });
  let history: ModelMessage[] = [];

  const mutateLastTurn = (mutate: (turn: ChatTurn) => ChatTurn) => {
    setState(
      produce((s) => {
        const last = s.turns[s.turns.length - 1];
        if (last && last.role === "assistant") s.turns[s.turns.length - 1] = mutate(last);
      }),
    );
  };

  const send = async (prompt: string): Promise<void> => {
    const container = options.getContainer();
    const apiKey = options.apiKey();
    const provider = options.provider();
    const modelId = options.modelId();
    if (!container || state.busy) return;
    if (provider !== "mock" && !apiKey) return;

    setState(
      produce((s) => {
        s.busy = true;
        s.turns.push({ role: "user", text: prompt, receipts: [] });
        s.turns.push({ role: "assistant", text: "", receipts: [], modelId });
      }),
    );

    try {
      const baseMessages: ModelMessage[] = [...history, { role: "user", content: prompt }];

      // Plan phase: reasoning only, no tools — its output seeds the build.
      const planResult = streamText({
        model: getModel(provider, apiKey ?? "", modelId),
        system: PLAN_SYSTEM_PROMPT,
        messages: baseMessages,
      });
      for await (const part of planResult.fullStream) {
        if (part.type === "text-delta") {
          mutateLastTurn((turn) => ({ ...turn, planText: (turn.planText ?? "") + part.text }));
        }
      }
      const planMessages = await planResult.responseMessages;

      // Build phase: executes the plan against the container via tools.
      const buildResult = streamText({
        model: getModel(provider, apiKey ?? "", modelId),
        system: BUILD_SYSTEM_PROMPT,
        messages: [...baseMessages, ...planMessages],
        tools: createContainerTools(container, options.onOutput, options.onDevServer),
        stopWhen: stepCountIs(8),
      });
      for await (const part of buildResult.fullStream) {
        if (part.type === "text-delta") {
          mutateLastTurn((turn) => ({ ...turn, text: turn.text + part.text }));
        } else if (part.type === "tool-call") {
          mutateLastTurn((turn) => ({
            ...turn,
            receipts: [
              ...turn.receipts,
              { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input, status: "running" },
            ],
          }));
        } else if (part.type === "tool-result") {
          mutateLastTurn((turn) => ({
            ...turn,
            receipts: turn.receipts.map((r) =>
              r.toolCallId === part.toolCallId ? { ...r, output: part.output, status: "done" } : r,
            ),
          }));
        } else if (part.type === "tool-error") {
          mutateLastTurn((turn) => ({
            ...turn,
            receipts: turn.receipts.map((r) =>
              r.toolCallId === part.toolCallId ? { ...r, output: part.error, status: "error" } : r,
            ),
          }));
        }
      }

      const buildMessages = await buildResult.responseMessages;
      history = [...history, { role: "user", content: prompt }, ...planMessages, ...buildMessages];
      await saveProjectSnapshot("default").catch(() => {});
      options.onTurnComplete?.();
    } catch (err) {
      mutateLastTurn((turn) => ({
        ...turn,
        text: turn.text || `Error: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setState("busy", false);
    }
  };

  const reset = () => {
    history = [];
    setState({ turns: [], busy: false });
  };

  return { state, send, reset };
}

export type VibeChat = ReturnType<typeof createVibeChat>;
