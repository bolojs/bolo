import { onMount, onCleanup } from 'solid-js';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ShellResult } from '@browser-containers/runtime';

interface Props {
  onCommand(cmd: string, stdout: (s: string) => void, stderr: (s: string) => void): Promise<ShellResult>;
  disabled: boolean;
}

export default function Terminal(props: Props) {
  let container!: HTMLDivElement;

  onMount(() => {
    const xterm = new XTerm({
      convertEol: true,
      cursorBlink: true,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117',
        brightBlack: '#8b949e',
        red: '#f85149',
        brightRed: '#ff7b72',
        green: '#3fb950',
        brightGreen: '#56d364',
        yellow: '#d29922',
        brightYellow: '#e3b341',
        blue: '#58a6ff',
        brightBlue: '#79c0ff',
        magenta: '#bc8cff',
        brightMagenta: '#d2a8ff',
        cyan: '#39c5cf',
        brightCyan: '#56d4dd',
        white: '#b1bac4',
        brightWhite: '#e6edf3',
      },
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    fitAddon.fit();

    xterm.writeln('\x1b[2mTry: npm install lodash\x1b[0m');
    xterm.writeln('\x1b[2mTry: runtime run /hello.js\x1b[0m');
    xterm.writeln('\x1b[2mTry: agent run /untrusted.js\x1b[0m');
    xterm.write('\r\n$ ');

    let inputBuffer = '';
    let running = false;

    const prompt = () => xterm.write('\r\n$ ');

    const runCommand = async (cmd: string) => {
      if (!cmd || running || props.disabled) {
        prompt();
        return;
      }
      running = true;
      xterm.writeln('');
      try {
        const result = await props.onCommand(
          cmd,
          (s) => xterm.write(s),
          (s) => xterm.write(`\x1b[31m${s}\x1b[0m`),
        );
        xterm.write(`\r\n\x1b[2mexit ${result.exitCode}\x1b[0m`);
      } catch (e) {
        xterm.write(`\r\n\x1b[31m${String(e)}\x1b[0m`);
      } finally {
        running = false;
        prompt();
      }
    };

    xterm.onKey(({ key, domEvent }) => {
      const isPrintable = !domEvent.ctrlKey && !domEvent.altKey && !domEvent.metaKey;

      if (domEvent.key === 'Enter') {
        const cmd = inputBuffer.trim();
        inputBuffer = '';
        runCommand(cmd);
      } else if (domEvent.key === 'Backspace') {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          xterm.write('\b \b');
        }
      } else if (isPrintable && key.length === 1) {
        inputBuffer += key;
        xterm.write(key);
      }
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
      <div ref={container} style={{ flex: '1', overflow: 'hidden' }} />
    </section>
  );
}
