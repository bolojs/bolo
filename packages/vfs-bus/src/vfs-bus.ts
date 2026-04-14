import { createFsFromVolume, Volume } from 'memfs';
import { OpfsWorker } from './opfs-worker.js';

export type VfsBusHandler = (event: { type: 'write' | 'delete' | 'rename'; path: string }) => void;
export type WatchHandler = (path: string, event: 'add' | 'change' | 'unlink') => void;

export interface VfsBusMiddleware {
  (ctx: { path: string; operation: string }, next: () => void): void;
}

export interface DirEnt {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

const EVICT_AFTER_MS = 5 * 60 * 1000;

export class VfsBus {
  readonly vol = new Volume();
  readonly hot = createFsFromVolume(this.vol);
  readonly cold = new OpfsWorker();
  private handlers: VfsBusHandler[] = [];
  private watchers: { glob: string; handler: WatchHandler }[] = [];
  private middlewares: VfsBusMiddleware[] = [];
  private accessTimes = new Map<string, number>();
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  use(mw: VfsBusMiddleware) { this.middlewares.push(mw); }

  private runMiddleware(path: string, operation: string, action: () => void) {
    let idx = 0;
    const next = () => {
      if (idx >= this.middlewares.length) action();
      else {
        const mw = this.middlewares[idx++];
        mw({ path, operation }, next);
      }
    };
    next();
  }

  private touchAccessTime(path: string) {
    this.accessTimes.set(path, Date.now());
    this.resetEvictionTimer(path);
  }

  private resetEvictionTimer(path: string) {
    const existing = this.evictionTimers.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => this.evict(path), EVICT_AFTER_MS);
    this.evictionTimers.set(path, timer);
  }

  private async evict(path: string) {
    this.evictionTimers.delete(path);
    this.accessTimes.delete(path);
    if (this.hot.existsSync(path)) {
      try { this.hot.unlinkSync(path); } catch { /* may be dir */ }
    }
  }

  private toUint8Array(content: string | Uint8Array): Uint8Array {
    return content instanceof Uint8Array ? content : new TextEncoder().encode(content);
  }

  async writeFile(path: string, content: string | Uint8Array) {
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir && !this.hot.existsSync(dir)) {
      this.hot.mkdirSync(dir, { recursive: true });
    }
    this.runMiddleware(path, 'writeFile', () => {
      this.hot.writeFileSync(path, content);
    });
    this.touchAccessTime(path);

    try {
      await this.cold.writeFile(path, this.toUint8Array(content));
    } catch { /* cold layer may be unavailable in test envs */ }

    this.emit('write', path);
    this.notifyWatchers(path, 'add');
  }

  async readFile(path: string): Promise<string | Uint8Array> {
    this.touchAccessTime(path);

    if (this.hot.existsSync(path)) {
      return this.hot.readFileSync(path, 'utf8') as string;
    }

    try {
      const data = await this.cold.readFile(path);
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir && !this.hot.existsSync(dir)) {
        this.hot.mkdirSync(dir, { recursive: true });
      }
      this.hot.writeFileSync(path, data);
      this.touchAccessTime(path);
      return data;
    } catch {
      throw new Error(`ENOENT: ${path}`);
    }
  }

  async mkdir(path: string, opts?: { recursive?: boolean }) {
    this.runMiddleware(path, 'mkdir', () => {
      this.hot.mkdirSync(path, { recursive: opts?.recursive ?? false });
    });
    this.touchAccessTime(path);

    try {
      await this.cold.mkdir(path);
    } catch { /* noop: cold layer optional */ }

    this.emit('write', path);
  }

  async rm(path: string, opts?: { recursive?: boolean }) {
    this.runMiddleware(path, 'rm', () => {
      this.hot.rmSync(path, { recursive: opts?.recursive ?? false });
    });
    this.accessTimes.delete(path);
    const timer = this.evictionTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.evictionTimers.delete(path);
    }

    try {
      await this.cold.rm(path);
    } catch { /* noop: cold layer optional */ }

    this.emit('delete', path);
    this.notifyWatchers(path, 'unlink');
  }

  async exists(path: string): Promise<boolean> {
    if (this.hot.existsSync(path)) {
      this.touchAccessTime(path);
      return true;
    }
    try {
      return await this.cold.exists(path);
    } catch {
      return false;
    }
  }

  async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | DirEnt[]> {
    this.touchAccessTime(path);

    if (this.hot.existsSync(path)) {
      if (options?.withFileTypes) {
        const entries = this.hot.readdirSync(path, { withFileTypes: true }) as any[];
        return entries.map(e => ({
          name: e.name,
          isFile: () => e.isFile(),
          isDirectory: () => e.isDirectory(),
        }));
      }
      return this.hot.readdirSync(path) as string[];
    }

    try {
      const entries = await this.cold.readdir(path);
      for (const entry of entries) {
        const fullPath = path === '/' ? `/${entry}` : `${path}/${entry}`;
        try {
          const data = await this.cold.readFile(fullPath);
          this.hot.writeFileSync(fullPath, data);
          this.touchAccessTime(fullPath);
        } catch {
          this.hot.mkdirSync(fullPath, { recursive: true });
          this.touchAccessTime(fullPath);
        }
      }

      if (options?.withFileTypes) {
        const hotEntries = this.hot.readdirSync(path, { withFileTypes: true }) as any[];
        return hotEntries.map(e => ({
          name: e.name,
          isFile: () => e.isFile(),
          isDirectory: () => e.isDirectory(),
        }));
      }

      return entries;
    } catch {
      throw new Error(`ENOENT: ${path}`);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (!this.hot.existsSync(oldPath)) {
      throw Object.assign(new Error(`ENOENT: ${oldPath}`), { code: 'ENOENT' });
    }

    if (this.hot.existsSync(newPath)) {
      throw Object.assign(new Error(`EEXIST: ${newPath}`), { code: 'EEXIST' });
    }

    this.runMiddleware(oldPath, 'rename', () => {
      this.hot.renameSync(oldPath, newPath);
    });

    this.emit('rename', oldPath);
    this.notifyWatchers(oldPath, 'unlink');
    this.notifyWatchers(newPath, 'add');
  }

  on(event: 'write' | 'delete' | 'rename', handler: VfsBusHandler) {
    const wrapped: VfsBusHandler = (e) => { if (e.type === event) handler(e); };
    this.handlers.push(wrapped);
  }

  private emit(type: 'write' | 'delete' | 'rename', path: string) {
    for (const h of this.handlers) h({ type, path });
  }

  watch(glob: string, handler: WatchHandler) {
    this.watchers.push({ glob, handler });
    return { close: () => {
      this.watchers = this.watchers.filter(w => w !== this.watchers.find(w2 => w2.glob === glob && w2.handler === handler));
    }};
  }

  private notifyWatchers(path: string, event: 'add' | 'change' | 'unlink') {
    for (const w of this.watchers) {
      if (this.matchGlob(path, w.glob)) w.handler(path, event);
    }
  }

  private matchGlob(path: string, glob: string): boolean {
    if (glob === '**') return true;
    if (glob.startsWith('*') && glob.endsWith('*')) return path.includes(glob.slice(1, -1));
    if (glob.startsWith('*')) return path.endsWith(glob.slice(1));
    if (glob.endsWith('*')) return path.startsWith(glob.slice(0, -1));
    return path === glob;
  }

  snapshot(): Record<string, any> {
    return this.vol.toJSON();
  }

  restore(snap: Record<string, any>) {
    this.vol.reset();
    this.vol.fromJSON(snap, '/');
  }

  destroy() {
    for (const timer of this.evictionTimers.values()) clearTimeout(timer);
    this.evictionTimers.clear();
    this.accessTimes.clear();
    this.cold.terminate();
  }
}

export const vfsRegistry = new VfsBus();
