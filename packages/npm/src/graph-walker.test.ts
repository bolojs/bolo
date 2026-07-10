import { describe, it, expect, afterEach } from "vitest";
import { walkDependencies } from "./graph-walker.js";

const mockPackument = (name: string, version: string, deps: Record<string, string> = {}) => ({
  name,
  "dist-tags": { latest: version },
  versions: {
    [version]: {
      version,
      dist: { tarball: `https://reg/${name}/-/${name}-${version}.tgz`, integrity: "sha512-xxx" },
      dependencies: deps,
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

    const result = await walkDependencies({ dep: "^1.0.0" });

    expect(result).toHaveLength(2);
    const dep = result.find((p) => p.name === "dep");
    const subdep = result.find((p) => p.name === "subdep");
    expect(dep?.version).toBe("1.2.0");
    expect(subdep?.version).toBe("2.1.0");
  });

  it("dedupes by first-wins (flat node_modules)", async () => {
    globalThis.fetch = mockFetch({
      a: mockPackument("a", "1.0.0", { shared: "^1.0.0" }),
      b: mockPackument("b", "1.0.0", { shared: "^1.0.0" }),
      shared: mockPackument("shared", "1.5.0"),
    });

    const result = await walkDependencies({ a: "^1.0.0", b: "^1.0.0" });

    const sharedEntries = result.filter((p) => p.name === "shared");
    expect(sharedEntries).toHaveLength(1);
    expect(sharedEntries[0]!.version).toBe("1.5.0");
  });

  it("handles cycles without infinite loop", async () => {
    globalThis.fetch = mockFetch({
      a: mockPackument("a", "1.0.0", { b: "^1.0.0" }),
      b: mockPackument("b", "1.0.0", { a: "^1.0.0" }),
    });

    const result = await walkDependencies({ a: "^1.0.0" });

    expect(result).toHaveLength(2);
    expect(result.find((p) => p.name === "a")).toBeDefined();
    expect(result.find((p) => p.name === "b")).toBeDefined();
  });

  it("skips already-installed compatible versions", async () => {
    globalThis.fetch = mockFetch({
      a: mockPackument("a", "1.0.0", { lodash: "^4.0.0" }),
      b: mockPackument("b", "1.0.0", { lodash: "^4.17.0" }),
      lodash: mockPackument("lodash", "4.17.21"),
    });

    const warnings: string[] = [];
    const result = await walkDependencies({ a: "^1.0.0", b: "^1.0.0" }, fetch, (msg) =>
      warnings.push(msg),
    );

    const lodashEntries = result.filter((p) => p.name === "lodash");
    expect(lodashEntries).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("lodash"))).toHaveLength(0);
  });

  it("warns on version conflict but keeps first version", async () => {
    globalThis.fetch = mockFetch({
      a: mockPackument("a", "1.0.0", { lodash: "^4.0.0" }),
      b: mockPackument("b", "1.0.0", { lodash: "^5.0.0" }),
      lodash: mockPackument("lodash", "4.17.21"),
    });

    const warnings: string[] = [];
    const result = await walkDependencies({ a: "^1.0.0", b: "^1.0.0" }, fetch, (msg) =>
      warnings.push(msg),
    );

    expect(result.find((p) => p.name === "lodash")?.version).toBe("4.17.21");
    expect(warnings.some((w) => w.includes("Version conflict") && w.includes("lodash"))).toBe(true);
  });

  it("produces InstallablePackage with correct url and integrity", async () => {
    globalThis.fetch = mockFetch({
      lodash: mockPackument("lodash", "4.17.21"),
    });

    const result = await walkDependencies({ lodash: "^4.0.0" });
    const pkg = result[0]!;

    expect(pkg.url).toBe("https://reg/lodash/-/lodash-4.17.21.tgz");
    expect(pkg.integrity).toBe("sha512-xxx");
  });
});
