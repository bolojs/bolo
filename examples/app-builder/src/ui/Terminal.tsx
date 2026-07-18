import { useEffect, useRef } from "react";
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

export default function Terminal({ lines, disabled, theme, onSubmit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const writtenRef = useRef(0);
  const disabledRef = useRef(disabled);
  const onSubmitRef = useRef(onSubmit);
  const prevDisabledRef = useRef(disabled);

  useEffect(() => {
    disabledRef.current = disabled;
    if (!disabled && prevDisabledRef.current) termRef.current?.write("\r\n$ ");
    prevDisabledRef.current = disabled;
  }, [disabled]);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      convertEol: true,
      disableStdin: false,
      cursorBlink: true,
      fontSize: 12,
      theme: XTERM_THEME[theme],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;

    let lineBuffer = "";
    let history: string[] = [];
    let historyIndex: number | null = null;

    const eraseVisible = (n: number) => {
      for (let i = 0; i < n; i++) term.write("\b \b");
    };

    const submitLine = async () => {
      const line = lineBuffer.trim();
      term.write("\r\n");
      if (line) {
        await onSubmitRef.current(line);
        history.push(line);
        historyIndex = null;
      }
      lineBuffer = "";
      term.write("\r\n$ ");
    };

    term.onData((data) => {
      if (disabledRef.current) return;

      if (data === "\r") {
        void submitLine();
      } else if (data === "\x7f") {
        if (lineBuffer.length === 0) return;
        lineBuffer = lineBuffer.slice(0, -1);
        term.write("\b \b");
      } else if (data === "\x1b[A") {
        if (history.length === 0) return;
        const idx = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        const entry = history[idx];
        if (entry === undefined) return;
        historyIndex = idx;
        eraseVisible(lineBuffer.length);
        lineBuffer = entry;
        term.write(entry);
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
          term.write(next);
        }
      } else if (data >= " " || data === "\t") {
        lineBuffer += data;
        term.write(data);
      }
    });

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(hostRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    for (let i = writtenRef.current; i < lines.length; i++) {
      term.write(lines[i]!);
    }
    writtenRef.current = lines.length;
  }, [lines]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = XTERM_THEME[theme];
  }, [theme]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
}
