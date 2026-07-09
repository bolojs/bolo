import { createEventsShim, createStreamShim, createBufferShim } from '@browser-containers/node-web-shims';

const { EventEmitter } = createEventsShim();
const { Readable, Writable } = createStreamShim();
// `createBufferShim`'s declared return type loses the `Buffer` member (a pre-existing
// tsc declaration-emit quirk on unenv's untyped default export), so read it off the
// runtime value instead of trusting the type.
const { Buffer } = createBufferShim() as unknown as { Buffer: typeof globalThis.Buffer };

export interface WasmRegistry {
  dispatch(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ShellService {
  exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const dispatchCommand = async (
  command: string,
  args: string[],
  registry?: WasmRegistry,
  shell?: ShellService,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  if (registry) {
    const result = await registry.dispatch(command, args);
    if (result.exitCode !== 0 && result.stderr.includes('WASM tool not found') && shell) {
      return shell.exec(command, args);
    }
    return result;
  }
  if (shell) return shell.exec(command, args);
  return { stdout: '', stderr: 'No registry or shell available', exitCode: 1 };
};

/**
 * unenv's own `Readable` doesn't implement flowing-mode delivery (`push` is a
 * no-op), so — same as `IncomingMessageImpl` in http-shim.ts — this emits
 * 'data'/'end' directly. `dispatch`/`shell.exec` only ever resolve a fully
 * buffered stdout/stderr string (no real incremental streaming from the
 * underlying bash/wasm dispatch), so each stream gets at most one 'data'
 * event before 'end'.
 */
class StdioReadable extends Readable {
  emitOutput(text: string): void {
    if (text.length > 0) this.emit('data', Buffer.from(text));
    this.emit('end');
  }

  override read(): unknown {
    return null;
  }
}

/**
 * Nothing consumes stdin on the dispatch/shell.exec path (neither interface
 * accepts input), so writes are accepted (to match real `ChildProcess.stdin`
 * being a valid `Writable`) but discarded.
 */
class StdinWritable extends Writable {
  override _write(_chunk: unknown, _encoding: string, callback?: (error?: Error | null) => void): void {
    callback?.();
  }
}

class ChildProcessImpl extends EventEmitter implements ChildProcess {
  readonly stdin: StdinWritable = new StdinWritable();
  readonly stdout: StdioReadable = new StdioReadable();
  readonly stderr: StdioReadable = new StdioReadable();
  readonly pid = undefined;
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const runChild = (command: string, args: string[], registry?: WasmRegistry, shell?: ShellService): ChildProcessImpl => {
  const child = new ChildProcessImpl();

  (async () => {
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await dispatchCommand(command, args, registry, shell);
    } catch (error) {
      child.emit('error', error instanceof Error ? error : new Error(String(error)));
      return;
    }

    child.stdout.emitOutput(result.stdout);
    child.stderr.emitOutput(result.stderr);
    child.exitCode = result.exitCode;
    child.emit('exit', result.exitCode, null);
    child.emit('close', result.exitCode, null);
  })();

  return child;
};

const SYNC_NOT_SUPPORTED =
  'Synchronous child_process calls are not supported: command dispatch in this environment is always ' +
  'asynchronous (bash interpreter / wasm tool / bundler), and the browser main thread cannot block on a ' +
  'Promise. Use the async spawn()/exec() APIs instead.';

export const createChildProcessShim = (registry?: WasmRegistry, shell?: ShellService) => {
  const spawn = (command: string, args?: string[], _options?: Record<string, unknown>): ChildProcess =>
    runChild(command, args ?? [], registry, shell);

  const exec = (command: string, options?: any, callback?: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const parts = command.split(' ');
    const child = runChild(parts[0], parts.slice(1), registry, shell);

    if (cb) {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code: number) => {
        cb(code === 0 ? null : new Error(`Command failed: ${command}\n${stderr}`), stdout, stderr);
      });
      child.on('error', (error: Error) => cb(error, '', ''));
    }

    return child;
  };

  const execSync = (): never => {
    throw new Error(SYNC_NOT_SUPPORTED);
  };

  const spawnSync = (): never => {
    throw new Error(SYNC_NOT_SUPPORTED);
  };

  return { spawn, exec, execSync, spawnSync };
};

export interface ChildProcess {
  readonly stdin: InstanceType<typeof Writable>;
  readonly stdout: InstanceType<typeof Readable>;
  readonly stderr: InstanceType<typeof Readable>;
  readonly pid: number | undefined;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: string | number): boolean;
  on(event: string, handler: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}
