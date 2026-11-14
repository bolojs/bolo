// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VfsBus } from '@bolojs/fs';
import { NextDevServer, nextTemplate, type ModuleLoader, type TreeNode } from '@bolojs/next-server';

const writeTree = async (
  vfs: VfsBus,
  tree: Record<string, TreeNode>,
  base: string,
): Promise<void> => {
  for (const [name, node] of Object.entries(tree)) {
    const path = `${base}/${name}`;
    if ('file' in node) {
      await vfs.mkdir(base, { recursive: true });
      await vfs.writeFile(path, node.file.contents);
    } else {
      await vfs.mkdir(path, { recursive: true });
      await writeTree(vfs, node.directory, path);
    }
  }
};

const mockBroadcastChannel = () => {
  const channels = new Map<string, Set<{ postMessage: (msg: unknown) => void }>>();
  return vi.fn().mockImplementation(function (name: string) {
    if (!channels.has(name)) channels.set(name, new Set());
    const listeners = channels.get(name)!;
    return {
      name,
      postMessage: vi.fn((msg: unknown) => {
        for (const l of listeners) l.postMessage(msg);
      }),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });
};

// happy-dom provides `document`, so the server's default loader would try a
// cross-origin dynamic import. Inject the Node-style data: URL loader. The
// jsx-runtime rewrite stubs React so server-executed modules (getStaticProps,
// API routes) import cleanly without a package install.
const JSX_STUB =
  'data:text/javascript,export const jsx=()=>null,jsxs=()=>null,Fragment=Symbol()';
const dataUrlLoader: ModuleLoader = {
  load: async (_servedPath, code) =>
    (await import(
      /* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(
        code.replace(/from "react\/jsx-runtime"/g, `from "${JSX_STUB}"`),
      )}`
    )) as Record<string, unknown>,
};

describe('Integration: NextDevServer onFetch against a VfsBus (happy-dom)', () => {
  let vfs: VfsBus;

  beforeEach(async () => {
    vi.stubGlobal('BroadcastChannel', mockBroadcastChannel());
    vfs = new VfsBus();
    await writeTree(vfs, nextTemplate, '/home/web');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const createServer = async () => {
    const server = new NextDevServer({
      vfs,
      root: '/home/web',
      base: '/__next',
      moduleLoader: dataUrlLoader,
    });
    await server.start();
    return server;
  };

  it('assembles the document shell for the index route', async () => {
    const server = await createServer();
    const res = await server.onFetch('https://sandbox.local/__next/', new Request('https://sandbox.local/__next/'));
    expect(res?.status).toBe(200);
    expect(res?.headers.get('Content-Type')).toBe('text/html');
    const html = await res!.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<div id="__next"></div>');
    expect(html).toContain('/__next/_bolo/entry');
    expect(html).toContain('import { boot } from');
  });

  it('serves the dynamic blog route with getStaticProps embedded', async () => {
    const server = await createServer();
    const res = await server.onFetch(
      'https://sandbox.local/__next/blog/7',
      new Request('https://sandbox.local/__next/blog/7'),
    );
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain('boot("/blog/7"');
    expect(html).toContain('{"title":"Post #7"}');
  });

  it('serves compiled page modules the browser entry imports', async () => {
    const server = await createServer();
    const res = await server.onFetch(
      'https://sandbox.local/__next/_pages/index.js',
      new Request('https://sandbox.local/__next/_pages/index.js'),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get('Content-Type')).toBe('application/javascript');
    const body = await res!.text();
    expect(body).toContain('react/jsx-runtime');
    expect(body).toContain('/__next/_bolo/shims/head.js');
    expect(body).toContain('/__next/_bolo/shims/link.js');
  });

  it('generates an entry module wiring _app and the page into boot()', async () => {
    const server = await createServer();
    const res = await server.onFetch(
      'https://sandbox.local/__next/_bolo/entry?page=/__next/_pages/index.js&app=/__next/_pages/_app.js',
      new Request('https://sandbox.local/__next/_bolo/entry'),
    );
    const code = await res!.text();
    expect(code).toContain('export async function boot(');
    expect(code).toContain('import App from "/__next/_pages/_app.js"');
    expect(code).toContain('import Page from "/__next/_pages/index.js"');
    expect(code).toContain('createRoot(document.getElementById("__next"))');
  });

  it('serves the API route JSON through onFetch', async () => {
    const server = await createServer();
    const res = await server.onFetch(
      'https://sandbox.local/__next/api/hello',
      new Request('https://sandbox.local/__next/api/hello'),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get('Content-Type')).toBe('application/json');
    const body = JSON.parse(await res!.text());
    expect(body.message).toContain('bolo Next API');
  });

  it('returns 404 for unknown routes and null outside the base', async () => {
    const server = await createServer();
    const res = await server.onFetch(
      'https://sandbox.local/__next/definitely/not/a/route',
      new Request('https://sandbox.local/__next/definitely/not/a/route'),
    );
    expect(res?.status).toBe(404);
    const outside = await server.onFetch('https://sandbox.local/__preview/', new Request('https://sandbox.local/__preview/'));
    expect(outside).toBeNull();
  });

  it('serves globals.css from the styles directory', async () => {
    const server = await createServer();
    const res = await server.onFetch(
      'https://sandbox.local/__next/styles/globals.css',
      new Request('https://sandbox.local/__next/styles/globals.css'),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get('Content-Type')).toBe('text/css');
  });
});
