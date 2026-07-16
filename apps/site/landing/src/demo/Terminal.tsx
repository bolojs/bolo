/** @jsxImportSource solid-js */
import { createEffect, onCleanup, onMount } from "solid-js";
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
  let xterm: XTerm | undefined;
  let fitAddon: FitAddon | undefined;

  let lineBuffer = "";
  let history: string[] = [];
  let historyIndex: number | null = null;
  let prevDisabled = true;

  const buildTheme = () => {
    const style = getComputedStyle(container);
    const bg = style.getPropertyValue("--surface-2").trim() || "#0a0a0a";
    const fg = style.getPropertyValue("--fg").trim();
    const accent = style.getPropertyValue("--accent").trim();
    const muted = style.getPropertyValue("--muted").trim();
    const danger = style.getPropertyValue("--danger").trim();
    const success = style.getPropertyValue("--success").trim();
    const accentDim = style.getPropertyValue("--accent-dim").trim();

    return {
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
    };
  };

  onMount(() => {
    xterm = new XTerm({
      convertEol: true,
      disableStdin: false,
      cursorBlink: true,
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      theme: buildTheme(),
    });

    const themeObserver = new MutationObserver(() => {
      if (xterm) xterm.options.theme = buildTheme();
    });
    themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] });

    fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    fitAddon.fit();

    const eraseVisible = (n: number) => {
      for (let i = 0; i < n; i++) xterm?.write("\b \b");
    };

    const submitLine = () => {
      const line = lineBuffer.trim();
      xterm?.write("\r\n");
      if (line) {
        props.onSubmit(line);
        history.push(line);
        historyIndex = null;
      }
      lineBuffer = "";
      xterm?.write("\r\n> ");
    };

    xterm.onData((data) => {
      if (props.disabled) return;

      if (data === "\r") {
        submitLine();
      } else if (data === "\x7f") {
        if (lineBuffer.length === 0) return;
        lineBuffer = lineBuffer.slice(0, -1);
        xterm?.write("\b \b");
      } else if (data === "\x1b[A") {
        if (history.length === 0) return;
        const idx = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        const entry = history[idx];
        if (entry === undefined) return;
        historyIndex = idx;
        eraseVisible(lineBuffer.length);
        lineBuffer = entry;
        xterm?.write(entry);
      } else if (data === "\x1b[B") {
        if (historyIndex === null) return;
        if (historyIndex >= history.length - 1) {
          historyIndex = null;
          eraseVisible(lineBuffer.length);
          lineBuffer = "";
        } else {
          const next = history[historyIndex + 1];
          if (next === undefined) return;
          historyIndex += 1;
          eraseVisible(lineBuffer.length);
          lineBuffer = next;
          xterm?.write(next);
        }
      } else if (data >= " " || data === "\t") {
        lineBuffer += data;
        xterm?.write(data);
      }
    });

    let written = 0;
    createEffect(() => {
      const lines = props.lines;
      if (lines.length < written) {
        xterm?.clear();
        written = 0;
        lineBuffer = "";
        history = [];
        historyIndex = null;
      }
      for (let i = written; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined) xterm?.write(line);
      }
      written = lines.length;
    });

    createEffect(() => {
      const disabled = props.disabled;
      if (!disabled && prevDisabled) {
        xterm?.write("\r\n> ");
      }
      prevDisabled = disabled;
    });

    createEffect(() => {
      const v = props.inputValue;
      // Track focusTrigger too, so pasting the same command twice in a row
      // still re-fires (inputValue alone wouldn't change).
      props.focusTrigger;
      if (!v) return;
      eraseVisible(lineBuffer.length);
      lineBuffer = v;
      xterm?.write(v);
      xterm?.focus();
      submitLine();
    });

    const ro = new ResizeObserver(() => fitAddon?.fit());
    ro.observe(container);

    onCleanup(() => {
      xterm?.dispose();
      ro.disconnect();
      themeObserver.disconnect();
    });
  });

  return (
    <section class="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
      <div class="min-h-0 flex-1 overflow-hidden rounded-lg bg-[var(--surface-2)] p-2">
        {/* Padding must live on this wrapper, not the ref target — FitAddon measures the ref's own clientHeight. */}
        <div ref={container} aria-label="Terminal" class="h-full w-full overflow-hidden" />
      </div>
    </section>
  );
}
