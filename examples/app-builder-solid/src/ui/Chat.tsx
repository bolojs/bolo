import { createSignal, For, Show } from "solid-js";
import { ArrowUpRight, SendHorizontal } from "lucide-solid";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { ToolReceiptView } from "./ToolReceiptView";
import type { ChatTurn } from "../ai/useBuilderChat";

const SUGGESTIONS = [
  "Build a todo app with dark mode support",
  "Create a pomodoro timer with start, pause, and reset",
  "Make a markdown note-taking app with a live preview",
  "Build a expense tracker with a running total",
];

/**
 * Solid port of React app-builder Chat.tsx. Drops shadcn Button/Textarea/
 * ScrollArea primitives (slice 6 may add @gc-solid equivalents if needed)
 * in favor of plain HTML elements with the same Tailwind classes — keeps
 * the surface area small for the chat slice. ScrollArea in particular is
 * a 58-LOC Radix wrapper for what `<div class="overflow-y-auto">` does in
 * one attribute, so the ponytail ladder says: native first.
 */
export function Chat(props: {
  turns: ChatTurn[];
  busy: boolean;
  disabled: boolean;
  onSend: (prompt: string) => void;
}) {
  const [input, setInput] = createSignal("");

  const submit = () => {
    const trimmed = input().trim();
    if (!trimmed || props.busy || props.disabled) return;
    setInput("");
    props.onSend(trimmed);
  };

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="p-2">
          <Show when={props.turns.length === 0}>
            <div class="chat-empty">
              <div class="chat-empty__title">What do you want to build?</div>
              <div class="chat-empty__subtitle">
                Describe an app in plain language, or pick a starting point below.
              </div>
              <div class="chat-empty__suggestions">
                <For each={SUGGESTIONS}>
                  {(suggestion, i) => (
                    <button
                      type="button"
                      class="chat-suggestion"
                      style={{ "animation-delay": `${i() * 60}ms` }}
                      disabled={props.disabled}
                      onClick={() => setInput(suggestion)}
                    >
                      <span class="chat-suggestion__text">{suggestion}</span>
                      <span class="chat-suggestion__icon">
                        <ArrowUpRight class="size-3.5" aria-hidden="true" />
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <For each={props.turns}>
            {(turn) => (
              <div class="mb-3">
                <div class="mb-0.5 text-[11px] font-semibold opacity-60">
                  {turn.role === "user" ? "You" : "Assistant"}
                </div>
                <Show when={turn.planText}>
                  <div class="phase-badge">
                    <span class="phase-badge__label">plan</span>
                    <span class="phase-badge__sep">·</span>
                    <span class="phase-badge__model">{turn.planModelId ?? "—"}</span>
                  </div>
                  <div class="mb-1 text-xs italic opacity-70">
                    <StreamingMarkdown text={turn.planText!} />
                  </div>
                </Show>
                <Show when={turn.text || turn.receipts.length > 0}>
                  <div class="phase-badge">
                    <span class="phase-badge__label">build</span>
                    <span class="phase-badge__sep">·</span>
                    <span class="phase-badge__model">{turn.buildModelId ?? "—"}</span>
                  </div>
                  <Show when={turn.text}>
                    <div class="text-[13px]">
                      <StreamingMarkdown text={turn.text} />
                    </div>
                  </Show>
                  <For each={turn.receipts}>{(r) => <ToolReceiptView receipt={r} />}</For>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="flex gap-1.5 border-t border-border p-2">
        <textarea
          value={input()}
          disabled={props.disabled}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={props.disabled ? "Set an OpenRouter API key to start…" : "Describe what to build or change…"}
          rows={2}
          class="min-h-0 flex-1 resize-none rounded-md border border-border bg-transparent px-2 py-1.5 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={props.disabled || props.busy || !input().trim()}
          aria-label="Send"
          class="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <SendHorizontal />
        </button>
      </div>
    </div>
  );
}
