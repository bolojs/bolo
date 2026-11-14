/** @jsxImportSource solid-js */
import { createEffect, createSignal, For, Show } from "solid-js";
import type { VibeChat } from "../ai/chat";
import ToolReceiptView from "./ToolReceiptView";

interface Props {
  chat: VibeChat;
  canSend: boolean;
  placeholder: string;
}

const SUGGESTIONS = [
  "Build a todo app with dark mode support",
  "Create a pomodoro timer with start, pause, and reset",
  "Make a markdown note-taking app with a live preview",
];

export default function VibeChat(props: Props) {
  const [input, setInput] = createSignal("");
  let scrollRef: HTMLDivElement | undefined;

  createEffect(() => {
    // Keep the transcript pinned to the bottom as it streams in.
    props.chat.state.turns;
    props.chat.state.busy;
    queueMicrotask(() => {
      scrollRef?.scrollTo({ top: scrollRef.scrollHeight });
    });
  });

  const submit = () => {
    const trimmed = input().trim();
    if (!trimmed || props.chat.state.busy || !props.canSend) return;
    setInput("");
    void props.chat.send(trimmed);
  };

  return (
    <div class="flex h-full min-h-0 flex-col" data-panel="chat">
      <div ref={scrollRef} class="min-h-0 flex-1 overflow-y-auto p-3">
        <Show
          when={props.chat.state.turns.length > 0}
          fallback={
            <div class="flex flex-col gap-3 pt-8 text-center">
              <p class="text-[14px] font-semibold">What do you want to build?</p>
              <p class="text-[12px] text-muted">
                Describe an app in plain language, or pick a starting point below.
              </p>
              <div class="flex flex-col gap-1.5">
                <For each={SUGGESTIONS}>
                  {(suggestion) => (
                    <button
                      type="button"
                      class="rounded-lg border border-border px-3 py-2 text-left text-[12px] text-muted transition-colors hover:border-[var(--accent)] hover:text-fg"
                      disabled={!props.canSend}
                      onClick={() => setInput(suggestion)}
                    >
                      {suggestion}
                    </button>
                  )}
                </For>
              </div>
            </div>
          }
        >
          <For each={props.chat.state.turns}>
            {(turn) => (
              <div class="mb-3" data-turn={turn.role}>
                <div class="mb-0.5 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  {turn.role === "user" ? "You" : "Assistant"}
                </div>
                <Show when={turn.planText}>
                  <div class="mb-1 rounded-md border border-border bg-[var(--surface-2)] px-2 py-1 text-[12px] italic text-muted">
                    {turn.planText}
                  </div>
                </Show>
                <Show when={turn.text}>
                  <div class="whitespace-pre-wrap text-[13px] leading-relaxed">{turn.text}</div>
                </Show>
                <For each={turn.receipts}>{(receipt) => <ToolReceiptView receipt={receipt} />}</For>
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="flex shrink-0 gap-1.5 border-t border-border p-2">
        <textarea
          class="min-h-0 flex-1 resize-none rounded-md border border-border bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]"
          rows={2}
          value={input()}
          disabled={!props.canSend}
          placeholder={props.placeholder}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          class="shrink-0 self-end rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
          disabled={!props.canSend || props.chat.state.busy || !input().trim()}
          onClick={submit}
          aria-label="Send"
        >
          Send
        </button>
      </div>
    </div>
  );
}
