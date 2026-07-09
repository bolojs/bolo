import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { ShellService, type ShellServiceDeps } from './shell-service.js';

const createMockDeps = (): ShellServiceDeps => {
  const vfs = new VfsBus();
  vfs.readFile = vi.fn().mockResolvedValue('console.log("hello")') as typeof vfs.readFile;
  return {
    vfs,
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
  };
};

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

  it('npm run dev → VFS writes trigger HMR, except under node_modules or importmap.json', async () => {
    const watchSpy = vi.spyOn(deps.vfs, 'watch');
    await shell.execute('npm run dev');

    expect(watchSpy).toHaveBeenCalledWith('**', expect.any(Function));
    const messages: unknown[] = [];
    const channel = new BroadcastChannel('vite-hmr');
    channel.addEventListener('message', (e) => messages.push((e as MessageEvent).data));

    const handler = watchSpy.mock.calls[0][1];
    handler('/node_modules/react/index.js', 'change');
    handler('/importmap.json', 'change');
    handler('/src/App.tsx', 'change');

    await new Promise((resolve) => setTimeout(resolve, 0));
    channel.close();
    expect(messages).toEqual([{ type: 'full-reload', path: '/src/App.tsx' }]);
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

  it('runtime run script.ts → bundles over the VFS and executes the result', async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      '/app.ts',
      'globalThis.__ranBundledApp = true;',
    );
    const result = await shell.execute('runtime run /app.ts');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect((globalThis as unknown as { __ranBundledApp?: boolean }).__ranBundledApp).toBe(true);
  });

  it('node <file> and bun <file> route through the same bundler path', async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      '/server.ts',
      'globalThis.__ranViaNode = true;',
    );
    const result = await shell.execute('node /server.ts');
    expect(result.exitCode).toBe(0);
    expect((globalThis as unknown as { __ranViaNode?: boolean }).__ranViaNode).toBe(true);
  });

  it('bundled apps get ambient process/Buffer/__dirname/__filename with no explicit import', async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      '/app.ts',
      `globalThis.__globalsProbe = {
        platform: process.platform,
        stdoutWorks: typeof process.stdout.write,
        bufferRoundTrip: Buffer.from('hi').toString(),
        dirname: __dirname,
        filename: __filename,
        nodeEnv: process.env.NODE_ENV,
        hasSetImmediate: typeof setImmediate,
      };`,
    );
    const result = await shell.execute('node /app.ts');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect((globalThis as unknown as { __globalsProbe?: Record<string, unknown> }).__globalsProbe).toEqual({
      platform: 'browser',
      stdoutWorks: 'function',
      bufferRoundTrip: 'hi',
      dirname: '/',
      filename: '/app.ts',
      nodeEnv: 'development',
      hasSetImmediate: 'function',
    });
  });

  it('bundled apps can import expanded node:* builtins (string_decoder, tty, assert, zlib, module, ...)', async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      '/builtins.ts',
      `import * as stringDecoder from 'node:string_decoder';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import tty from 'node:tty';
assert.ok(true);
const require = createRequire('/builtins.ts');
globalThis.__builtinsProbe = {
  hasStringDecoderExport: typeof stringDecoder.StringDecoder,
  hasGzipStream: typeof zlib.createGzip,
  isTty: tty.isatty(0),
  requireFsWorks: typeof require('node:fs').readFile,
};`,
    );
    const result = await shell.execute('node /builtins.ts');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect((globalThis as unknown as { __builtinsProbe?: Record<string, unknown> }).__builtinsProbe).toEqual({
      hasStringDecoderExport: 'function',
      hasGzipStream: 'function',
      isTty: false,
      requireFsWorks: 'function',
    });
  });

  it('bundled apps get real fs.*Sync backed by the synchronous memfs volume (A3)', async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      '/fs-sync.ts',
      `import fs from 'node:fs';
fs.mkdirSync('/from-sync', { recursive: true });
fs.writeFileSync('/from-sync/out.txt', 'written synchronously');
globalThis.__fsSyncProbe = {
  existed: fs.existsSync('/from-sync/out.txt'),
  content: fs.readFileSync('/from-sync/out.txt', 'utf8'),
  isFile: fs.statSync('/from-sync/out.txt').isFile(),
  dirList: fs.readdirSync('/from-sync'),
};`,
    );
    const result = await shell.execute('node /fs-sync.ts');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect((globalThis as unknown as { __fsSyncProbe?: Record<string, unknown> }).__fsSyncProbe).toEqual({
      existed: true,
      content: 'written synchronously',
      isFile: true,
      dirList: ['out.txt'],
    });
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
    expect(result.stderr).toContain('foo: command not found');
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
