/**
 * Public API types for the browser-containers `boot()` API.
 *
 * Mirrors a WebContainers-compatible subset with explicit v1.0 scope limits
 * (no symlinks, no stat/lstat, no stdin).
 */

// ── Boot options ──────────────────────────────────────────────────────

export interface BootOptions {
  coep?: "require-corp" | "credentialless" | "none";
  workdirName?: string;
  forwardPreviewErrors?: boolean | "exceptions-only";
}

// ── Virtual filesystem tree ───────────────────────────────────────────

export type FileSystemTree = Record<string, FileNode | DirectoryNode>;

export interface FileNode {
  file: { contents: string | Uint8Array | ReadableStream<Uint8Array> };
}

export interface DirectoryNode {
  directory: FileSystemTree;
}

// ── Container API ─────────────────────────────────────────────────────

export interface BrowserContainer {
  readonly fs: FileSystemAPI;
  readonly workdir: string;
  spawn(command: string, args?: string[], options?: SpawnOptions): Process;
  mount(tree: FileSystemTree): Promise<void>;
  on(event: "port", listener: PortListener): Unsubscribe;
  on(event: "server-ready", listener: ServerReadyListener): Unsubscribe;
  export(): Promise<FileSystemTree>;
  teardown(): Promise<void>;
}

// ── Filesystem API (fs.promises style) ────────────────────────────────

export interface FileSystemAPI {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | DirEnt[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  watch(
    path: string,
    options?: { recursive?: boolean },
    listener?: (event: "rename" | "change", filename: string) => void,
  ): Watcher;
}

export interface DirEnt {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

// ── Process handle ────────────────────────────────────────────────────

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  httpShimOptions?: { onPortEvent?: (event: string, data: { port: number; url?: string }) => void };
}

export interface Process {
  exit: Promise<number>;
  output: ReadableStream<string>;
  kill(): void;
}

// ── Watcher ───────────────────────────────────────────────────────────

export interface Watcher {
  close(): void;
}

// ── Event listeners ───────────────────────────────────────────────────

export type PortListener = (port: number, type: "open" | "close", url: string) => void;
export type ServerReadyListener = (port: number, url: string) => void;
export type Unsubscribe = () => void;
