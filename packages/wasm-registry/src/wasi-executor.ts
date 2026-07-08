import {
  WASI,
  File,
  Directory,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
  type Inode,
} from '@bjorn3/browser_wasi_shim';
import type { VfsBus } from '@browser-containers/vfs-bus';
import type { WasmTool, WasmToolResult } from './registry.js';

export interface WasiPreopen {
  /** Path as seen inside the WASI guest, e.g. "/" or "/work". */
  guestPath: string;
  /** Path inside VfsBus to mount at `guestPath`. Defaults to `guestPath`. */
  hostPath?: string;
}

export interface WasiToolOptions {
  vfs: VfsBus;
  /** Defaults to a single preopen mounting VfsBus "/" at guest "/". */
  preopens?: WasiPreopen[];
  env?: Record<string, string>;
  /** argv[0] as seen by the guest program. Defaults to the tool name. */
  programName?: string;
}

const DEFAULT_PREOPENS: WasiPreopen[] = [{ guestPath: '/' }];

/**
 * wasm32-wasip1 syscalls are synchronous (no Asyncify), so each preopen is
 * hydrated from VfsBus's synchronous `hot` (memfs) tier immediately before
 * the module runs, and flushed back immediately after — a snapshot scoped to
 * exactly one exec(), not a long-lived mirror that can drift.
 */
const buildTree = (vfs: VfsBus, hostRoot: string): Map<string, Inode> => {
  const tree = new Map<string, Inode>();
  let entries: string[];
  try {
    entries = vfs.hot.readdirSync(hostRoot) as string[];
  } catch {
    return tree;
  }

  for (const name of entries) {
    const childPath = hostRoot === '/' ? `/${name}` : `${hostRoot}/${name}`;
    const stat = vfs.hot.statSync(childPath);
    if (stat.isDirectory()) {
      tree.set(name, new Directory(buildTree(vfs, childPath)));
    } else {
      const data = vfs.hot.readFileSync(childPath) as Buffer;
      tree.set(name, new File(new Uint8Array(data)));
    }
  }
  return tree;
};

const flushTree = (vfs: VfsBus, hostRoot: string, tree: Map<string, Inode>): void => {
  if (!vfs.hot.existsSync(hostRoot)) {
    vfs.hot.mkdirSync(hostRoot, { recursive: true });
  }
  for (const [name, inode] of tree) {
    const childPath = hostRoot === '/' ? `/${name}` : `${hostRoot}/${name}`;
    if (inode instanceof Directory) {
      if (!vfs.hot.existsSync(childPath)) vfs.hot.mkdirSync(childPath, { recursive: true });
      flushTree(vfs, childPath, inode.contents);
    } else if (inode instanceof File) {
      vfs.hot.writeFileSync(childPath, Buffer.from(inode.data));
    }
  }
};

const concatChunks = (chunks: Uint8Array[]): string => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
};

/**
 * Generic loader for any wasm32-wasip1 binary: filesystem (via VfsBus-backed
 * preopens) and args/env only — no sockets, threads, or fork (that's WASIX,
 * explicitly out of scope).
 */
export const createWasiTool = (
  loadModule: () => Promise<BufferSource | WebAssembly.Module>,
  options: WasiToolOptions,
  toolName = 'wasi-tool',
): WasmTool => {
  return {
    async run(args: string[], stdin?: string): Promise<WasmToolResult> {
      const preopens = options.preopens ?? DEFAULT_PREOPENS;
      const trees = preopens.map((p) => buildTree(options.vfs, p.hostPath ?? p.guestPath));

      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];

      const fds = [
        new OpenFile(new File(new TextEncoder().encode(stdin ?? ''))),
        new ConsoleStdout((buf) => stdoutChunks.push(buf)),
        new ConsoleStdout((buf) => stderrChunks.push(buf)),
        ...preopens.map((p, i) => new PreopenDirectory(p.guestPath, trees[i])),
      ];

      const env = Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`);
      const wasi = new WASI([options.programName ?? toolName, ...args], env, fds, { debug: false });

      let exitCode: number;
      try {
        const source = await loadModule();
        const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
        const instance = await WebAssembly.instantiate(module, {
          wasi_snapshot_preview1: wasi.wasiImport,
        });
        exitCode = wasi.start(instance as unknown as { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
      } catch (err) {
        return {
          stdout: concatChunks(stdoutChunks),
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }

      preopens.forEach((p, i) => flushTree(options.vfs, p.hostPath ?? p.guestPath, trees[i]));

      return {
        stdout: concatChunks(stdoutChunks),
        stderr: concatChunks(stderrChunks),
        exitCode,
      };
    },
  };
};
