import type { VfsBus } from '@browser-containers/vfs-bus';
import * as ts from 'typescript';

const TRANSFORMABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

export interface BrowserViteServerOptions {
  readonly vfs: VfsBus;
  readonly root?: string;
  readonly hmrChannelName?: string;
  /** URL prefix this server is mounted at (e.g. `/__preview`), used to rewrite
   * root-relative `src`/`href` attributes in served HTML so they stay under
   * the prefix a proxy (service worker) is matching on. Empty by default. */
  readonly base?: string;
}

interface TranspileResult {
  readonly transpileFile: (code: string, _compilerOptions?: unknown, fileName?: string) => string;
}

export class BrowserViteServer {
  private readonly vfs: VfsBus;
  private readonly root: string;
  private readonly base: string;
  private readonly channel: BroadcastChannel;
  private transpiler?: TranspileResult;

  constructor(options: BrowserViteServerOptions) {
    this.vfs = options.vfs;
    this.root = options.root ?? '/project';
    this.base = options.base?.replace(/\/$/, '') ?? '';
    this.channel = new BroadcastChannel(options.hmrChannelName ?? 'vite-hmr');
  }

  async start(): Promise<void> {
    const compilerOptions: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      allowJs: true,
      skipLibCheck: true,
      esModuleInterop: true,
      strict: false,
      allowSyntheticDefaultImports: true,
      jsx: ts.JsxEmit.ReactJSX,
    };
    this.transpiler = {
      transpileFile: (code, _compilerOptions, fileName) =>
        ts.transpile(code, compilerOptions, fileName),
    };
  }

  async stop(): Promise<void> {
    this.channel.close();
  }

  async _transformModule(filePath: string, code: string): Promise<string> {
    if (!this.transpiler) {
      throw new Error('BrowserViteServer not started. Call start() first.');
    }
    return this.transpiler.transpileFile(code, undefined, filePath);
  }

  async transformRequest(url: string): Promise<Response> {
    const filePath = this.resolveUrl(url);

    try {
      const exists = await this.vfs.exists(filePath);
      if (!exists) {
        return new Response(`Not found: ${filePath}`, { status: 404 });
      }

      const raw = await this.vfs.readFile(filePath);
      const code = raw as string;
      const ext = this.getExtension(filePath);

      if (TRANSFORMABLE_EXTENSIONS.has(ext) && ext !== '.js') {
        const transformed = await this._transformModule(filePath, code);
        return new Response(transformed, {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript',
            'Cache-Control': 'no-cache',
          },
        });
      }

      const contentType = this.getContentType(filePath);
      return new Response(code, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Transform error: ${message}`, { status: 500 });
    }
  }

  async transformIndexHtml(html: string): Promise<string> {
    if (this.base) {
      html = html.replace(/(\s(?:src|href)=")\/(?!\/)/g, `$1${this.base}/`);
    }

    try {
      const importMapPath = `${this.root}/importmap.json`;
      const exists = await this.vfs.exists(importMapPath);

      if (exists) {
        const raw = await this.vfs.readFile(importMapPath);
        const importMapJson = raw as string;

        JSON.parse(importMapJson);

        const scriptTag = `<script type="importmap">${importMapJson}</script>`;
        if (html.includes('</head>')) {
          return html.replace('</head>', `${scriptTag}\n</head>`);
        }
        return `${scriptTag}\n${html}`;
      }
    } catch {
      // importmap missing or invalid — serve html as-is
    }

    return html;
  }

  async onFetch(url: string, _request: Request): Promise<Response> {
    const parsed = new URL(url);

    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
      const indexPath = `${this.root}/index.html`;
      const exists = await this.vfs.exists(indexPath);

      if (exists) {
        const raw = await this.vfs.readFile(indexPath);
        const html = raw as string;
        const injected = await this.transformIndexHtml(html);
        return new Response(injected, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
    }

    return this.transformRequest(url);
  }

  broadcastHmr(event: { type: string; path: string }): void {
    this.channel.postMessage(event);
  }

  private resolveUrl(url: string): string {
    const parsed = new URL(url);
    let pathname = parsed.pathname;

    if (pathname.startsWith('/')) {
      pathname = pathname.slice(1);
    }

    if (pathname.startsWith(this.root)) {
      return pathname;
    }

    return `${this.root}/${pathname}`;
  }

  private getExtension(filePath: string): string {
    const dotIdx = filePath.lastIndexOf('.');
    if (dotIdx === -1) return '';
    const slashIdx = filePath.lastIndexOf('/');
    if (dotIdx < slashIdx) return '';
    return filePath.slice(dotIdx);
  }

  private getContentType(filePath: string): string {
    const ext = this.getExtension(filePath);
    const map: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.txt': 'text/plain',
    };
    return map[ext] ?? 'application/octet-stream';
  }
}
