import { describe, it, expect, beforeEach } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { buildRouteManifest, matchRoute, fileToRoutePath, routeScore } from "./route-manifest.js";

describe("fileToRoutePath", () => {
  it("maps index files to the directory root", () => {
    expect(fileToRoutePath("index.tsx")).toBe("/");
    expect(fileToRoutePath("about.tsx")).toBe("/about");
    expect(fileToRoutePath("blog/index.tsx")).toBe("/blog");
  });

  it("keeps dynamic segments literal", () => {
    expect(fileToRoutePath("blog/[id].tsx")).toBe("/blog/[id]");
    expect(fileToRoutePath("[...slug].tsx")).toBe("/[...slug]");
  });
});

describe("buildRouteManifest", () => {
  let vfs: VfsBus;

  beforeEach(async () => {
    vfs = new VfsBus();
    await vfs.mkdir("/app/pages/blog", { recursive: true });
    await vfs.mkdir("/app/pages/api", { recursive: true });
    await vfs.writeFile("/app/pages/_app.tsx", "export default function App() {}");
    await vfs.writeFile("/app/pages/_document.tsx", "export default function Doc() {}");
    await vfs.writeFile("/app/pages/index.tsx", "export default function Home() {}");
    await vfs.writeFile("/app/pages/about.tsx", "export default function About() {}");
    await vfs.writeFile("/app/pages/blog/index.tsx", "export default function Blog() {}");
    await vfs.writeFile("/app/pages/blog/[id].tsx", "export default function Post() {}");
    await vfs.writeFile("/app/pages/blog/[...slug].tsx", "export default function CatchAll() {}");
    await vfs.writeFile("/app/pages/api/hello.ts", "export default function handler() {}");
    await vfs.writeFile("/app/pages/api/echo/[what].ts", "export default function echo() {}");
    await vfs.writeFile("/app/pages/styles.css", "/* not a page */");
  });

  it("finds all routes and skips convention files", async () => {
    const manifest = await buildRouteManifest(vfs, "/app");
    const paths = manifest.routes.map((r) => r.path);
    expect(paths).toContain("/");
    expect(paths).toContain("/about");
    expect(paths).toContain("/blog");
    expect(paths).toContain("/blog/[id]");
    expect(paths).toContain("/blog/[...slug]");
    expect(paths).toContain("/api/hello");
    expect(paths).toContain("/api/echo/[what]");
    expect(paths).not.toContain("/_app");
    expect(paths).not.toContain("/_document");
    expect(paths).not.toContain("/styles");
    expect(manifest.routes).toHaveLength(7);
  });

  it("locates _app and _document convention files", async () => {
    const manifest = await buildRouteManifest(vfs, "/app");
    expect(manifest.appFilePath).toBe("/app/pages/_app.tsx");
    expect(manifest.documentFilePath).toBe("/app/pages/_document.tsx");
    expect(manifest.errorFilePath).toBeNull();
  });

  it("classifies api routes and records params", async () => {
    const manifest = await buildRouteManifest(vfs, "/app");
    const echo = manifest.routes.find((r) => r.path === "/api/echo/[what]");
    expect(echo?.kind).toBe("api");
    expect(echo?.paramNames).toEqual(["what"]);
    const post = manifest.routes.find((r) => r.path === "/blog/[id]");
    expect(post?.kind).toBe("page");
    expect(post?.paramNames).toEqual(["id"]);
    const catchAll = manifest.routes.find((r) => r.path === "/blog/[...slug]");
    expect(catchAll?.catchAll).toBe(true);
  });

  it("returns an empty manifest when pages/ does not exist", async () => {
    const manifest = await buildRouteManifest(vfs, "/nope");
    expect(manifest.routes).toEqual([]);
    expect(manifest.appFilePath).toBeNull();
  });
});

describe("matchRoute", () => {
  let vfs: VfsBus;

  beforeEach(async () => {
    vfs = new VfsBus();
    await vfs.mkdir("/app/pages/blog", { recursive: true });
    await vfs.writeFile("/app/pages/index.tsx", "x");
    await vfs.writeFile("/app/pages/blog/index.tsx", "x");
    await vfs.writeFile("/app/pages/blog/[id].tsx", "x");
    await vfs.writeFile("/app/pages/blog/[...slug].tsx", "x");
  });

  it("prefers static over dynamic over catch-all", async () => {
    const manifest = await buildRouteManifest(vfs, "/app");
    expect(matchRoute(manifest, "/blog")?.route.path).toBe("/blog");
    expect(matchRoute(manifest, "/blog/42")?.route.path).toBe("/blog/[id]");
  });

  it("matches catch-all routes with the remaining segments", async () => {
    const manifest = await buildRouteManifest(vfs, "/app");
    const matched = matchRoute(manifest, "/blog/a/b/c");
    expect(matched?.route.path).toBe("/blog/[...slug]");
    expect(matched?.params).toEqual({ slug: ["a", "b", "c"] });
  });

  it("collects single dynamic params", async () => {
    const manifest = await buildRouteManifest(vfs, "/app");
    const matched = matchRoute(manifest, "/blog/7");
    expect(matched?.params).toEqual({ id: "7" });
  });

  it("returns null when nothing matches", async () => {
    const manifest = await buildRouteManifest(vfs, "/app");
    expect(matchRoute(manifest, "/nope/deep/path")).toBeNull();
  });

  it("filters by kind", async () => {
    const manifest = await buildRouteManifest(vfs, "/app");
    expect(matchRoute(manifest, "/blog/7", "api")).toBeNull();
    expect(matchRoute(manifest, "/blog/7", "page")?.route.path).toBe("/blog/[id]");
  });
});

describe("routeScore", () => {
  it("ranks static > dynamic > catch-all at equal depth", async () => {
    const mk = (path: string) => ({
      path,
      filePath: "/x",
      kind: "page" as const,
      paramNames: [],
      catchAll: path.includes("..."),
    });
    expect(routeScore(mk("/a/b"))).toBeGreaterThan(routeScore(mk("/a/[id]")));
    expect(routeScore(mk("/a/[id]"))).toBeGreaterThan(routeScore(mk("/a/[...slug]")));
  });
});
