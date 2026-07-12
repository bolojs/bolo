import type { Terminal } from '@xterm/xterm';
import type { EditorView } from '@codemirror/view';

export interface PlaygroundOptions {
  editorHost: HTMLElement;
  terminalHost: HTMLElement;
  runBtn: HTMLButtonElement;
  sabsWarning: HTMLElement;
  defaultCode: string;
}

export async function initPlayground(options: PlaygroundOptions): Promise<() => void> {
  const { editorHost, terminalHost, runBtn, sabsWarning, defaultCode } = options;

  if (typeof SharedArrayBuffer === 'undefined') {
    sabsWarning.hidden = false;
  }

  let run: () => void;

  try {
    const [{ view }, { term }] = await Promise.all([
      setupEditor(editorHost, defaultCode),
      setupTerminal(terminalHost),
    ]);
    run = () => runCode(view, term);
  } catch (err) {
    console.error('Failed to load playground editor/terminal:', err);
    run = setupTextareaFallback(editorHost, terminalHost, defaultCode);
  }

  runBtn.addEventListener('click', run);
  runBtn.disabled = false;
  return run;
}

async function setupEditor(host: HTMLElement, defaultCode: string) {
  const [{ EditorView }, { EditorState }, { javascript }] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('@codemirror/lang-javascript'),
  ]);

  const textarea = host.querySelector('textarea');
  if (textarea) {
    textarea.remove();
  }

  const state = EditorState.create({
    doc: defaultCode,
    extensions: [
      javascript(),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
        '.cm-content': {
          fontFamily: 'var(--font-mono)',
          fontSize: '0.875rem',
        },
      }),
    ],
  });

  const view = new EditorView({ state, parent: host });
  return { view };
}

async function setupTerminal(host: HTMLElement) {
  const xtermCssModule = await import('@xterm/xterm/css/xterm.css?url');
  const xtermCssUrl = (xtermCssModule as unknown as { default: string }).default;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = xtermCssUrl;
  document.head.appendChild(link);

  host.querySelector('.terminal-placeholder')?.remove();

  const { Terminal } = await import('@xterm/xterm');
  const { FitAddon } = await import('@xterm/addon-fit');

  const term = new Terminal({
    convertEol: true,
    fontFamily: 'var(--font-mono)',
    fontSize: 14,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);
  fitAddon.fit();

  const resizeObserver = new ResizeObserver(() => fitAddon.fit());
  resizeObserver.observe(host);

  return { term, resizeObserver };
}

function runCode(view: EditorView, term: Terminal): void {
  term.clear();
  term.writeln('Running...');
  const code = view.state.doc.toString();

  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    const fn = new Function(code);
    fn();
    term.clear();
    for (const line of logs) {
      term.writeln(line);
    }
    if (logs.length === 0) {
      term.writeln('(no output)');
    }
  } catch (err) {
    term.clear();
    term.writeln(String(err));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function setupTextareaFallback(
  editorHost: HTMLElement,
  terminalHost: HTMLElement,
  defaultCode: string,
): () => void {
  let textarea = editorHost.querySelector('textarea') as HTMLTextAreaElement | null;
  if (!textarea) {
    textarea = document.createElement('textarea');
    textarea.className = 'editor-fallback';
    textarea.value = defaultCode;
    editorHost.innerHTML = '';
    editorHost.appendChild(textarea);
  }

  const output = document.createElement('pre');
  output.className = 'terminal-fallback';
  terminalHost.innerHTML = '';
  terminalHost.appendChild(output);

  return () => {
    const code = textarea?.value ?? '';
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      const fn = new Function(code);
      fn();
      output.textContent = logs.join('\n') || '(no output)';
    } catch (err) {
      output.textContent = String(err);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}
