import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { NextDevServer, type ModuleLoader } from "./next-dev-server.js";
import { NEXT_SHIMS } from "./shims.js";
import { nextTemplate } from "./template.js";
import type { TreeNode } from "./template.js";

const mockBroadcastChannel = () => {
  const channels = new Map<string, Set<{ postMessage: (msg: unknown) => void }>>();
  return {
    Channel: vi.fn().mockImplementation(function (name: string) {
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

/** Loader that executes the compiled source through a data: URL import,
 * exactly like the server's default non-DOM path. */
const dataUrlLoader: ModuleLoader = {
  load: async (_servedPath, code) => {
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
    return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  },
};

const writeTree = async (
  vfs: VfsBus,
  tree: Record<string, TreeNode>,
  base: string,
): Promise<void> => {
  for (const [name, node] of Object.entries(tree)) {
    const path = `${base}/${name}`;
    if ("file" in node) {
      await vfs.mkdir(base, { recursive: true });
      await vfs.writeFile(path, node.file.contents);
    } else {
      await vfs.mkdir(path, { recursive: true });
      await writeTree(vfs, node.directory, path);
    }
  }
};

describe("NextDevServer", () => {
  let vfs: VfsBus;
  let bc: ReturnType<typeof mockBroadcastChannel>;

  beforeEach(async () => {
    bc = mockBroadcastChannel();
    vi.stubGlobal("BroadcastChannel", bc.Channel);

    vfs = new VfsBus();
    await vfs.mkdir("/project/pages/api", { recursive: true });
    await vfs.writeFile("/project/pages/_app.tsx", "export default function App() {}");
    await vfs.writeFile(
      "/project/pages/index.tsx",
      "export default function Home() { return <h1>Home page</h1>; }",
    );
    await vfs.writeFile(
      "/project/pages/about.tsx",
      "export default function About() { return <h1>About page</h1>; }",
    );
    await vfs.writeFile(
      "/project/pages/blog/[id].tsx",
      `export default function Post({ title }: { title: string }) {
  return "Post: " + title;
}
export async function getStaticProps({ params }: { params: { id: string } }) {
  return { props: { title: "Post #" + params.id } };
}`,
    );
    await vfs.writeFile(
      "/project/pages/api/hello.ts",
      `export default function handler(req: { method: string }, res: any) {
  res.status(200).json({ method: req.method, message: "hi" });
}`,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const createServer = async () => {
    const server = new NextDevServer({
      vfs,
      root: "/project",
      base: "/__next",
      moduleLoader: dataUrlLoader,
    });
    await server.start();
    return server;
  };

  it("serves an assembled html shell for a page route", async () => {
    const server = await createServer();
    const res = await server.onFetch("https://x/__next/", new Request("https://x/__next/"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("text/html");
    const html = await res!.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<div id="__next"></div>');
    expect(html).toContain("/__next/_bolo/entry");
    expect(html).toContain("/__next/_pages/index.js");
  });

  it("runs getStaticProps and embeds the props", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://x/__next/blog/42",
      new Request("https://x/__next/blog/42"),
    );
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain('boot("/blog/42"');
    expect(html).toContain('{"title":"Post #42"}');
  });

  it("returns 404 for unknown routes", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://x/__next/nope/deep",
      new Request("https://x/__next/nope/deep"),
    );
    expect(res?.status).toBe(404);
  });

  it("serves compiled page modules under /_pages/", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://x/__next/_pages/index.js",
      new Request("https://x/__next/_pages/index.js"),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("application/javascript");
    const body = await res!.text();
    expect(body).not.toContain("export default function Home() { return <h1>");
    expect(body).toContain("jsx");
  });

  it("executes api routes via the module loader", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://x/__next/api/hello",
      new Request("https://x/__next/api/hello", { method: "GET" }),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("application/json");
    const body = await res!.text();
    expect(JSON.parse(body)).toEqual({ method: "GET", message: "hi" });
  });

  it("serves next/* shims", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://x/__next/_bolo/shims/head.js",
      new Request("https://x/__next/_bolo/shims/head.js"),
    );
    expect(res?.status).toBe(200);
    expect(await res!.text()).toBe(NEXT_SHIMS.head);
  });

  it("serves static assets from public/ then root", async () => {
    await vfs.mkdir("/project/public", { recursive: true });
    await vfs.writeFile("/project/public/favicon.ico", "ico");
    await vfs.writeFile("/project/styles/globals.css", "body{}");
    const server = await createServer();

    const ico = await server.onFetch(
      "https://x/__next/favicon.ico",
      new Request("https://x/__next/favicon.ico"),
    );
    expect(ico?.status).toBe(200);
    expect(await ico!.text()).toBe("ico");

    const css = await server.onFetch(
      "https://x/__next/styles/globals.css",
      new Request("https://x/__next/styles/globals.css"),
    );
    expect(css?.headers.get("Content-Type")).toBe("text/css");
  });

  it("returns null for paths outside its base", async () => {
    const server = await createServer();
    const res = await server.onFetch("https://x/other", new Request("https://x/other"));
    expect(res).toBeNull();
  });

  it("rewrites next/* imports in compiled pages to shims", async () => {
    await vfs.writeFile(
      "/project/pages/uses-next.tsx",
      'import Head from "next/head";\nexport default function P() { return <Head><title>t</title></Head>; }',
    );
    const server = await createServer();
    const res = await server.onFetch(
      "https://x/__next/_pages/uses-next.js",
      new Request("https://x/__next/_pages/uses-next.js"),
    );
    const body = await res!.text();
    expect(body).toContain("/__next/_bolo/shims/head.js");
    expect(body).not.toMatch(/from ["']next\/head["']/);
  });

  it("generated entry imports the page and _app and exports boot", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://x/__next/_bolo/entry?page=%2F__next%2F_pages%2Findex.js&app=%2F__next%2F_pages%2F_app.js",
      new Request("https://x/__next/_bolo/entry"),
    );
    const body = await res!.text();
    expect(body).toContain('import App from "/__next/_pages/_app.js"');
    expect(body).toContain('import Page from "/__next/_pages/index.js"');
    expect(body).toContain("export async function boot(");
  });

  it("entry falls back to an inline App without _app", async () => {
    await vfs.rm("/project/pages/_app.tsx");
    const server = await createServer();
    const res = await server.onFetch(
      "https://x/__next/_bolo/entry?page=%2Fp",
      new Request("https://x/__next/_bolo/entry?page=%2Fp"),
    );
    const body = await res!.text();
    expect(body).toContain("const App = ({ Component, pageProps })");
  });

  it("serves an importmap-rewritten exec variant of page modules", async () => {
    await vfs.writeFile(
      "/project/importmap.json",
      JSON.stringify({
        imports: { react: "https://esm.sh/react@19", "react/": "https://esm.sh/react@19/" },
      }),
    );
    const server = await createServer();
    const res = await server.onFetch(
      "https://x/__next/_pages/index.js?exec=1",
      new Request("https://x/__next/_pages/index.js?exec=1"),
    );
    expect(res?.status).toBe(200);
    const body = await res!.text();
    expect(body).toContain('from "https://esm.sh/react@19/jsx-runtime"');
    // The plain variant keeps the bare specifier for the document importmap.
    const plain = await server.onFetch(
      "https://x/__next/_pages/index.js",
      new Request("https://x/__next/_pages/index.js"),
    );
    expect(await plain!.text()).toContain('from "react/jsx-runtime"');
  });

  it("broadcastHmr posts full-reload on the next-hmr channel", async () => {
    const server = await createServer();
    server.broadcastHmr({ type: "full-reload", path: "/project/pages/index.tsx" });
    expect(bc.Channel).toHaveBeenCalledWith("next-hmr");
  });

  it("handleHmr broadcasts a reload for a changed path", async () => {
    const server = await createServer();
    server.handleHmr("/project/pages/index.tsx");
    const instance = bc.Channel.mock.results[0].value;
    expect(instance.postMessage).toHaveBeenCalledWith({
      type: "full-reload",
      path: "/project/pages/index.tsx",
    });
  });

  it("stop closes the hmr channel", async () => {
    const server = await createServer();
    await server.stop();
    expect(bc.Channel.mock.results[0].value.close).toHaveBeenCalled();
  });

  it("serves the create-next-app template tree from nextTemplate", async () => {
    const tvfs = new VfsBus();
    await writeTree(tvfs, nextTemplate, "/project2");
    const server = new NextDevServer({
      vfs: tvfs,
      root: "/project2",
      base: "/__next",
      moduleLoader: dataUrlLoader,
    });
    await server.start();
    const res = await server.onFetch("https://x/__next/", new Request("https://x/__next/"));
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("/_bolo/entry");
    const api = await server.onFetch(
      "https://x/__next/api/hello",
      new Request("https://x/__next/api/hello"),
    );
    expect(JSON.parse(await api!.text()).message).toContain("bolo Next API");
  });
});
