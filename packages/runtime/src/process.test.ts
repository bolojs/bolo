import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProcess } from './process.js';
import type { RuntimeWorker } from './runtime-worker.js';
import { ShellService } from './shell-service.js';

const createMockRuntimeWorker = (): Partial<RuntimeWorker> => ({
  runScript: vi.fn(),
  onStdout: null,
  onStderr: null,
  onExit: null,
  dispose: vi.fn(),
});

const createMockShellService = (): Partial<ShellService> => ({
  execute: vi.fn(),
});

describe('createProcess', () => {
  describe('RuntimeWorker path (command: runtime, args: [run, filePath])', () => {
    let mockRuntimeWorker: Partial<RuntimeWorker>;
    let mockShellService: Partial<ShellService>;

    beforeEach(() => {
      mockRuntimeWorker = createMockRuntimeWorker();
      mockShellService = createMockShellService();
    });

    it('creates Process with exit, output, kill', () => {
      const process = createProcess('runtime', ['run', 'app.ts'], {}, {
        runtimeWorker: mockRuntimeWorker as RuntimeWorker,
        shellService: mockShellService as ShellService,
      });

      expect(process.exit).toBeInstanceOf(Promise);
      expect(process.output).toBeInstanceOf(ReadableStream);
      expect(typeof process.kill).toBe('function');
    });

    it('calls RuntimeWorker.runScript with correct args', async () => {
      const vfs = {
        readFile: vi.fn().mockResolvedValue('console.log("hello")'),
      } as any;

      const runtimeWorker = {
        runScript: vi.fn().mockResolvedValue(undefined),
        onStdout: null,
        onStderr: null,
        onExit: null,
        dispose: vi.fn(),
      } as unknown as RuntimeWorker;

      const shellService = {} as any;

      const process = createProcess('runtime', ['run', 'app.ts'], {}, {
        vfs,
        runtimeWorker,
        shellService,
      });

      if (runtimeWorker.onExit) {
        runtimeWorker.onExit(0);
      }
      await process.exit;

      expect(runtimeWorker.runScript).toHaveBeenCalledWith('console.log("hello")', {
        filename: 'app.ts',
      });
    });

    it('streams stdout from RuntimeWorker via output ReadableStream', async () => {
      const vfs = {
        readFile: vi.fn().mockResolvedValue('console.log("hello")'),
      } as any;

      const runtimeWorker = {
        runScript: vi.fn().mockResolvedValue(undefined),
        onStdout: null,
        onStderr: null,
        onExit: null,
        dispose: vi.fn(),
      } as unknown as RuntimeWorker;

      const shellService = {} as any;

      const process = createProcess('runtime', ['run', 'app.ts'], {}, {
        vfs,
        runtimeWorker,
        shellService,
      });

      if (runtimeWorker.onStdout) {
        runtimeWorker.onStdout('hello from runtime\n');
      }

      const reader = process.output.getReader();
      const { value } = await reader.read();

      expect(value).toBe('hello from runtime\n');
      reader.releaseLock();
    });

    it('streams stderr from RuntimeWorker via output ReadableStream', async () => {
      const vfs = {
        readFile: vi.fn().mockResolvedValue('throw new Error("fail")'),
      } as any;

      const runtimeWorker = {
        runScript: vi.fn().mockResolvedValue(undefined),
        onStdout: null,
        onStderr: null,
        onExit: null,
        dispose: vi.fn(),
      } as unknown as RuntimeWorker;

      const shellService = {} as any;

      const process = createProcess('runtime', ['run', 'app.ts'], {}, {
        vfs,
        runtimeWorker,
        shellService,
      });

      if (runtimeWorker.onStderr) {
        runtimeWorker.onStderr('error from runtime\n');
      }

      const reader = process.output.getReader();
      const { value } = await reader.read();

      expect(value).toBe('error from runtime\n');
      reader.releaseLock();
    });

    it('resolves exit promise with exit code from RuntimeWorker.onExit', async () => {
      const vfs = {
        readFile: vi.fn().mockResolvedValue('console.log("done")'),
      } as any;

      const runtimeWorker = {
        runScript: vi.fn().mockResolvedValue(undefined),
        onStdout: null,
        onStderr: null,
        onExit: null,
        dispose: vi.fn(),
      } as unknown as RuntimeWorker;

      const shellService = {} as any;

      const process = createProcess('runtime', ['run', 'app.ts'], {}, {
        vfs,
        runtimeWorker,
        shellService,
      });

      if (runtimeWorker.onExit) {
        runtimeWorker.onExit(42);
      }

      const exitCode = await process.exit;

      expect(exitCode).toBe(42);
    });

    it('kill() calls RuntimeWorker.dispose()', () => {
      const vfs = {
        readFile: vi.fn().mockResolvedValue('console.log("hello")'),
      } as any;

      const runtimeWorker = {
        runScript: vi.fn().mockResolvedValue(undefined),
        onStdout: null,
        onStderr: null,
        onExit: null,
        dispose: vi.fn(),
      } as unknown as RuntimeWorker;

      const shellService = {} as any;

      const process = createProcess('runtime', ['run', 'app.ts'], {}, {
        vfs,
        runtimeWorker,
        shellService,
      });

      process.kill();

      expect(runtimeWorker.dispose).toHaveBeenCalled();
    });
  });

  describe('ShellService path (other commands)', () => {
    let mockRuntimeWorker: Partial<RuntimeWorker>;
    let mockShellService: Partial<ShellService>;

    beforeEach(() => {
      mockRuntimeWorker = createMockRuntimeWorker();
      mockShellService = {
        execute: vi.fn().mockResolvedValue({
          stdout: 'hello from shell\n',
          stderr: 'warning from shell\n',
          exitCode: 0,
        }),
      };
    });

    it('creates Process with exit, output, kill', () => {
      const process = createProcess('npm', ['install', 'lodash'], {}, {
        runtimeWorker: mockRuntimeWorker as RuntimeWorker,
        shellService: mockShellService as ShellService,
      });

      expect(process.exit).toBeInstanceOf(Promise);
      expect(process.output).toBeInstanceOf(ReadableStream);
      expect(typeof process.kill).toBe('function');
    });

    it('calls ShellService.execute with combined command and args', async () => {
      const runtimeWorker = {} as any;

      const shellService = {
        execute: vi.fn().mockResolvedValue({
          stdout: '',
          stderr: '',
          exitCode: 0,
        }),
      } as unknown as ShellService;

      const process = createProcess('npm', ['install', 'lodash'], {}, {
        runtimeWorker,
        shellService,
      });

      await process.exit;

      expect(shellService.execute).toHaveBeenCalledWith('npm install lodash', expect.any(Object));
    });

    it('streams stdout and stderr via output ReadableStream', async () => {
      const runtimeWorker = {} as any;

      let capturedOutput: { stdout?: string; stderr?: string } | undefined;

      const shellService = {
        execute: vi.fn().mockImplementation(async (cmd, output) => {
          capturedOutput = output;

          output?.stdout?.('hello from shell\n');
          output?.stderr?.('warning from shell\n');

          return {
            stdout: 'hello from shell\n',
            stderr: 'warning from shell\n',
            exitCode: 0,
          };
        }),
      } as unknown as ShellService;

      const process = createProcess('npm', ['install', 'lodash'], {}, {
        runtimeWorker,
        shellService,
      });

      const reader = process.output.getReader();

      const { value: chunk1 } = await reader.read();
      const { value: chunk2 } = await reader.read();

      const combined = (chunk1 || '') + (chunk2 || '');

      expect(combined).toContain('hello from shell\n');
      expect(combined).toContain('warning from shell\n');

      reader.releaseLock();
    });

    it('resolves exit promise with exitCode from ShellResult', async () => {
      const runtimeWorker = {} as any;

      const shellService = {
        execute: vi.fn().mockResolvedValue({
          stdout: '',
          stderr: '',
          exitCode: 42,
        }),
      } as unknown as ShellService;

      const process = createProcess('npm', ['install', 'lodash'], {}, {
        runtimeWorker,
        shellService,
      });

      const exitCode = await process.exit;

      expect(exitCode).toBe(42);
    });

    it('kill() sets aborted flag and closes output stream', async () => {
      const runtimeWorker = {} as any;

      const shellService = {
        execute: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return {
            stdout: '',
            stderr: '',
            exitCode: 0,
          };
        }),
      } as unknown as ShellService;

      const process = createProcess('npm', ['install', 'lodash'], {}, {
        runtimeWorker,
        shellService,
      });

      process.kill();

      const reader = process.output.getReader();
      const { done } = await reader.read();
      expect(done).toBe(true);
      reader.releaseLock();
    });
  });

  describe('edge cases', () => {
    it('handles empty args for runtime run', async () => {
      const vfs = {
        readFile: vi.fn().mockResolvedValue('console.log("hello")'),
      } as any;

      const runtimeWorker = {
        runScript: vi.fn(),
        onStdout: null,
        onStderr: null,
        onExit: null,
        dispose: vi.fn(),
        worker: null,
        heartbeatTimer: null,
        missedHeartbeats: 0,
      } as unknown as RuntimeWorker;

      const shellService = {} as any;

      const process = createProcess('runtime', [], {}, {
        vfs,
        runtimeWorker,
        shellService,
      });

      process.kill();
    });

    it('handles runtime without run subcommand', async () => {
      const vfs = {} as any;

      const runtimeWorker = {
        runScript: vi.fn(),
        worker: null,
        heartbeatTimer: null,
        missedHeartbeats: 0,
      } as unknown as RuntimeWorker;

      const shellService = {
        execute: vi.fn().mockResolvedValue({
          stdout: '',
          stderr: '',
          exitCode: 0,
        }),
      } as unknown as ShellService;

      const process = createProcess('runtime', ['version'], {}, {
        vfs,
        runtimeWorker,
        shellService,
      });

      await process.exit;

      expect(shellService.execute).toHaveBeenCalledWith('runtime version', expect.any(Object));
      expect(runtimeWorker.runScript).not.toHaveBeenCalled();
    });
  });
});
