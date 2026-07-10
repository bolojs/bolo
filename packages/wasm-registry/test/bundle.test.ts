import { describe, it, expect } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { bundleEntry, mapJsrSpecifier, transformScript } from '../src/bundle';

const seed = (vfs: VfsBus, path: string, contents: string) => {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir && !vfs.hot.existsSync(dir)) vfs.hot.mkdirSync(dir, { recursive: true });
  vfs.hot.writeFileSync(path, contents);
};

describe('wasm-registry: bundleEntry', () => {
  it('bundles a relative import into a single self-contained module', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/src/util.ts', 'export const greet = (name: string) => `hi ${name}`;');
    seed(vfs, '/src/entry.ts', "import { greet } from './util'; console.log(greet('world'));");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });

    expect(warnings).toEqual([]);
    expect(code).toContain('greet');
    expect(code).not.toMatch(/from\s+["']\.\/util["']/);
  });

  it('resolves a bare package import via package.json main and inlines it', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/node_modules/hono/package.json', JSON.stringify({ name: 'hono', main: 'index.js' }));
    seed(vfs, '/node_modules/hono/index.js', 'export const Hono = class { get() {} };');
    seed(vfs, '/src/entry.ts', "import { Hono } from 'hono'; new Hono();");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });

    expect(warnings).toEqual([]);
    expect(code).toContain('class');
    expect(code).not.toMatch(/from\s+["']hono["']/);
  });

  it('routes a node:* import to the live shim registry via globalThis', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/src/entry.ts', "import fs from 'node:fs'; fs.readFile('/x');");

    const shim = { readFile: () => {} };
    const { code, warnings } = await bundleEntry('/src/entry.ts', {
      vfs,
      getShim: (builtin) => (builtin === 'fs' ? shim : undefined),
    });

    expect(warnings).toEqual([]);
    expect(code).toContain('globalThis.__browserContainers.shims');
    expect(code).not.toMatch(/from\s+["']node:fs["']/);
  });

  it('leaves an unsupported builtin external with a warning instead of failing the build', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/src/entry.ts', "import tls from 'node:tls'; void tls;");

    const { warnings } = await bundleEntry('/src/entry.ts', { vfs, getShim: () => undefined });

    expect(warnings.some((w) => w.includes('node:tls'))).toBe(true);
  });

  it('resolves a package via a nested conditional `exports` map (browser > import > default) (A5)', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/node_modules/pkg/package.json',
      JSON.stringify({
        name: 'pkg',
        exports: {
          '.': {
            browser: { import: './browser.mjs', default: './browser.cjs' },
            node: './node.cjs',
            default: './fallback.js',
          },
        },
      }),
    );
    seed(vfs, '/node_modules/pkg/browser.mjs', 'export const via = "browser-mjs";');
    seed(vfs, '/node_modules/pkg/node.cjs', 'export const via = "node-cjs";');
    seed(vfs, '/src/entry.ts', "import { via } from 'pkg'; console.log(via);");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });

    expect(warnings).toEqual([]);
    expect(code).toContain('browser-mjs');
  });

  it('resolves a wildcard `exports` subpath pattern (A5)', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/node_modules/pkg/package.json',
      JSON.stringify({ name: 'pkg', exports: { './features/*': './src/features/*.js' } }),
    );
    seed(vfs, '/node_modules/pkg/src/features/foo.js', 'export const foo = 1;');
    seed(vfs, '/src/entry.ts', "import { foo } from 'pkg/features/foo'; console.log(foo);");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });

    expect(warnings).toEqual([]);
    // rolldown inlines the exported constant across modules, so the declaration is folded away.
    expect(code).toContain('log(1)');
    expect(code).not.toMatch(/from\s+["']pkg\/features\/foo["']/);
  });

  it('honors a string `browser` field as the main-entry override (A5)', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/node_modules/pkg/package.json',
      JSON.stringify({ name: 'pkg', main: 'node.js', browser: 'browser.js' }),
    );
    seed(vfs, '/node_modules/pkg/node.js', 'export const via = "node";');
    seed(vfs, '/node_modules/pkg/browser.js', 'export const via = "browser";');
    seed(vfs, '/src/entry.ts', "import { via } from 'pkg'; console.log(via);");

    const { code } = await bundleEntry('/src/entry.ts', { vfs });

    expect(code).toContain('"browser"');
    expect(code).not.toContain('"node"');
  });

  it('honors an object `browser` field remap, including stubbing a module to `false` (A5)', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/node_modules/pkg/package.json',
      JSON.stringify({
        name: 'pkg',
        main: 'index.js',
        browser: { './server-only.js': './client-only.js', fs: false },
      }),
    );
    seed(vfs, '/node_modules/pkg/index.js', "import fs from 'fs'; import { via } from './server-only.js'; export const result = { via, hasFs: typeof fs };");
    seed(vfs, '/node_modules/pkg/server-only.js', 'export const via = "server";');
    seed(vfs, '/node_modules/pkg/client-only.js', 'export const via = "client";');
    seed(vfs, '/src/entry.ts', "import { result } from 'pkg'; console.log(result);");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });

    expect(warnings).toEqual([]);
    expect(code).toContain('"client"');
    expect(code).not.toContain('"server"');
  });

  it('resolves a package-internal `#subpath` import via the `imports` field (A5)', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/node_modules/pkg/package.json',
      JSON.stringify({ name: 'pkg', main: 'index.js', imports: { '#dep': './real-dep.js' } }),
    );
    seed(vfs, '/node_modules/pkg/index.js', "export { value } from '#dep';");
    seed(vfs, '/node_modules/pkg/real-dep.js', 'export const value = "resolved-via-imports-field";');
    seed(vfs, '/src/entry.ts', "import { value } from 'pkg'; console.log(value);");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });

    expect(warnings).toEqual([]);
    expect(code).toContain('resolved-via-imports-field');
  });

  it('falls back an unresolvable bare import to an esm.sh URL instead of failing the build (A5)', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/src/entry.ts', "import { z } from 'zod'; void z;");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });

    expect(code).toContain('https://esm.sh/zod');
    expect(warnings.some((w) => w.includes('esm.sh/zod'))).toBe(true);
  });

  it('falls back an uninstalled transitive dep of an installed package to esm.sh, versioned (A5)', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '2.3.4', main: 'index.js' }));
    seed(vfs, '/node_modules/pkg/index.js', "export { helper } from 'pkg/internal';");
    seed(vfs, '/src/entry.ts', "import { helper } from 'pkg'; console.log(helper);");

    const { code } = await bundleEntry('/src/entry.ts', { vfs });

    expect(code).toContain('https://esm.sh/pkg@2.3.4/internal');
  });

  it('routes bundled console.log/error through the injected process shim, not the native console (B4)', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/src/entry.ts', 'console.log("out", 1); console.error("err");');

    const { code } = await bundleEntry('/src/entry.ts', { vfs });

    const stdout: string[] = [];
    const stderr: string[] = [];
    (globalThis as unknown as { __browserContainers: unknown }).__browserContainers = {
      shims: {
        process: {
          stdout: { write: (s: string) => stdout.push(s) },
          stderr: { write: (s: string) => stderr.push(s) },
        },
      },
    };
    try {
      await import(/* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
    } finally {
      delete (globalThis as { __browserContainers?: unknown }).__browserContainers;
    }

    expect(stdout.join('')).toBe('out 1\n');
    expect(stderr.join('')).toBe('err\n');
  });

  it('rewrites a jsr: scoped specifier to the installed @jsr mirror package', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/node_modules/@jsr/scope__name/package.json',
      JSON.stringify({ name: '@jsr/scope__name', main: 'index.js' }),
    );
    seed(vfs, '/node_modules/@jsr/scope__name/index.js', 'export const jsrValue = "from-jsr";');
    seed(vfs, '/src/entry.ts', "import { jsrValue } from 'jsr:@scope/name'; console.log(jsrValue);");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });

    expect(warnings).toEqual([]);
    expect(code).toContain('from-jsr');
    expect(code).not.toMatch(/from\s+["']jsr:/);
  });

  it('rewrites a jsr: unscoped specifier to the installed @jsr mirror package', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/node_modules/@jsr/plain/package.json',
      JSON.stringify({ name: '@jsr/plain', main: 'index.js' }),
    );
    seed(vfs, '/node_modules/@jsr/plain/index.js', 'export const plain = 42;');
    seed(vfs, '/src/entry.ts', "import { plain } from 'jsr:plain'; console.log(plain);");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });

    expect(warnings).toEqual([]);
    expect(code).toContain('42');
    expect(code).not.toMatch(/from\s+["']jsr:/);
  });
});

describe('wasm-registry: mapJsrSpecifier', () => {
  it('maps scoped and unscoped jsr specifiers to the npm-compatibility mirror', () => {
    expect(mapJsrSpecifier('jsr:@scope/name')).toBe('@jsr/scope__name');
    expect(mapJsrSpecifier('jsr:name')).toBe('@jsr/name');
  });

  it('preserves subpaths on the mirror package', () => {
    expect(mapJsrSpecifier('jsr:@scope/name/sub')).toBe('@jsr/scope__name/sub');
    expect(mapJsrSpecifier('jsr:name/sub')).toBe('@jsr/name/sub');
  });
});

describe('wasm-registry: transformScript', () => {
  it('strips TypeScript syntax from a single file with no bundling (A7)', async () => {
    const { code, warnings } = await transformScript('const x: number = 42;\nconst arr: string[] = [];\nx');

    expect(warnings).toEqual([]);
    expect(code).not.toContain(': number');
    expect(code).not.toContain(': string[]');
    expect(code).toContain('const x = 42');
  });

  it('correctly erases a nested object type/interface (A7)', async () => {
    const { code } = await transformScript(
      'interface Config { a: { b: string; c: number }; d: string[] }\nconst cfg: Config = { a: { b: "x", c: 1 }, d: [] };',
    );

    expect(code).not.toMatch(/interface|:\s*Config/);
    expect(code).toContain('b: "x"');
    expect(code).toContain('c: 1');
  });

  it('surfaces a syntax error instead of silently producing broken JS (A7)', async () => {
    await expect(transformScript('const x = ;')).rejects.toThrow();
  });
});
