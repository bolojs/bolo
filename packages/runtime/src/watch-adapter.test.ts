import { describe, it, expect, vi } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { createWatchAdapter } from './watch-adapter';

describe('createWatchAdapter', () => {
  it('returns a watch function', () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    expect(typeof watch).toBe('function');
  });

  it('returns a Watcher with close method', () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const watcher = watch('/src');
    expect(typeof watcher.close).toBe('function');
    watcher.close();
  });

  it('maps VfsBus "add" event to Node "rename" event', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const listener = vi.fn<(event: 'rename' | 'change', filename: string) => void>();

    const watcher = watch('/src', {}, listener);
    await vfs.writeFile('/src/index.js', 'hello');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('rename', 'index.js');
    watcher.close();
  });

  it('maps VfsBus "unlink" event to Node "rename" event', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const listener = vi.fn<(event: 'rename' | 'change', filename: string) => void>();

    await vfs.writeFile('/src/app.js', 'content');
    const watcher = watch('/src', {}, listener);
    await vfs.rm('/src/app.js');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('rename', 'app.js');
    watcher.close();
  });

  it('extracts basename from full path for listener', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const listener = vi.fn<(event: 'rename' | 'change', filename: string) => void>();

    const watcher = watch('/src/components', {}, listener);
    await vfs.writeFile('/src/components/Button.tsx', 'export default Button');

    expect(listener).toHaveBeenCalledWith('rename', 'Button.tsx');
    watcher.close();
  });

  it('extracts basename from deeply nested paths', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const listener = vi.fn<(event: 'rename' | 'change', filename: string) => void>();

    const watcher = watch('/a/b/c', {}, listener);
    await vfs.writeFile('/a/b/c/d/e/f.ts', 'const x = 1');

    expect(listener).toHaveBeenCalledWith('rename', 'f.ts');
    watcher.close();
  });

  it('stops receiving events after close()', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const listener = vi.fn<(event: 'rename' | 'change', filename: string) => void>();

    const watcher = watch('/src', {}, listener);
    watcher.close();

    await vfs.writeFile('/src/after-close.js', 'noop');

    expect(listener).not.toHaveBeenCalled();
  });

  it('uses exact path as glob for file paths', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const listener = vi.fn<(event: 'rename' | 'change', filename: string) => void>();

    const watcher = watch('/src/index.js', {}, listener);
    await vfs.writeFile('/src/index.js', 'exact match');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('rename', 'index.js');
    watcher.close();
  });

  it('does not fire for non-matching paths when watching a specific file', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const listener = vi.fn<(event: 'rename' | 'change', filename: string) => void>();

    const watcher = watch('/src/index.js', {}, listener);
    await vfs.writeFile('/src/other.js', 'should not trigger');

    expect(listener).not.toHaveBeenCalled();
    watcher.close();
  });

  it('watches recursive with recursive option', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const listener = vi.fn<(event: 'rename' | 'change', filename: string) => void>();

    const watcher = watch('/src', { recursive: true }, listener);
    await vfs.writeFile('/src/deep/nested/file.js', 'nested');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('rename', 'file.js');
    watcher.close();
  });

  it('works without listener callback', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);

    const watcher = watch('/src');
    await vfs.writeFile('/src/no-listener.js', 'ok');
    watcher.close();
  });

  it('handles directory paths ending with slash for recursive glob', async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const listener = vi.fn<(event: 'rename' | 'change', filename: string) => void>();

    const watcher = watch('/src/', { recursive: true }, listener);
    await vfs.writeFile('/src/slash/test.js', 'slash dir');

    expect(listener).toHaveBeenCalledTimes(1);
    watcher.close();
  });
});
