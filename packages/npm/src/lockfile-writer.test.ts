import { describe, it, expect } from "vitest";
import { serializeNpmLockfile } from "./lockfile-writer.js";
import type { ResolvedGraph, ResolvedGraphPackage } from "@unjs/lockfile";

const makePkg = (overrides: Partial<ResolvedGraphPackage> = {}): ResolvedGraphPackage => ({
  name: "lodash",
  version: "4.17.21",
  depPath: "lodash@4.17.21",
  resolvedUrl: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  integrity: "sha512-xxx",
  dev: false,
  optional: false,
  peerDependencies: {},
  dependencies: {},
  bin: {},
  resolvedDependencies: {},
  ...overrides,
});

/** Builds a graph where every given package is also a root (direct) dependency. */
const makeGraph = (pkgs: ResolvedGraphPackage[]): ResolvedGraph => {
  const packages = new Map(pkgs.map((p) => [p.depPath, p]));
  const rootDependencies = Object.fromEntries(pkgs.map((p) => [p.name, p.depPath]));
  return { packages, rootDependencies };
};

describe("serializeNpmLockfile", () => {
  it("produces a valid package-lock.json v3 structure", () => {
    const graph = makeGraph([makePkg()]);
    const json = serializeNpmLockfile(graph, { lodash: "^4.17.0" });
    const lock = JSON.parse(json);

    expect(lock.lockfileVersion).toBe(3);
    expect(lock.name).toBe("app");
    expect(lock.version).toBe("1.0.0");
    expect(lock.packages[""].dependencies).toEqual({ lodash: "^4.17.0" });
  });

  it("writes each root dependency under node_modules/<name>", () => {
    const graph = makeGraph([
      makePkg({ name: "react", version: "18.2.0", depPath: "react@18.2.0", resolvedUrl: "https://reg/react.tgz" }),
      makePkg({
        name: "react-dom",
        version: "18.2.0",
        depPath: "react-dom@18.2.0",
        resolvedUrl: "https://reg/react-dom.tgz",
      }),
    ]);
    const lock = JSON.parse(serializeNpmLockfile(graph, {}));

    expect(lock.packages["node_modules/react"].version).toBe("18.2.0");
    expect(lock.packages["node_modules/react"].resolved).toBe("https://reg/react.tgz");
    expect(lock.packages["node_modules/react-dom"].version).toBe("18.2.0");
  });

  it("omits integrity when empty", () => {
    const graph = makeGraph([makePkg({ integrity: "" })]);
    const lock = JSON.parse(serializeNpmLockfile(graph, {}));

    expect(lock.packages["node_modules/lodash"].integrity).toBeUndefined();
  });

  it("includes peerDependencies when present", () => {
    const graph = makeGraph([makePkg({ peerDependencies: { react: "^18.0.0" } })]);
    const lock = JSON.parse(serializeNpmLockfile(graph, {}));

    expect(lock.packages["node_modules/lodash"].peerDependencies).toEqual({ react: "^18.0.0" });
  });

  it("uses custom root name and version", () => {
    const lock = JSON.parse(
      serializeNpmLockfile({ packages: new Map(), rootDependencies: {} }, {}, "my-app", "2.3.4"),
    );
    expect(lock.name).toBe("my-app");
    expect(lock.version).toBe("2.3.4");
  });

  it("nests a conflicting transitive version under its requiring parent", () => {
    const a = makePkg({
      name: "a",
      version: "1.0.0",
      depPath: "a@1.0.0",
      resolvedDependencies: { shared: "shared@1.5.0" },
    });
    const b = makePkg({
      name: "b",
      version: "1.0.0",
      depPath: "b@1.0.0",
      resolvedDependencies: { shared: "shared@2.0.0" },
    });
    const shared150 = makePkg({ name: "shared", version: "1.5.0", depPath: "shared@1.5.0" });
    const shared200 = makePkg({ name: "shared", version: "2.0.0", depPath: "shared@2.0.0" });
    const graph = makeGraph([a, b, shared150, shared200]);
    // `shared` is only a root dep by construction of makeGraph above (last one wins the
    // name slot); drop it from root so both versions are purely transitive.
    delete graph.rootDependencies.shared;
    graph.packages.delete("shared@1.5.0");
    graph.packages.delete("shared@2.0.0");
    graph.packages.set("shared@1.5.0", shared150);
    graph.packages.set("shared@2.0.0", shared200);

    const lock = JSON.parse(serializeNpmLockfile(graph, {}));

    expect(lock.packages["node_modules/shared"].version).toBe("1.5.0");
    expect(lock.packages["node_modules/b/node_modules/shared"].version).toBe("2.0.0");
  });
});
