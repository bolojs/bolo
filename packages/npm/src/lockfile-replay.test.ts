import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { PackageManager } from "./package-manager.js";
import { syntheticPackuments } from "./lockfile-replay.js";
import type { NpmLockfileV3 } from "./lockfile-writer.js";

describe("syntheticPackuments", () => {
  it("builds map from lock entries", () => {
    const lock: NpmLockfileV3 = {
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { version: "1.0.0", dependencies: { foo: "^1.0.0", "@scope/bar": "^2.0.0" } },
        "node_modules/foo": {
          version: "1.0.0",
          resolved: "https://reg.example/foo/-/foo-1.0.0.tgz",
          integrity: "sha512-abc",
          dependencies: { baz: "^1.0.0" },
        },
        "node_modules/@scope/bar": {
          version: "2.0.0",
          resolved: "https://reg.example/@scope/bar/-/bar-2.0.0.tgz",
          integrity: "sha512-def",
        },
      },
    };

    const map = syntheticPackuments(lock);

    expect(map.size).toBe(2);

    const foo = map.get("foo")!;
    expect(foo.name).toBe("foo");
    expect(foo["dist-tags"]!.latest).toBe("1.0.0");
    expect(foo.versions["1.0.0"].version).toBe("1.0.0");
    expect(foo.versions["1.0.0"].dist.tarball).toBe("https://reg.example/foo/-/foo-1.0.0.tgz");
    expect(foo.versions["1.0.0"].dist.integrity).toBe("sha512-abc");
    expect(foo.versions["1.0.0"].dependencies).toEqual({ baz: "^1.0.0" });

    const bar = map.get("@scope/bar")!;
    expect(bar.name).toBe("@scope/bar");
    expect(bar["dist-tags"]!.latest).toBe("2.0.0");
    expect(bar.versions["2.0.0"].dist.tarball).toBe(
      "https://reg.example/@scope/bar/-/bar-2.0.0.tgz",
    );
    expect(bar.versions["2.0.0"].dist.integrity).toBe("sha512-def");
  });
});

describe("installLockAware", () => {
  let vfs: VfsBus;
  let pm: PackageManager;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vfs = new VfsBus();
    pm = new PackageManager({ vfs, cwd: "/" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const makeLockfile = (
    deps: Record<string, NpmLockfileV3["packages"][string]>,
  ): NpmLockfileV3 => ({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { version: "1.0.0", dependencies: {} },
      ...Object.fromEntries(
        Object.entries(deps).map(([name, entry]) => [`node_modules/${name}`, entry]),
      ),
    },
  });

  it("uses synthetic source when lock is complete", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch;

    const lockfile = makeLockfile({
      foo: {
        version: "1.0.0",
        resolved: "https://reg.example/foo/-/foo-1.0.0.tgz",
        integrity: "sha512-foo",
        dependencies: { bar: "^1.0.0" },
      },
      bar: {
        version: "1.0.0",
        resolved: "https://reg.example/bar/-/bar-1.0.0.tgz",
        integrity: "sha512-bar",
      },
    });

    const graph = await (pm as any).installLockAware(["foo@^1.0.0"], lockfile);

    expect(fetchCalls).toBe(0);
    expect(graph.packages.get("foo@1.0.0")).toBeDefined();
    expect(graph.packages.get("bar@1.0.0")).toBeDefined();
    expect(graph.packages.get("foo@1.0.0")?.resolvedDependencies.bar).toBe("bar@1.0.0");
  });

  it("falls back to network for stale entries", async () => {
    const fetchCallsByName = new Map<string, number>();
    globalThis.fetch = (async (url: string | URL | Request) => {
      const str = String(url);
      const match = str.match(/^https:\/\/registry\.npmjs\.org\/(.+)$/);
      if (!match) return { ok: false, status: 404 } as Response;
      const name = match[1]!;
      fetchCallsByName.set(name, (fetchCallsByName.get(name) ?? 0) + 1);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name,
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              version: "1.0.0",
              dist: {
                tarball: `https://reg.example/${name}/-/${name}-1.0.0.tgz`,
                integrity: "sha512-baz",
              },
            },
          },
        }),
      } as Response;
    }) as typeof fetch;

    const lockfile = makeLockfile({
      foo: {
        version: "1.0.0",
        resolved: "https://reg.example/foo/-/foo-1.0.0.tgz",
        integrity: "sha512-foo",
      },
    });

    const graph = await (pm as any).installLockAware(["foo@^1.0.0", "baz@^1.0.0"], lockfile);

    expect(fetchCallsByName.get("baz")).toBe(1);
    expect(fetchCallsByName.has("foo")).toBe(false);
    expect(graph.packages.get("foo@1.0.0")).toBeDefined();
    expect(graph.packages.get("baz@1.0.0")).toBeDefined();
  });
});
