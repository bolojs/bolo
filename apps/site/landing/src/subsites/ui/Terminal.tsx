/** @jsxImportSource solid-js */
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  lines: string[];
  disabled: boolean;
  onSubmit(commandLine: string): void | Promise<{ continuation?: boolean } | void>;
  /** Ctrl+C while a submission is in flight — the caller kills the
   * foreground process (Process.kill); the unwinding submit reprints the
   * prompt. With nothing in flight the input line is just cancelled. */
  onInterrupt?(): void;
  inputValue?: string;
  focusTrigger?: number;
  /** Prompt written after each submission and on enable. ANSI escapes allowed. */
  prompt?: string;
}

/** Echoed user input renders bold so it reads distinctly from command output. */
const INPUT_ON = "\x1b[1m";
const INPUT_OFF = "\x1b[22m";

export default function Terminal(props: Props) {
  let container!: HTMLDivElement;
  let xterm: XTerm | undefined;
  let fitAddon: FitAddon | undefined;

  let lineBuffer = "";
  let cursor = 0;
  let history: string[] = [];
  let historyIndex: number | null = null;
  let stashedLine = "";
  let prevDisabled = true;
  const [busy, setBusy] = createSignal(false);
  // Writes that arrive before xterm.open() (the mount is font-gated) would
  // land in an unopened buffer and vanish — queue them and flush on open.
  let opened = false;
  let outQueue: string[] = [];
  const write = (s: string) => {
    if (!opened) {
      outQueue.push(s);
      return;
    }
    xterm?.write(s);
  };
  // Depth rather than a flag: a line submitted mid-run queues behind the
  // in-flight one, and each is still interruptible when its turn comes.
  let running = 0;
  const interrupt = () => {
    write("^C");
    lineBuffer = "";
    cursor = 0;
    historyIndex = null;
    stashedLine = "";
    if (running > 0) {
      // The killed command unwinds the pending submit, which reprints the
      // prompt — don't write one here or it would appear twice.
      props.onInterrupt?.();
    } else {
      write("\r\n" + promptFor());
    }
  };

  const promptFor = () => props.prompt ?? "> ";

  /** Resolve a CSS color expression to a concrete rgb()/hex string via the
   * computed style of a probe node. xterm parses theme colors on a detached
   * canvas, which can handle rgb()/hex but not color-mix() on every browser
   * version we support. */
  const resolveColor = (css: string, fallback: string) => {
    const probe = document.createElement("span");
    probe.style.display = "none";
    probe.style.color = css;
    container.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved || fallback;
  };

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
      // Custom-property values come back as written — --surface-2 and
      // --accent-dim are color-mix() tokens the canvas parser can't read, so
      // resolve them to rgb() through the probe.
      background: resolveColor(bg, bg || "#0a0a0a"),
      foreground: fg,
      cursor: accent,
      selectionBackground: resolveColor(accentDim, accent || fg),
      // ANSI black must differ from the background or \x1b[30m text is
      // invisible — a dark blend of muted over the surface reads as "black"
      // in both themes.
      black: resolveColor(`color-mix(in srgb, ${muted} 45%, ${bg})`, muted || fg),
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
    // xterm's canvas renderer feeds fontFamily to ctx.font, which cannot
    // resolve var() — glyphs would rasterize at 10px sans-serif against a
    // correctly measured cell grid. Resolve the token to a literal stack.
    const fontFamily =
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
      '"Geist Mono Variable", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

    xterm = new XTerm({
      convertEol: true,
      disableStdin: false,
      cursorBlink: true,
      fontFamily,
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      fontWeight: 400,
      fontWeightBold: 600,
      scrollback: 2000,
      theme: buildTheme(),
    });

    const themeObserver = new MutationObserver(() => {
      if (xterm) xterm.options.theme = buildTheme();
    });
    themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] });

    fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    // xterm bakes cell metrics at open(); if the webfont hasn't loaded the
    // fallback stack's metrics stick forever. Gate the first render on the
    // font, bounded so a stalled load can never block the mount.
    let disposed = false;
    const openWhenFontReady = async () => {
      const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        await Promise.race([
          Promise.all([document.fonts.load('13px "Geist Mono Variable"'), document.fonts.ready]),
          timeout,
        ]);
      } catch {
        // Missing font still mounts — the fallback stack renders.
      }
      if (disposed || !xterm) return;
      xterm.open(container);
      opened = true;
      for (const s of outQueue) xterm.write(s);
      outQueue = [];
      fitAddon?.fit();
      // Insurance: if a late font load shifts metrics, refit once it settles.
      void document.fonts.ready.then(() => {
        if (!disposed) fitAddon?.fit();
      });
    };
    void openWhenFontReady();

    const writeInput = (s: string) => write(INPUT_ON + s + INPUT_OFF);

    /** Replace the editable line wholesale and park the cursor at `pos`. */
    const setLine = (s: string, pos = s.length) => {
      const tail = lineBuffer.length - cursor;
      if (tail > 0) write(`\x1b[${tail}C`);
      for (let i = 0; i < lineBuffer.length; i++) write("\b \b");
      lineBuffer = s;
      writeInput(s);
      const back = s.length - pos;
      if (back > 0) write(`\x1b[${back}D`);
      cursor = pos;
    };

    const insertText = (s: string) => {
      const after = lineBuffer.slice(cursor);
      lineBuffer = lineBuffer.slice(0, cursor) + s + after;
      cursor += s.length;
      if (after.length === 0) {
        writeInput(s);
      } else {
        write(INPUT_ON + s + after + INPUT_OFF + `\x1b[${after.length}D`);
      }
    };

    const moveCursor = (delta: number) => {
      const next = Math.max(0, Math.min(lineBuffer.length, cursor + delta));
      if (next === cursor) return;
      const d = next - cursor;
      write(d > 0 ? `\x1b[${d}C` : `\x1b[${-d}D`);
      cursor = next;
    };

    const backspace = () => {
      if (cursor === 0) return;
      const after = lineBuffer.slice(cursor);
      lineBuffer = lineBuffer.slice(0, cursor - 1) + after;
      cursor -= 1;
      write("\b" + INPUT_ON + after + " " + INPUT_OFF + `\x1b[${after.length + 1}D`);
    };

    const deleteForward = () => {
      if (cursor >= lineBuffer.length) return;
      const after = lineBuffer.slice(cursor + 1);
      lineBuffer = lineBuffer.slice(0, cursor) + after;
      write(INPUT_ON + after + " " + INPUT_OFF + `\x1b[${after.length + 1}D`);
    };

    const killWordBack = () => {
      const before = lineBuffer.slice(0, cursor);
      const kept = before.replace(/\S+\s*$/, "");
      if (kept.length === before.length) return;
      setLine(kept + lineBuffer.slice(cursor), kept.length);
    };

    /** Ctrl+L: clear the visible screen, keep scrollback, redraw the input line. */
    const clearScreen = () => {
      write("\x1b[2J\x1b[H" + promptFor());
      writeInput(lineBuffer);
      const back = lineBuffer.length - cursor;
      if (back > 0) write(`\x1b[${back}D`);
    };

    // Submissions run strictly in order. The line buffer is consumed
    // synchronously so keystrokes typed while a previous line is still being
    // evaluated start a fresh line instead of being appended to (and then
    // wiped with) the in-flight one.
    let pending: Promise<void> = Promise.resolve();
    const submitLine = () => {
      const line = lineBuffer.trim();
      lineBuffer = "";
      cursor = 0;
      write("\r\n");
      pending = pending.then(async () => {
        let continuation = false;
        if (line) {
          historyIndex = null;
          if (history[history.length - 1] !== line) history.push(line);
          if (line === "clear") {
            xterm?.clear();
            write(promptFor());
            return;
          }
          running++;
          setBusy(true);
          try {
            const result = await props.onSubmit(line);
            continuation = result?.continuation ?? false;
          } catch {
            // surfaced by the caller; keep the prompt usable
          } finally {
            running--;
            setBusy(running > 0);
          }
        }
        write(continuation ? "\r\n... " : "\r\n" + promptFor());
      });
      return pending;
    };

    xterm.onData((data) => {
      if (props.disabled) return;

      switch (data) {
        case "\r":
          return submitLine();
        case "\x7f":
          return backspace();
        case "\x1b[A": // ArrowUp — history back
          if (history.length === 0) return;
          if (historyIndex === null) {
            stashedLine = lineBuffer;
            historyIndex = history.length - 1;
          } else {
            historyIndex = Math.max(0, historyIndex - 1);
          }
          return setLine(history[historyIndex] ?? "");
        case "\x1b[B": // ArrowDown — history forward
          if (historyIndex === null) return;
          if (historyIndex >= history.length - 1) {
            historyIndex = null;
            const restored = stashedLine;
            stashedLine = "";
            return setLine(restored);
          }
          historyIndex += 1;
          return setLine(history[historyIndex] ?? "");
        case "\x1b[C":
          return moveCursor(1);
        case "\x1b[D":
          return moveCursor(-1);
        case "\x1b[H":
        case "\x1bOH":
        case "\x1b[1~":
          return moveCursor(-lineBuffer.length);
        case "\x1b[F":
        case "\x1bOF":
        case "\x1b[4~":
          return moveCursor(lineBuffer.length);
        case "\x1b[3~":
          return deleteForward();
        case "\x01": // Ctrl+A
          return moveCursor(-lineBuffer.length);
        case "\x05": // Ctrl+E
          return moveCursor(lineBuffer.length);
        case "\x0b": // Ctrl+K — kill to end of line
          if (cursor >= lineBuffer.length) return;
          lineBuffer = lineBuffer.slice(0, cursor);
          return write("\x1b[K");
        case "\x15": // Ctrl+U — kill to start of line
          return setLine(lineBuffer.slice(cursor), 0);
        case "\x17": // Ctrl+W — kill word back
          return killWordBack();
        case "\x0c": // Ctrl+L
          return clearScreen();
        case "\x03": // Ctrl+C — copy selection, else interrupt the line
          if (xterm?.hasSelection()) {
            const selection = xterm.getSelection();
            if (selection) void navigator.clipboard?.writeText(selection).catch(() => {});
            return;
          }
          return interrupt();
        default:
          break;
      }

      if (data < " " && data !== "\t" && !data.includes("\n") && !data.includes("\r")) return;
      // Bracketed paste delivers a whole chunk; split it into submitted lines.
      const parts = data.split(/\r\n|\r|\n/);
      for (const [i, part] of parts.entries()) {
        if (i > 0) submitLine();
        if (part) insertText(part);
      }
    });

    let written = 0;
    createEffect(() => {
      const lines = props.lines;
      if (lines.length < written) {
        xterm?.clear();
        written = 0;
        lineBuffer = "";
        cursor = 0;
        history = [];
        historyIndex = null;
        stashedLine = "";
      }
      for (let i = written; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined) write(line);
      }
      written = lines.length;
    });

    createEffect(() => {
      const disabled = props.disabled;
      if (!disabled && prevDisabled) {
        write("\r\n" + promptFor());
      }
      prevDisabled = disabled;
    });

    createEffect(() => {
      const v = props.inputValue;
      // Track focusTrigger too, so pasting the same command twice in a row
      // still re-fires (inputValue alone wouldn't change).
      props.focusTrigger;
      if (!v) return;
      setLine(v);
      if (opened) xterm?.focus();
      submitLine();
    });

    const ro = new ResizeObserver(() => fitAddon?.fit());
    ro.observe(container);

    onCleanup(() => {
      disposed = true;
      xterm?.dispose();
      ro.disconnect();
      themeObserver.disconnect();
    });
  });

  return (
    <section data-panel="terminal" class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-[var(--surface-2)] p-2">
        {/* Padding must live on this wrapper, not the ref target — FitAddon measures the ref's own clientHeight. */}
        <div ref={container} aria-label="Terminal" class="h-full w-full overflow-hidden" />
        {busy() && (
          <button
            type="button"
            data-terminal-stop
            title="Kill the running command (Ctrl+C)"
            class="absolute right-3 top-3 z-10 rounded border border-border bg-[var(--surface-2)] px-2 py-1 text-[11px] leading-none text-muted transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)]"
            onClick={() => interrupt()}
          >
            stop
          </button>
        )}
      </div>
    </section>
  );
}
