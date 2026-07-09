import { boot, type BrowserContainer } from '@browser-containers/runtime';

export interface CompatRunResult {
  exitCode: number;
  output: string;
}

export interface CompatHarness {
  /** True once `boot()` has resolved and `run()` is safe to call. */
  ready: boolean;
  boot(): Promise<void>;
  /**
   * Writes `source` to `path` under the container workdir and runs it via
   * `node <path>`, returning the combined stdout+stderr text and exit code.
   * `Process.output` (packages/runtime/src/process.ts) merges both streams —
   * fine for pass/fail/error-text harness use, where stream separation isn't
   * needed.
   */
  run(path: string, source: string): Promise<CompatRunResult>;
  teardown(): Promise<void>;
}

declare global {
  interface Window {
    __compatHarness: CompatHarness;
  }
}

let container: BrowserContainer | undefined;

async function readAll(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let output = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += value;
  }
  return output;
}

const normalize = (path: string): string => (path.startsWith('/') ? path : `/${path}`);

window.__compatHarness = {
  ready: false,

  async boot() {
    container = await boot({ workdirName: '/home/harness' });
    window.__compatHarness.ready = true;
  },

  async run(path, source) {
    if (!container) throw new Error('CompatHarness: boot() must resolve before run()');
    const rel = normalize(path);
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    if (dir) await container.fs.mkdir(container.workdir + dir, { recursive: true });
    await container.fs.writeFile(container.workdir + rel, source);

    const proc = container.spawn('node', [rel]);
    const [output, exitCode] = await Promise.all([readAll(proc.output), proc.exit]);
    return { exitCode, output };
  },

  async teardown() {
    await container?.teardown();
    container = undefined;
    window.__compatHarness.ready = false;
  },
};
