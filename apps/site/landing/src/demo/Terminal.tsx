/** @jsxImportSource solid-js */
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  lines: string[];
  disabled: boolean;
  onSubmit(commandLine: string): void;
  inputValue?: string;
  focusTrigger?: number;
}

export default function Terminal(props: Props) {
  let container!: HTMLDivElement;
  let inputRef!: HTMLInputElement;
  let xterm: XTerm | undefined;
  let fitAddon: FitAddon | undefined;

  const [value, setValue] = createSignal("");
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);

  onMount(() => {
    const style = getComputedStyle(container);
    const bg = style.getPropertyValue("--surface-2").trim() || "#0a0a0a";
    const fg = style.getPropertyValue("--fg").trim();
    const accent = style.getPropertyValue("--accent").trim();
    const muted = style.getPropertyValue("--muted").trim();
    const danger = style.getPropertyValue("--danger").trim();
    const success = style.getPropertyValue("--success").trim();
    const accentDim = style.getPropertyValue("--accent-dim").trim();

    xterm = new XTerm({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      theme: {
        background: bg,
        foreground: fg,
        cursor: accent,
        selectionBackground: accentDim,
        black: bg,
        brightBlack: muted,
        red: danger,
        brightRed: danger,
        green: success,
        brightGreen: success,
        yellow: "#e3b341",
        brightYellow: "#e3b341",
        blue: accent,
        brightBlue: accent,
        magenta: "#bc8cff",
        brightMagenta: "#d2a8ff",
        cyan: "#39c5cf",
        brightCyan: "#56d4dd",
        white: fg,
        brightWhite: fg,
      },
    });

    fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    fitAddon.fit();

    let written = 0;
    createEffect(() => {
      const lines = props.lines;
      if (lines.length < written) {
        xterm?.clear();
        written = 0;
        setHistory([]);
        setHistoryIndex(null);
        setValue("");
      }
      for (let i = written; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined) xterm?.write(line);
      }
      written = lines.length;
    });

    createEffect(() => {
      const v = props.inputValue;
      if (v !== undefined) setValue(v);
    });

    createEffect(() => {
      // Trigger focus whenever the parent asks us to (e.g. chip click).
      props.focusTrigger;
      queueMicrotask(() => {
        inputRef?.focus();
      });
    });

    const ro = new ResizeObserver(() => fitAddon?.fit());
    ro.observe(container);

    onCleanup(() => {
      xterm?.dispose();
      ro.disconnect();
    });
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      const line = value().trim();
      if (!line) return;
      props.onSubmit(line);
      setHistory((h) => [...h, line]);
      setHistoryIndex(null);
      setValue("");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const h = history();
      if (h.length === 0) return;
      const idx = historyIndex() === null ? h.length - 1 : Math.max(0, historyIndex()! - 1);
      const entry = h[idx];
      if (entry === undefined) return;
      setHistoryIndex(idx);
      setValue(entry);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const h = history();
      const idx = historyIndex();
      if (idx === null) return;
      if (idx >= h.length - 1) {
        setHistoryIndex(null);
        setValue("");
      } else {
        const next = h[idx + 1];
        if (next === undefined) return;
        setHistoryIndex(idx + 1);
        setValue(next);
      }
    }
  };

  return (
    <section class="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
      <div ref={container} aria-label="Output" class="min-h-0 flex-1 overflow-hidden rounded-lg bg-[var(--surface-2)]" />
      <div class="mt-2 flex shrink-0 items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[13px] shadow-[inset_0_1px_1px_rgba(255,255,255,0.04)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] focus-within:border-[var(--accent)]/30 focus-within:bg-white/[0.05]">
        <span aria-hidden="true" class="text-[var(--accent)]" style={{ "font-family": "var(--font-mono)" }}>
          &gt;
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value()}
          disabled={props.disabled}
          onInput={(e: Event & { currentTarget: HTMLInputElement }) => setValue(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={props.disabled ? "waiting for runtime…" : "run a command…"}
          aria-label="Terminal command input"
          spellcheck={false}
          autocomplete="off"
          class="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted disabled:cursor-not-allowed"
          style={{ "font-family": "var(--font-mono)" }}
        />
      </div>
    </section>
  );
}
