import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserContainer, type BrowserContainerDeps } from './container.js';
import type { FileSystemAPI, FileSystemTree } from './container-types.js';
import type { ContainerEvents } from './events.js';
import type { VfsBus } from '@browser-containers/vfs-bus';
import type { MountAPI } from './mount.js';
import type { ExportAPI } from './export.js';
import type { ProcessDeps } from './process.js';

const createMockDeps = (): BrowserContainerDeps => ({
  vfs: {
    destroy: vi.fn(),
  } as unknown as VfsBus,
  fs: {
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    rename: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockReturnValue({ close: vi.fn() }),
  } as unknown as FileSystemAPI,
  events: {
    on: vi.fn().mockReturnValue(() => {}),
    removeAllListeners: vi.fn(),
  } as unknown as ContainerEvents,
  mountApi: {
    mountTree: vi.fn().mockResolvedValue(undefined),
  } as unknown as MountAPI,
  exportApi: {
    exportTree: vi.fn().mockResolvedValue({}),
  } as unknown as ExportAPI,
  processDeps: {
    shell: {
      execute: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    },
    runtimeWorker: {
      runScript: vi.fn().mockResolvedValue(undefined),
      onStdout: null,
      onStderr: null,
      onExit: null,
      dispose: vi.fn(),
    },
    vfs: {
      readFile: vi.fn().mockResolvedValue('code'),
    },
  } as unknown as ProcessDeps,
  workdir: '/home/web',
});

describe('BrowserContainer', () => {
  let deps: BrowserContainerDeps;
  let container: BrowserContainer;

  beforeEach(() => {
    deps = createMockDeps();
    container = new BrowserContainer(deps);
  });

  it('exposes fs and workdir', () => {
    expect(container.fs).toBe(deps.fs);
    expect(container.workdir).toBe('/home/web');
  });

  it('spawn() returns a Process', () => {
    const proc = container.spawn('echo', ['hello']);
    expect(proc).toHaveProperty('exit');
    expect(proc).toHaveProperty('output');
    expect(typeof proc.kill).toBe('function');
  });

  it('spawn() throws after teardown', () => {
    container.teardown();
    expect(() => container.spawn('echo')).toThrow('Container has been torn down');
  });

  it('mount() delegates to mountApi.mountTree()', async () => {
    const tree: FileSystemTree = { 'test.txt': { file: { contents: 'hello' } } };
    await container.mount(tree);
    expect(deps.mountApi.mountTree).toHaveBeenCalledWith(tree, deps.workdir);
  });

  it('mount() throws after teardown', async () => {
    container.teardown();
    await expect(container.mount({})).rejects.toThrow('Container has been torn down');
  });

  it('on("port") delegates to events.on()', () => {
    const listener = vi.fn();
    container.on('port', listener);
    expect(deps.events.on).toHaveBeenCalledWith('port', listener);
  });

  it('on("server-ready") delegates to events.on()', () => {
    const listener = vi.fn();
    container.on('server-ready', listener);
    expect(deps.events.on).toHaveBeenCalledWith('server-ready', listener);
  });

  it('export() delegates to exportApi.exportTree()', async () => {
    const tree: FileSystemTree = { 'a.txt': { file: { contents: 'x' } } };
    vi.mocked(deps.exportApi.exportTree).mockResolvedValue(tree);
    const result = await container.export();
    expect(deps.exportApi.exportTree).toHaveBeenCalledWith(deps.workdir);
    expect(result).toBe(tree);
  });

  it('export() throws after teardown', async () => {
    container.teardown();
    await expect(container.export()).rejects.toThrow('Container has been torn down');
  });

  it('teardown() destroys vfs and removes listeners', async () => {
    await container.teardown();
    expect(deps.events.removeAllListeners).toHaveBeenCalled();
    expect(deps.vfs.destroy).toHaveBeenCalled();
    expect(deps.processDeps.runtimeWorker.dispose).toHaveBeenCalled();
  });

  it('teardown() is idempotent', async () => {
    await container.teardown();
    await container.teardown();
    expect(deps.events.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(deps.vfs.destroy).toHaveBeenCalledTimes(1);
  });
});
