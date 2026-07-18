import { describe, it, expect, afterEach } from "vitest";
import { walkDependencies } from "./graph-walker.js";

const mockPackument = (
  name: string,
  version: string,
  deps: Record<string, string> = {},
  optionalDeps: Record<string, string> = {},
) => ({
  name,
  "dist-tags": { latest: version },
  versions: {
    [version]: {
      version,
      dist: { tarball: `https://reg/${name}/-/${name}-${version}.tgz`, integrity: "sha512-xxx" },
      dependencies: deps,
      optionalDependencies: optionalDeps,
    },
  },
});

const mockFetch = (packuments: Record<string, ReturnType<typeof mockPackument>>) =>
  (async (url: string | URL | Request) => {
    const path = String(url).replace("https://registry.npmjs.org/", "");
    const pkg = packuments[path];
    if (!pkg) return { ok: false, status: 404 } as Response;
    return { ok: true, status: 200, json: async () => pkg } as Response;
  }) as typeof fetch;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("walkDependencies", () => {
  it("walks transitive dependencies via BFS", async () => {
    globalThis.fetch = mockFetch({
      app: mockPackument("app", "1.0.0", { dep: "^1.0.0" }),
      dep: mockPackument("dep", "1.2.0", { subdep: "^2.0.0" }),
      subdep: mockPackument("subdep", "2.1.0"),
    });

    const graph = await walkDependencies({ dep: "^1.0.0" });

    expect(graph.packages.size).toBe(2);
    expect(graph.packages.get("dep@1.2.0")?.version).toBe("1.2.0");
    expect(graph.packages.get("subdep@2.1.0")?.version).toBe("2.1.0");
    expect(graph.rootDependencies.dep).toBe("dep@1.2.0");
    expect(graph.packages.get("dep@1.2.0")?.resolvedDependencies.subdep).toBe("subdep@2.1.0");
  });

  it("keeps both versions of a diamond dependency (fixes flat first-wins)", async () => {
    const packuments: Record<string, any> = {
      a: mockPackument("a", "1.0.0", { shared: "^1.0.0" }),
      b: mockPackument("b", "1.0.0", { shared: "^2.0.0" }),
    };
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = String(url).replace("https://registry.npmjs.org/", "");
      if (path === "shared") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: "shared",
            "dist-tags": { latest: "2.0.0" },
            versions: {
              "1.5.0": {
                version: "1.5.0",
                dist: { tarball: "https://reg/shared/-/shared-1.5.0.tgz", integrity: "sha512-xxx" },
              },
              "2.0.0": {
                version: "2.0.0",
                dist: { tarball: "https://reg/shared/-/shared-2.0.0.tgz", integrity: "sha512-xxx" },
              },
            },
          }),
        } as Response;
      }
      const pkg = packuments[path];
      if (!pkg) return { ok: false, status: 404 } as Response;
      return { ok: true, status: 200, json: async () => pkg } as Response;
    }) as typeof fetch;

    const graph = await walkDependencies({ a: "^1.0.0", b: "^1.0.0" });

    const sharedEntries = [...graph.packages.values()].filter((p) => p.name === "shared");
    expect(sharedEntries).toHaveLength(2);
    expect(sharedEntries.map((p) => p.version).sort()).toEqual(["1.5.0", "2.0.0"]);
    expect(graph.packages.get("a@1.0.0")?.resolvedDependencies.shared).toBe("shared@1.5.0");
    expect(graph.packages.get("b@1.0.0")?.resolvedDependencies.shared).toBe("shared@2.0.0");
  });

  it("handles cycles without infinite loop", async () => {
    globalThis.fetch = mockFetch({
      a: mockPackument("a", "1.0.0", { b: "^1.0.0" }),
      b: mockPackument("b", "1.0.0", { a: "^1.0.0" }),
    });

    const graph = await walkDependencies({ a: "^1.0.0" });

    expect(graph.packages.size).toBe(2);
    expect(graph.packages.get("a@1.0.0")).toBeDefined();
    expect(graph.packages.get("b@1.0.0")).toBeDefined();
    expect(graph.packages.get("a@1.0.0")?.resolvedDependencies.b).toBe("b@1.0.0");
    expect(graph.packages.get("b@1.0.0")?.resolvedDependencies.a).toBe("a@1.0.0");
  });

  it("shares a single node when the same version satisfies multiple parents", async () => {
    globalThis.fetch = mockFetch({
      a: mockPackument("a", "1.0.0", { lodash: "^4.0.0" }),
      b: mockPackument("b", "1.0.0", { lodash: "^4.17.0" }),
      lodash: mockPackument("lodash", "4.17.21"),
    });

    const graph = await walkDependencies({ a: "^1.0.0", b: "^1.0.0" });

    const lodashEntries = [...graph.packages.values()].filter((p) => p.name === "lodash");
    expect(lodashEntries).toHaveLength(1);
    expect(graph.packages.get("a@1.0.0")?.resolvedDependencies.lodash).toBe("lodash@4.17.21");
    expect(graph.packages.get("b@1.0.0")?.resolvedDependencies.lodash).toBe("lodash@4.17.21");
  });

  it("tolerates a failing optional dependency instead of failing the install", async () => {
    globalThis.fetch = mockFetch({
      app: mockPackument("app", "1.0.0", {}, { missingOptional: "^1.0.0" }),
    });

    const warnings: string[] = [];
    const graph = await walkDependencies({ app: "^1.0.0" }, fetch, (msg) => warnings.push(msg));

    expect(graph.packages.get("app@1.0.0")).toBeDefined();
    expect(graph.packages.has("missingOptional@^1.0.0")).toBe(false);
    expect(warnings.some((w) => w.includes("missingOptional") && w.includes("skipping"))).toBe(true);
  });

  it("produces a node with correct url, integrity, and bin", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = String(url).replace("https://registry.npmjs.org/", "");
      if (path !== "lodash") return { ok: false, status: 404 } as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: "lodash",
          "dist-tags": { latest: "4.17.21" },
          versions: {
            "4.17.21": {
              version: "4.17.21",
              dist: {
                tarball: "https://reg/lodash/-/lodash-4.17.21.tgz",
                integrity: "sha512-xxx",
              },
              bin: { lodash: "bin/lodash.js" },
            },
          },
        }),
      } as Response;
    }) as typeof fetch;

    const graph = await walkDependencies({ lodash: "^4.0.0" });
    const pkg = graph.packages.get("lodash@4.17.21")!;

    expect(pkg.resolvedUrl).toBe("https://reg/lodash/-/lodash-4.17.21.tgz");
    expect(pkg.integrity).toBe("sha512-xxx");
    expect(pkg.bin.lodash).toBe("bin/lodash.js");
  });
});
