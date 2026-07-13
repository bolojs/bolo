import { createEffect, onCleanup, onMount } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  lines: string[];
}

export default function Terminal(props: Props) {
  let container!: HTMLDivElement;

  onMount(() => {
    const xterm = new XTerm({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
        black: "#0d1117",
        brightBlack: "#8b949e",
        red: "#f85149",
        brightRed: "#ff7b72",
        green: "#3fb950",
        brightGreen: "#56d364",
        yellow: "#d29922",
        brightYellow: "#e3b341",
        blue: "#58a6ff",
        brightBlue: "#79c0ff",
        magenta: "#bc8cff",
        brightMagenta: "#d2a8ff",
        cyan: "#39c5cf",
        brightCyan: "#56d4dd",
        white: "#b1bac4",
        brightWhite: "#e6edf3",
      },
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    fitAddon.fit();

    let written = 0;
    createEffect(() => {
      const lines = props.lines;
      for (let i = written; i < lines.length; i++) {
        xterm.write(lines[i]);
      }
      written = lines.length;
    });

    const ro = new ResizeObserver(() => fitAddon.fit());
    ro.observe(container);

    onCleanup(() => {
      xterm.dispose();
      ro.disconnect();
    });
  });

  return (
    <section class="terminal">
      <div ref={container} aria-label="Output" style={{ flex: "1", overflow: "hidden" }} />
    </section>
  );
}
