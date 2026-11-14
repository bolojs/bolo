// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { NextDevServer, type ModuleLoader } from "./next-dev-server.js";
import { nextTemplate, type TreeNode } from "./template.js";

/** Loader that executes the compiled source through a data: URL import. The
 * happy-dom default loader would import the served http URL, which node
 * cannot; the routing behavior under test is identical either way. */
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

describe("NextDevServer onFetch (happy-dom)", () => {
  let vfs: VfsBus;

  beforeEach(async () => {
    vfs = new VfsBus();
    await writeTree(vfs, nextTemplate, "/project");
    // Server-side execution (getStaticProps, API routes) has no document
    // importmap; bare imports are rewritten through project importmap.json.
    // Point react at a tiny data-URL stub so the compiled page module can be
    // imported in this DOM environment.
    const reactStub = `data:text/javascript;charset=utf-8,${encodeURIComponent(
      "export const Fragment = Symbol.for('react.fragment');\n" +
        "export const jsx = (type, props) => ({ type, props });\n" +
        "export const jsxs = jsx;\n",
    )}`;
    await vfs.writeFile(
      "/project/importmap.json",
      JSON.stringify({ imports: { react: reactStub, "react/": `${reactStub}#/` } }),
    );
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

  it("assembles the html shell with the document importmap in a DOM environment", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://app.test/__next/",
      new Request("https://app.test/__next/"),
    );
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<div id="__next"></div>');
    expect(html).toContain("/__next/_bolo/entry");
  });

  it("runs getStaticProps and embeds the props", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://app.test/__next/blog/7",
      new Request("https://app.test/__next/blog/7"),
    );
    expect(res?.status).toBe(200);
    expect(await res!.text()).toContain('{"title":"Post #7"}');
  });

  it("executes api routes through the DOM Request/Response classes", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://app.test/__next/api/hello",
      new Request("https://app.test/__next/api/hello", { method: "GET" }),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("application/json");
    const body = JSON.parse(await res!.text());
    expect(body.message).toContain("bolo Next API");
  });

  it("returns 404 for unknown routes", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://app.test/__next/no/such/route",
      new Request("https://app.test/__next/no/such/route"),
    );
    expect(res?.status).toBe(404);
  });

  it("returns null for paths outside the base", async () => {
    const server = await createServer();
    const res = await server.onFetch(
      "https://app.test/other",
      new Request("https://app.test/other"),
    );
    expect(res).toBeNull();
  });
});
