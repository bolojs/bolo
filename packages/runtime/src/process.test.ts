import { describe, expect, it, vi } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { createProcess } from './process.js';
import { ShellService } from './shell-service.js';
import { RuntimeWorker } from './runtime-worker.js';

describe('createProcess', () => {
  it('should spawn shell command and return exit code', async () => {
    const vfs = new VfsBus();
    const shell = { execute: vi.fn().mockResolvedValue({ exitCode: 0 }) } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess('npm', ['install'], {}, { vfs, shell, runtimeWorker });

    expect(proc.output).toBeInstanceOf(ReadableStream);
    const exitCode = await proc.exit;
    expect(exitCode).toBe(0);
    expect(shell.execute).toHaveBeenCalledWith('npm install', { stdout: expect.any(Function), stderr: expect.any(Function) });
  });

  it('should stream shell stdout and stderr', async () => {
    const vfs = new VfsBus();
    const shell = {
      execute: vi.fn().mockImplementation((_cmd, output) => {
        output?.stdout?.('hello ');
        output?.stderr?.('error ');
        return Promise.resolve({ exitCode: 0 });
      }),
    } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess('echo', ['hi'], {}, { vfs, shell, runtimeWorker });

    const reader = proc.output.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks).toEqual(['hello ', 'error ']);
  });

  it('should run runtime worker path for runtime run', async () => {
    const vfs = new VfsBus();
    await vfs.writeFile('/script.js', 'console.log(1)');
    const shell = { execute: vi.fn() } as unknown as ShellService;
    const runtimeWorker = {
      runScript: vi.fn(),
      dispose: vi.fn(),
    } as unknown as RuntimeWorker;
    const proc = createProcess('runtime', ['run', '/script.js'], {}, { vfs, shell, runtimeWorker });

    const reader = proc.output.getReader();
    const readPromise = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    })();

    await vi.waitFor(() => {
      expect(runtimeWorker.runScript).toHaveBeenCalledWith('console.log(1)', { filename: '/script.js' });
    });

    (runtimeWorker as any).onStdout?.('out');
    (runtimeWorker as any).onStderr?.('err');
    (runtimeWorker as any).onExit?.(0);

    await readPromise;
    const exitCode = await proc.exit;
    expect(exitCode).toBe(0);
  });

  it('should return error for runtime run without file path', async () => {
    const vfs = new VfsBus();
    const shell = { execute: vi.fn() } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess('runtime', ['run'], {}, { vfs, shell, runtimeWorker });

    const reader = proc.output.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks[0]).toContain('Usage');
    expect(await proc.exit).toBe(1);
  });

  it('should kill process with exit code 1', async () => {
    const vfs = new VfsBus();
    const shell = { execute: vi.fn().mockReturnValue(new Promise(() => {})) } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess('sleep', ['10'], {}, { vfs, shell, runtimeWorker });
    proc.kill();
    expect(await proc.exit).toBe(1);
    expect(runtimeWorker.dispose).toHaveBeenCalled();
  });

  it('should handle shell command errors', async () => {
    const vfs = new VfsBus();
    const shell = {
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess('bad', [], {}, { vfs, shell, runtimeWorker });

    const reader = proc.output.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks[0]).toContain('boom');
    expect(await proc.exit).toBe(1);
  });
});
