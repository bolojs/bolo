import { describe, it, expect } from 'vitest';
import { VfsBus } from '@bolojs/fs';
import { bundleEntry } from '../src/bundle';

const seed = (vfs: VfsBus, path: string, contents: string) => {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir && !vfs.hot.existsSync(dir)) vfs.hot.mkdirSync(dir, { recursive: true });
  vfs.hot.writeFileSync(path, contents);
};

describe('wasm-registry: builtin sweep (compat-matrix gaps)', () => {
  it('does not collide when a bundled module declares its own Buffer/process/global top-level bindings', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/src/entry.ts',
      [
        'const Buffer = { isBuffer: () => true };',
        'function process() { return "own"; }',
        'const global = { name: "own" };',
        'console.log(Buffer.isBuffer(), process(), global.name);',
      ].join('\n'),
    );

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });
    expect(warnings).toEqual([]);
    // The banner must never claim the well-known names — a `var Buffer` here
    // was a parse-time redeclare error against the module's own binding.
    expect(code).not.toMatch(/\bvar\s+(Buffer|process|global|console)\b/);
    // The module's own bindings survive untouched.
    expect(code).toContain('isBuffer');
  });

  it('rewrites free Buffer references to the banner binding', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/src/entry.ts', 'const ok = typeof Buffer.byteLength === "function"; void ok;');

    const { code } = await bundleEntry('/src/entry.ts', { vfs });
    expect(code).toContain('__bc_Buffer');
  });

  it('routes node:v8 to a registered shim', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/src/entry.ts',
      "import { getHeapStatistics } from 'node:v8'; void getHeapStatistics;",
    );

    const { code, warnings } = await bundleEntry('/src/entry.ts', {
      vfs,
      getShim: (b) => (b === 'v8' ? { getHeapStatistics: () => ({}) } : undefined),
    });

    expect(warnings).toEqual([]);
    expect(code).toContain('getHeapStatistics');
    expect(code).not.toContain('esm.sh');
  });

  it('routes node:http2 to a registered shim', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/src/entry.ts', "import { constants } from 'node:http2'; void constants;");

    const { code, warnings } = await bundleEntry('/src/entry.ts', {
      vfs,
      getShim: (b) =>
        b === 'http2' ? { constants: { HTTP2_HEADER_STATUS: ':status' } } : undefined,
    });

    expect(warnings).toEqual([]);
    expect(code).toContain('constants');
    expect(code).not.toContain('esm.sh');
  });

  it('exposes the Module named export from node:module', async () => {
    const vfs = new VfsBus();
    seed(vfs, '/src/entry.ts', "import { Module } from 'node:module'; void Module;");

    const Module = function () {};
    const { code, warnings } = await bundleEntry('/src/entry.ts', {
      vfs,
      getShim: (b) => (b === 'module' ? { Module, createRequire: () => {} } : undefined),
    });

    expect(warnings).toEqual([]);
    expect(code).toContain('Module');
  });

  it('resolves a browser-field remap whose relative target is rooted at the package dir, not the importer (enhanced-resolve)', async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      '/node_modules/er/package.json',
      JSON.stringify({
        name: 'er',
        main: 'lib/index.js',
        browser: { process: './lib/util/process-browser.js' },
      }),
    );
    seed(vfs, '/node_modules/er/lib/index.js', 'const p = require("process"); module.exports = p;');
    seed(
      vfs,
      '/node_modules/er/lib/util/process-browser.js',
      'module.exports = { browserSwap: true };',
    );
    seed(vfs, '/src/entry.ts', "import er from 'er'; console.log(er);");

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });
    expect(warnings).toEqual([]);
    expect(code).toContain('browserSwap');
  });

  it('resolves a dep through the nested virtual-store node_modules (graceful-fs shape)', async () => {
    const vfs = new VfsBus();
    const store = '/node_modules/.bolo';
    seed(
      vfs,
      `${store}/er@1.0.0/node_modules/er/package.json`,
      JSON.stringify({ name: 'er', main: 'lib/index.js' }),
    );
    seed(
      vfs,
      `${store}/er@1.0.0/node_modules/er/lib/index.js`,
      'import g from "graceful-fs"; export default g;',
    );
    seed(
      vfs,
      `${store}/gfs@4.0.0/node_modules/graceful-fs/package.json`,
      JSON.stringify({ name: 'graceful-fs', main: 'index.js' }),
    );
    seed(
      vfs,
      `${store}/gfs@4.0.0/node_modules/graceful-fs/index.js`,
      'export default { graceful: true };',
    );
    // pnpm-style edge link: er's node_modules/graceful-fs -> gfs store dir
    vfs.hot.symlinkSync(
      `${store}/gfs@4.0.0/node_modules/graceful-fs`,
      `${store}/er@1.0.0/node_modules/graceful-fs`,
      'dir',
    );
    vfs.hot.symlinkSync(`${store}/er@1.0.0/node_modules/er`, '/node_modules/er', 'dir');
    seed(vfs, '/src/entry.ts', 'import g from "er"; console.log(g);');

    const { code, warnings } = await bundleEntry('/src/entry.ts', { vfs });
    expect(warnings).toEqual([]);
    expect(code).toContain('graceful');
  });
});
