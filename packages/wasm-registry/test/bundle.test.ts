import { describe, it, expect } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { bundleEntry } from '../src/bundle';

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
});
