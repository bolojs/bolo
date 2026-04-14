import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { BrowserViteServer } from './browser-vite-server.js';

vi.mock('@sebastianwessel/quickjs', () => ({
  getTypescriptSupport: vi.fn().mockResolvedValue({
    transpileFile: (code: string, _opts?: unknown, _fileName?: string) => {
      let result = code;
      result = result.replace(/:\s*(string|number|boolean|void)\b/g, '');
      result = result.replace(/<\w+>/g, '');
      return result;
    },
  }),
}));

const mockBroadcastChannel = () => {
  const channels = new Map<string, Set<{ postMessage: (msg: unknown) => void }>>();
  return {
    Channel: vi.fn().mockImplementation((name: string) => {
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
    }),
    channels,
  };
};

describe('BrowserViteServer', () => {
  let vfs: VfsBus;
  let bc: ReturnType<typeof mockBroadcastChannel>;

  beforeEach(async () => {
    bc = mockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', bc.Channel);

    vfs = new VfsBus();
    await vfs.mkdir('/project', { recursive: true });
    await vfs.writeFile('/project/index.html', '<html><head></head><body>Hello</body></html>');
    await vfs.writeFile('/project/main.ts', 'const x: string = "hello";\nexport { x };');
    await vfs.writeFile('/project/style.css', 'body { color: red; }');
    await vfs.writeFile('/project/data.json', '{"key": "value"}');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const createServer = async (root?: string) => {
    const server = new BrowserViteServer({ vfs, root });
    await server.start();
    return server;
  };

  it('reads files from VfsBus via transformRequest', async () => {
    const server = await createServer();
    const res = await server.transformRequest('http://localhost/main.ts');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/javascript');
    const body = await res.text();
    expect(body).not.toContain(': string');
    expect(body).toContain('const x = "hello"');
  });

  it('returns 404 for non-existent files', async () => {
    const server = await createServer();
    const res = await server.transformRequest('http://localhost/nonexistent.js');

    expect(res.status).toBe(404);
  });

  it('serves .js files without transformation', async () => {
    await vfs.writeFile('/project/app.js', 'const y = 42;');
    const server = await createServer();
    const res = await server.transformRequest('http://localhost/app.js');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('const y = 42;');
  });

  it('serves CSS with correct content type', async () => {
    const server = await createServer();
    const res = await server.transformRequest('http://localhost/style.css');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/css');
    const body = await res.text();
    expect(body).toBe('body { color: red; }');
  });

  it('serves JSON with correct content type', async () => {
    const server = await createServer();
    const res = await server.transformRequest('http://localhost/data.json');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('onFetch serves index.html at root path', async () => {
    const server = await createServer();
    const req = new Request('http://localhost/');
    const res = await server.onFetch('http://localhost/', req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    const body = await res.text();
    expect(body).toContain('Hello');
  });

  it('onFetch serves index.html at /index.html', async () => {
    const server = await createServer();
    const req = new Request('http://localhost/index.html');
    const res = await server.onFetch('http://localhost/index.html', req);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Hello');
  });

  it('onFetch delegates non-html to transformRequest', async () => {
    const server = await createServer();
    const req = new Request('http://localhost/main.ts');
    const res = await server.onFetch('http://localhost/main.ts', req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/javascript');
  });

  it('transformIndexHtml injects importmap from VFS', async () => {
    await vfs.writeFile('/project/importmap.json', JSON.stringify({
      imports: { react: 'https://esm.sh/react@18' },
    }));

    const server = await createServer();
    const html = '<html><head></head><body></body></html>';
    const result = await server.transformIndexHtml(html);

    expect(result).toContain('<script type="importmap">');
    expect(result).toContain('"react":"https://esm.sh/react@18"');
    expect(result).toContain('</head>');
  });

  it('transformIndexHtml returns html unchanged without importmap', async () => {
    const server = await createServer();
    const html = '<html><head></head><body></body></html>';
    const result = await server.transformIndexHtml(html);

    expect(result).toBe(html);
  });

  it('transformIndexHtml appends importmap before </head>', async () => {
    await vfs.writeFile('/project/importmap.json', '{}');

    const server = await createServer();
    const html = '<html><head><title>Test</title></head><body></body></html>';
    const result = await server.transformIndexHtml(html);

    const headIdx = result.indexOf('</head>');
    const scriptIdx = result.indexOf('<script type="importmap">');
    expect(scriptIdx).toBeLessThan(headIdx);
  });

  it('transformIndexHtml appends importmap at start when no </head>', async () => {
    await vfs.writeFile('/project/importmap.json', '{}');

    const server = await createServer();
    const html = '<div>no head</div>';
    const result = await server.transformIndexHtml(html);

    expect(result.startsWith('<script type="importmap">')).toBe(true);
    expect(result).toContain('<div>no head</div>');
  });

  it('transformIndexHtml ignores invalid importmap.json', async () => {
    await vfs.writeFile('/project/importmap.json', 'not json');

    const server = await createServer();
    const html = '<html><head></head><body></body></html>';
    const result = await server.transformIndexHtml(html);

    expect(result).toBe(html);
  });

  it('uses custom root option', async () => {
    await vfs.mkdir('/custom', { recursive: true });
    await vfs.writeFile('/custom/app.ts', 'const z: number = 1;');

    const server = await createServer('/custom');
    const res = await server.transformRequest('http://localhost/app.ts');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('const z = 1');
  });

  it('broadcastHMR sends via BroadcastChannel', async () => {
    const server = await createServer();
    server.broadcastHmr({ type: 'update', path: '/project/main.ts' });

    expect(bc.Channel).toHaveBeenCalledWith('vite-hmr');
  });

  it('_transformModule throws if server not started', async () => {
    const server = new BrowserViteServer({ vfs });

    await expect(server._transformModule('/test.ts', 'const x: string = "hi"'))
      .rejects.toThrow('not started');
  });

  it('sets Cache-Control: no-cache on responses', async () => {
    const server = await createServer();
    const res = await server.transformRequest('http://localhost/style.css');

    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('stop closes BroadcastChannel', async () => {
    const server = await createServer();
    await server.stop();

    const bcInstance = bc.Channel.mock.results[0].value;
    expect(bcInstance.close).toHaveBeenCalled();
  });
});
