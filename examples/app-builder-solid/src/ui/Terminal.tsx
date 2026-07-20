import { onCleanup, onMount, createEffect } from "solid-js";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type Theme = "dark" | "light";

interface Props {
  lines: string[];
  disabled: boolean;
  theme: Theme;
  onSubmit(commandLine: string): void | Promise<void>;
}

const XTERM_THEME: Record<Theme, ITheme> = {
  dark: {
    background: "#131313",
    foreground: "#e2e2e2",
    cursor: "#e2e2e2",
    selectionBackground: "#353535",
  },
  light: {
    background: "#ffffff",
    foreground: "#1a1c1c",
    cursor: "#1a1c1c",
    selectionBackground: "#d6d6d6",
  },
};

export default function Terminal(props: Props) {
  let host!: HTMLDivElement;
  let term: XTerm | null = null;
  let written = 0;
  let prevDisabled = props.disabled;

  onMount(() => {
    const t = new XTerm({
      convertEol: true,
      disableStdin: false,
      cursorBlink: true,
      fontSize: 12,
      theme: XTERM_THEME[props.theme],
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host);
    fit.fit();
    term = t;

    let lineBuffer = "";
    let history: string[] = [];
    let historyIndex: number | null = null;

    const eraseVisible = (n: number) => {
      for (let i = 0; i < n; i++) t.write("\b \b");
    };

    const submitLine = async () => {
      const line = lineBuffer.trim();
      t.write("\r\n");
      if (line) {
        await props.onSubmit(line);
        history.push(line);
        historyIndex = null;
      }
      lineBuffer = "";
      t.write("\r\n$ ");
    };

    t.onData((data) => {
      if (props.disabled) return; // reactive getter — always fresh
      if (data === "\r") {
        void submitLine();
      } else if (data === "\x7f") {
        if (lineBuffer.length === 0) return;
        lineBuffer = lineBuffer.slice(0, -1);
        t.write("\b \b");
      } else if (data === "\x1b[A") {
        if (history.length === 0) return;
        const idx = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        const entry = history[idx];
        if (entry === undefined) return;
        historyIndex = idx;
        eraseVisible(lineBuffer.length);
        lineBuffer = entry;
        t.write(entry);
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
          t.write(next);
        }
      } else if (data >= " " || data === "\t") {
        lineBuffer += data;
        t.write(data);
      }
    });

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(host);

    onCleanup(() => {
      resizeObserver.disconnect();
      t.dispose();
      term = null;
      written = 0;
    });
  });

  // when `disabled` flips false→true, no-op; when true→false, the React version
  // wrote a fresh prompt — track the transition reactively here.
  createEffect(() => {
    const d = props.disabled;
    if (!d && prevDisabled && term) term.write("\r\n$ ");
    prevDisabled = d;
  });

  createEffect(() => {
    const t = term;
    if (!t) return;
    const lines = props.lines;
    for (let i = written; i < lines.length; i++) t.write(lines[i]!);
    written = lines.length;
  });

  createEffect(() => {
    if (term) term.options.theme = XTERM_THEME[props.theme];
  });

  return <div ref={host} class="h-full min-h-0 overflow-hidden" />;
}
