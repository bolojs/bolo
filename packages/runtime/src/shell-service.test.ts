import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShellService, type ShellServiceDeps } from './shell-service.js';

const createMockDeps = (): ShellServiceDeps => ({
  vfs: {
    readFile: vi.fn().mockResolvedValue('console.log("hello")'),
  } as unknown as ShellServiceDeps['vfs'],
  packageManager: {
    install: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShellServiceDeps['packageManager'],
  runtimeWorker: {
    runScript: vi.fn().mockResolvedValue(undefined),
    onStdout: null,
    onStderr: null,
  } as unknown as ShellServiceDeps['runtimeWorker'],
  sandboxPool: {
    run: vi.fn().mockResolvedValue({ result: 'ok' }),
  } as unknown as ShellServiceDeps['sandboxPool'],
  sandbox: {
    onFetch: vi.fn(),
    setPolicyRegistry: vi.fn(),
  } as unknown as ShellServiceDeps['sandbox'],
  events: {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    removeAllListeners: vi.fn(),
  } as unknown as ShellServiceDeps['events'],
});

describe('ShellService', () => {
  let deps: ShellServiceDeps;
  let shell: ShellService;

  beforeEach(() => {
    deps = createMockDeps();
    shell = new ShellService(deps);
  });

  it('npm install <pkgs> → PackageManager.install(pkgs)', async () => {
    const result = await shell.execute('npm install lodash express');
    expect(deps.packageManager.install).toHaveBeenCalledWith(['lodash', 'express']);
    expect(result.exitCode).toBe(0);
  });

  it('npm install (no args) → PackageManager.install()', async () => {
    const result = await shell.execute('npm install');
    expect(deps.packageManager.install).toHaveBeenCalledWith();
    expect(result.exitCode).toBe(0);
  });

  it('npm i (shorthand) works', async () => {
    const result = await shell.execute('npm i react');
    expect(deps.packageManager.install).toHaveBeenCalledWith(['react']);
    expect(result.exitCode).toBe(0);
  });

  it('npm run dev → starts BrowserViteServer and wires sandbox.onFetch', async () => {
    deps.sandbox = {
      onFetch: vi.fn(),
      setPolicyRegistry: vi.fn(),
    } as unknown as ShellServiceDeps['sandbox'];

    const result = await shell.execute('npm run dev');
    expect(deps.sandbox?.onFetch).toHaveBeenCalledOnce();
    expect(deps.events?.emit).toHaveBeenCalledWith('port', 3000, 'open', '/__preview/');
    expect(deps.events?.emit).toHaveBeenCalledWith('server-ready', 3000, '/__preview/');
    expect(result.exitCode).toBe(0);
  });

  it('npm run dev → error when no sandbox configured', async () => {
    deps.sandbox = undefined;
    const result = await shell.execute('npm run dev');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No sandbox configured');
  });

  it('npm run <other> → SandboxPool.run()', async () => {
    const result = await shell.execute('npm run build');
    expect(deps.sandboxPool.run).toHaveBeenCalledWith('build');
    expect(result.exitCode).toBe(0);
  });

  it('npm run <other> → handles SandboxPool error', async () => {
    vi.mocked(deps.sandboxPool.run).mockResolvedValue({ error: 'boom' });
    const result = await shell.execute('npm run build');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
  });

  it('runtime run script.ts → RuntimeWorker.runScript()', async () => {
    const result = await shell.execute('runtime run app.ts');
    expect(deps.vfs.readFile).toHaveBeenCalledWith('app.ts');
    expect(deps.runtimeWorker.runScript).toHaveBeenCalledWith(
      'console.log("hello")',
      { filename: 'app.ts' },
    );
    expect(result.exitCode).toBe(0);
  });

  it('runtime run → error when no file specified', async () => {
    const result = await shell.execute('runtime run');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('agent run agent.ts → SandboxPool.run()', async () => {
    const result = await shell.execute('agent run bot.ts');
    expect(deps.vfs.readFile).toHaveBeenCalledWith('bot.ts');
    expect(deps.sandboxPool.run).toHaveBeenCalledWith('console.log("hello")');
    expect(result.exitCode).toBe(0);
  });

  it('agent run → error when no file specified', async () => {
    const result = await shell.execute('agent run');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('unknown command → exit code 127', async () => {
    const result = await shell.execute('foo bar');
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('Unknown command: foo');
  });

  it('npm install error → exit code 1', async () => {
    vi.mocked(deps.packageManager.install).mockRejectedValue(new Error('network fail'));
    const result = await shell.execute('npm install lodash');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('network fail');
  });

  it('stdout/stderr callbacks are invoked', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await shell.execute('npm install foo', {
      stdout: (d) => stdoutChunks.push(d),
      stderr: (d) => stderrChunks.push(d),
    });
    expect(result.exitCode).toBe(0);
  });

  it('unsupported npm subcommand → exit code 1', async () => {
    const result = await shell.execute('npm outdated');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unsupported npm subcommand');
  });

  it('unsupported runtime subcommand → exit code 1', async () => {
    const result = await shell.execute('runtime compile');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unsupported runtime subcommand');
  });

  it('unsupported agent subcommand → exit code 1', async () => {
    const result = await shell.execute('agent list');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unsupported agent subcommand');
  });
});
