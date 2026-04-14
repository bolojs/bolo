import type { VfsBus } from '@browser-containers/vfs-bus';
import type { Watcher } from './container-types.js';

const VFS_TO_NODE_EVENT: Record<string, 'rename' | 'change'> = {
  add: 'rename',
  change: 'change',
  unlink: 'rename',
};

const isFilePath = (path: string): boolean => {
  const basename = path.split('/').pop() ?? '';
  return basename.includes('.');
};

const pathToGlob = (path: string, recursive: boolean): string => {
  if (isFilePath(path)) {
    return path;
  }

  return `${path.replace(/\/+$/, '')}/*`;
};

export interface WatchOptions {
  recursive?: boolean;
}

export interface WatchFunction {
  (path: string, options?: WatchOptions, listener?: (event: 'rename' | 'change', filename: string) => void): Watcher;
}

export const createWatchAdapter = (vfs: VfsBus): WatchFunction => {
  return (path, options = {}, listener) => {
    const glob = pathToGlob(path, options.recursive ?? false);

    const vfsWatcher = vfs.watch(glob, (changedPath, vfsEvent) => {
      const nodeEvent = VFS_TO_NODE_EVENT[vfsEvent];
      if (!nodeEvent) return;

      const filename = changedPath.split('/').pop() ?? changedPath;
      listener?.(nodeEvent, filename);
    });

    return { close: () => vfsWatcher.close() };
  };
};
