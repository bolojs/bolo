import { useState } from "react";
import { ArrowUpRight, SendHorizontal } from "lucide-react";
import { Streamdown } from "streamdown";
import type { ChatTurn } from "../ai/useBuilderChat";
import ToolReceiptView from "./ToolReceiptView";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  turns: ChatTurn[];
  busy: boolean;
  disabled: boolean;
  onSend(prompt: string): void;
}

const SUGGESTIONS = [
  "Build a todo app with dark mode support",
  "Create a pomodoro timer with start, pause, and reset",
  "Make a markdown note-taking app with a live preview",
  "Build a expense tracker with a running total",
];

export default function Chat({ turns, busy, disabled, onSend }: Props) {
  const [input, setInput] = useState("");

  const submit = () => {
    const trimmed = input.trim();
    if (!trimmed || busy || disabled) return;
    setInput("");
    onSend(trimmed);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {turns.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty__title">What do you want to build?</div>
              <div className="chat-empty__subtitle">
                Describe an app in plain language, or pick a starting point below.
              </div>
              <div className="chat-empty__suggestions">
                {SUGGESTIONS.map((suggestion, i) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="chat-suggestion"
                    style={{ animationDelay: `${i * 60}ms` }}
                    disabled={disabled}
                    onClick={() => setInput(suggestion)}
                  >
                    <span className="chat-suggestion__text">{suggestion}</span>
                    <span className="chat-suggestion__icon">
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn, i) => (
            <div key={i} className="mb-3">
              <div className="mb-0.5 text-[11px] font-semibold opacity-60">
                {turn.role === "user" ? "You" : "Assistant"}
              </div>
              {turn.planText && (
                <>
                  <div className="phase-badge">
                    <span className="phase-badge__label">plan</span>
                    <span className="phase-badge__sep">·</span>
                    <span className="phase-badge__model">{turn.planModelId ?? "—"}</span>
                  </div>
                  <div className="mb-1 text-xs italic opacity-70">
                    <Streamdown>{turn.planText}</Streamdown>
                  </div>
                </>
              )}
              {(turn.text || turn.receipts.length > 0) && (
                <>
                  <div className="phase-badge">
                    <span className="phase-badge__label">build</span>
                    <span className="phase-badge__sep">·</span>
                    <span className="phase-badge__model">{turn.buildModelId ?? "—"}</span>
                  </div>
                  {turn.text && (
                    <div className="text-[13px]">
                      <Streamdown>{turn.text}</Streamdown>
                    </div>
                  )}
                  {turn.receipts.map((r) => (
                    <ToolReceiptView key={r.toolCallId} receipt={r} />
                  ))}
                </>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="flex gap-1.5 border-t border-border p-2">
        <Textarea
          value={input}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "Set an OpenRouter API key to start…" : "Describe what to build or change…"}
          rows={2}
          className="min-h-0 resize-none text-[13px]"
        />
        <Button type="button" size="icon" onClick={submit} disabled={disabled || busy || !input.trim()} aria-label="Send">
          <SendHorizontal />
        </Button>
      </div>
    </div>
  );
}
