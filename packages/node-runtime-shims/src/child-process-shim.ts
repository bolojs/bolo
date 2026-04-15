export interface WasmRegistry {
  dispatch(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ShellService {
  exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export const createChildProcessShim = (registry?: WasmRegistry, shell?: ShellService) => {
  const spawn = (command: string, args?: string[], _options?: Record<string, unknown>) => {
    const child: ChildProcess = {
      stdin: { write: () => {}, end: () => {} },
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, handler: (code: number) => void) => {
        if (event === 'close') {
          (async () => {
            let result: { stdout: string; stderr: string; exitCode: number };

            if (registry) {
              result = await registry.dispatch(command, args ?? []);
              if (result.exitCode !== 0 && result.stderr.includes('WASM tool not found') && shell) {
                result = await shell.exec(command, args ?? []);
              }
            } else if (shell) {
              result = await shell.exec(command, args ?? []);
            } else {
              result = { stdout: '', stderr: 'No registry or shell available', exitCode: 1 };
            }

            handler(result.exitCode);
          })();
        }
      },
    };
    return child;
  };

  const exec = (command: string, options?: any, callback?: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const parts = command.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);
    const child = spawn(cmd, args);
    child.on('close', (code: number) => {
      if (cb) cb(code === 0 ? null : new Error(`Exit code ${code}`), '', '');
    });
    return child;
  };

  return { spawn, exec };
};

export interface ChildProcess {
  stdin: { write: (data: string) => void; end: () => void };
  stdout: { on: (event: string, handler: (...args: any[]) => void) => void };
  stderr: { on: (event: string, handler: (...args: any[]) => void) => void };
  on: (event: string, handler: (...args: any[]) => void) => void;
}
