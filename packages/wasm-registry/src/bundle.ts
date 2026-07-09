import type { VfsBus } from '@browser-containers/vfs-bus';
import type { Plugin } from 'esbuild-wasm';
import { initEsbuild } from './index.js';

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

const LOADER_BY_EXT: Record<string, 'ts' | 'tsx' | 'js' | 'jsx' | 'json'> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
};

// Builtins with a browser shim available somewhere in the host realm (either
// stateless, from `node-web-shims`, or host-bound, from `node-runtime-shims`).
// Resolution of the *live* value happens via `getShim` at bundle time — this
// package only knows the builtin's name, not its implementation.
const NODE_BUILTIN_NAMES = new Set([
  'fs',
  'http',
  'net',
  'child_process',
  'path',
  'buffer',
  'url',
  'crypto',
  'os',
  'events',
  'stream',
  'util',
  'async_hooks',
  'querystring',
  'worker_threads',
]);

const VALID_JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface BundleEntryOptions {
  readonly vfs: VfsBus;
  /** Working directory used to resolve the entry point; defaults to `/`. */
  readonly cwd?: string;
  /**
   * Returns the live shim instance (a plain object of its module exports) for
   * a node builtin name (without the `node:` prefix), or `undefined` if this
   * host realm has no shim for it — the import is then left external with a
   * warning rather than failing the whole bundle.
   */
  readonly getShim?: (builtin: string) => Record<string, unknown> | undefined;
}

export interface BundleEntryResult {
  readonly code: string;
  readonly warnings: string[];
}

const dirname = (path: string): string => {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
};

const extname = (path: string): string => {
  const dotIdx = path.lastIndexOf('.');
  const slashIdx = path.lastIndexOf('/');
  return dotIdx > slashIdx ? path.slice(dotIdx) : '';
};

const joinPath = (...parts: string[]): string => {
  const segments: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return `/${segments.join('/')}`;
};

const isFile = (vfs: VfsBus, path: string): boolean => {
  try {
    return vfs.hot.statSync(path).isFile();
  } catch {
    return false;
  }
};

const resolveFile = (vfs: VfsBus, base: string): string | undefined => {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    if (vfs.hot.existsSync(candidate) && isFile(vfs, candidate)) return candidate;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (ext === '') continue;
    const candidate = joinPath(base, 'index' + ext);
    if (vfs.hot.existsSync(candidate) && isFile(vfs, candidate)) return candidate;
  }
  return undefined;
};

const findPackageDir = (vfs: VfsBus, fromDir: string, name: string): string | undefined => {
  let dir = fromDir;
  for (;;) {
    const candidate = joinPath(dir, 'node_modules', name);
    if (vfs.hot.existsSync(candidate)) return candidate;
    if (dir === '/') return undefined;
    dir = dirname(dir);
  }
};

const readPackageJson = (vfs: VfsBus, pkgDir: string): Record<string, unknown> => {
  const pkgJsonPath = joinPath(pkgDir, 'package.json');
  if (!vfs.hot.existsSync(pkgJsonPath)) return {};
  return JSON.parse(vfs.hot.readFileSync(pkgJsonPath, 'utf8') as string);
};

const exportTargetToPath = (target: unknown): string | undefined => {
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object') {
    const t = target as Record<string, unknown>;
    return exportTargetToPath(t.browser ?? t.import ?? t.default ?? t.require);
  }
  return undefined;
};

const resolveBarePackage = (vfs: VfsBus, fromDir: string, specifier: string): string | undefined => {
  const isScoped = specifier.startsWith('@');
  const parts = specifier.split('/');
  const name = isScoped ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = (isScoped ? parts.slice(2) : parts.slice(1)).join('/');
  const pkgDir = findPackageDir(vfs, fromDir, name);
  if (!pkgDir) return undefined;

  const pkgJson = readPackageJson(vfs, pkgDir);
  const exportsMap = pkgJson.exports as unknown;

  if (subpath) {
    if (exportsMap && typeof exportsMap === 'object') {
      const map = exportsMap as Record<string, unknown>;
      const target = map[`./${subpath}`] ?? map['./*'];
      const targetPath = exportTargetToPath(target)?.replace('*', subpath);
      if (targetPath) {
        const resolved = resolveFile(vfs, joinPath(pkgDir, targetPath));
        if (resolved) return resolved;
      }
    }
    return resolveFile(vfs, joinPath(pkgDir, subpath));
  }

  if (exportsMap) {
    const dotExport =
      typeof exportsMap === 'string' ? exportsMap : (exportsMap as Record<string, unknown>)['.'] ?? exportsMap;
    const targetPath = exportTargetToPath(dotExport);
    if (targetPath) {
      const resolved = resolveFile(vfs, joinPath(pkgDir, targetPath));
      if (resolved) return resolved;
    }
  }

  const mainField = (pkgJson.module as string) ?? (pkgJson.main as string) ?? 'index.js';
  return resolveFile(vfs, joinPath(pkgDir, mainField)) ?? resolveFile(vfs, joinPath(pkgDir, 'index'));
};

const vfsPlugin = (vfs: VfsBus): Plugin => ({
  name: 'browser-containers-vfs',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const importerDir = args.importer ? dirname(args.importer) : args.resolveDir || '/';
      const resolved =
        args.path.startsWith('.') || args.path.startsWith('/')
          ? resolveFile(vfs, args.path.startsWith('/') ? args.path : joinPath(importerDir, args.path))
          : resolveBarePackage(vfs, importerDir, args.path);

      if (!resolved) {
        return { errors: [{ text: `Cannot resolve module "${args.path}" from "${args.importer || '<entry>'}"` }] };
      }
      return { path: resolved, namespace: 'browser-containers-vfs' };
    });

    build.onLoad({ filter: /.*/, namespace: 'browser-containers-vfs' }, (args) => {
      const contents = vfs.hot.readFileSync(args.path, 'utf8') as string;
      const loader = LOADER_BY_EXT[extname(args.path)] ?? 'js';
      const resolveDir = dirname(args.path);
      // CJS-style implicit globals — esbuild only auto-defines these for
      // `format: 'cjs'` output; our bundle is ESM, so each module gets its
      // own `__dirname`/`__filename` consts prepended (harmless before
      // `import`/`export` declarations, which are hoisted regardless of
      // source position).
      if (loader === 'json') return { contents, loader, resolveDir };
      const prelude = `const __filename=${JSON.stringify(args.path)};const __dirname=${JSON.stringify(resolveDir)};\n`;
      return { contents: prelude + contents, loader, resolveDir };
    });
  },
});

// Injected into every module via esbuild's `inject` so bare references to
// `process`/`Buffer`/`global`/`setImmediate` (never explicitly imported —
// the overwhelming majority of CJS/npm code assumes they're ambient) resolve
// without every package needing an explicit `require('node:process')`.
// Reads `globalThis.__browserContainers` at module-eval time, which
// `ShellService.runNodeApp` populates just before importing the bundle.
const GLOBALS_PRELUDE_PATH = 'browser-containers-globals-prelude';
const GLOBALS_PRELUDE_NAMESPACE = 'browser-containers-globals-prelude';
const GLOBALS_PRELUDE_SOURCE = `
const __bcGlobals = () => globalThis.__browserContainers;
export const process = __bcGlobals()?.shims?.process;
export const Buffer = __bcGlobals()?.shims?.buffer?.Buffer;
export const global = globalThis;
export const setImmediate = (fn, ...args) => { queueMicrotask(() => fn(...args)); return 0; };
export const clearImmediate = () => {};
`;

const globalsPreludePlugin = (): Plugin => ({
  name: 'browser-containers-globals-prelude',
  setup(build) {
    build.onResolve({ filter: new RegExp(`^${GLOBALS_PRELUDE_PATH}$`) }, (args) => ({
      path: args.path,
      namespace: GLOBALS_PRELUDE_NAMESPACE,
    }));
    build.onLoad({ filter: /.*/, namespace: GLOBALS_PRELUDE_NAMESPACE }, () => ({
      contents: GLOBALS_PRELUDE_SOURCE,
      loader: 'js',
    }));
  },
});

const nodeAliasPlugin = (getShim?: (builtin: string) => Record<string, unknown> | undefined): Plugin => ({
  name: 'browser-containers-node-alias',
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path.slice('node:'.length),
      namespace: 'browser-containers-node-shim',
    }));

    build.onResolve({ filter: /.*/ }, (args) => {
      if (!NODE_BUILTIN_NAMES.has(args.path)) return undefined;
      return { path: args.path, namespace: 'browser-containers-node-shim' };
    });

    build.onLoad({ filter: /.*/, namespace: 'browser-containers-node-shim' }, (args) => {
      const shim = getShim?.(args.path);
      if (!shim) {
        return {
          contents: `throw new Error(${JSON.stringify(
            `Unsupported node builtin "node:${args.path}" — no browser shim is registered for it.`,
          )});`,
          loader: 'js',
          warnings: [{ text: `no browser shim registered for node builtin "node:${args.path}"` }],
        };
      }
      const keys = Object.keys(shim).filter((k) => VALID_JS_IDENTIFIER.test(k));
      const contents = [
        `const __shim = globalThis.__browserContainers.shims[${JSON.stringify(args.path)}];`,
        'export default __shim;',
        ...keys.map((k) => `export const ${k} = __shim[${JSON.stringify(k)}];`),
      ].join('\n');
      return { contents, loader: 'js' };
    });
  },
});

export const bundleEntry = async (entry: string, options: BundleEntryOptions): Promise<BundleEntryResult> => {
  const esbuild = await initEsbuild();
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    absWorkingDir: options.cwd ?? '/',
    plugins: [globalsPreludePlugin(), nodeAliasPlugin(options.getShim), vfsPlugin(options.vfs)],
    inject: [GLOBALS_PRELUDE_PATH],
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
      'process.browser': 'true',
    },
    logLevel: 'silent',
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error(`esbuild produced no output for entry "${entry}"`);
  }

  return { code: outputFile.text, warnings: result.warnings.map((w) => w.text) };
};
