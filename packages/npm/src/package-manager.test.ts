import { describe, it, expect, beforeEach } from "vitest";
import { VfsBus } from "@browser-containers/vfs-bus";
import { PackageManager } from "./package-manager.js";

describe("PackageManager", () => {
  let vfs: VfsBus;
  let pm: PackageManager;

  beforeEach(() => {
    vfs = new VfsBus();
    pm = new PackageManager({ vfs, cwd: "/" });
  });

  describe("generateImportMap", () => {
    it("generates exact and trailing-slash entries with esm.sh URLs", () => {
      const importMap = pm.generateImportMap(["react", "lodash@4.17.21"]);

      expect(importMap.imports["react"]).toBe("https://esm.sh/react");
      expect(importMap.imports["react/"]).toBe("https://esm.sh/react/");
      expect(importMap.imports["lodash"]).toBe("https://esm.sh/lodash@4.17.21");
      expect(importMap.imports["lodash/"]).toBe("https://esm.sh/lodash@4.17.21/");
    });

    it("resolves react/jsx-runtime through the trailing-slash react entry", () => {
      const importMap = pm.generateImportMap(["react@18.2.0"]);

      expect(importMap.imports["react/"]).toBe("https://esm.sh/react@18.2.0/");
      // react/jsx-runtime resolves as `imports['react/']` + 'jsx-runtime'
    });

    it("parses package specifiers correctly, including scoped packages", () => {
      const importMap = pm.generateImportMap(["react", "react-dom@18.2.0", "@mui/material@5.0.0"]);

      expect(importMap.imports["react"]).toBe("https://esm.sh/react");
      expect(importMap.imports["@mui/material"]).toBe("https://esm.sh/@mui/material@5.0.0");
      expect(importMap.imports["@mui/material/"]).toBe("https://esm.sh/@mui/material@5.0.0/");
    });

    it("externalizes react-dom with the esm.sh `*` prefix for a single React singleton", () => {
      const importMap = pm.generateImportMap(["react-dom@18.2.0"]);

      expect(importMap.imports["react-dom"]).toBe("https://esm.sh/*react-dom@18.2.0");
      expect(importMap.imports["react-dom/"]).toBe("https://esm.sh/*react-dom@18.2.0/");
    });

    it("supports jsr: specifier resolution", () => {
      const importMap = pm.generateImportMap(["jsr:@std/assert@1.0.0"]);

      expect(importMap.imports["@std/assert"]).toBe("https://esm.sh/@std/assert@1.0.0");
    });
  });

  describe("writeImportMap (via install)", () => {
    it("generates the importmap from package.json deps, excluding build tooling", async () => {
      await vfs.writeFile(
        "/package.json",
        JSON.stringify({
          dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
          devDependencies: { vite: "^5.0.0" },
        }),
      );

      const specifiers = (pm as any).getImportMapPackageSpecifiers() as string[];

      expect(specifiers).toContain("react@^18.2.0");
      expect(specifiers).toContain("react-dom@^18.2.0");
      expect(specifiers).not.toContain("vite@^5.0.0");
      expect(specifiers.some((s) => s.startsWith("vite"))).toBe(false);
    });

    it("prefers the actually-installed version over the declared range", async () => {
      await vfs.writeFile(
        "/package.json",
        JSON.stringify({
          dependencies: { react: "^18.2.0" },
        }),
      );
      await vfs.writeFile(
        "/node_modules/react/package.json",
        JSON.stringify({ version: "18.2.0" }),
      );

      const version = (pm as any).readInstalledVersion("react");
      expect(version).toBe("18.2.0");

      const specifiers = (pm as any).getImportMapPackageSpecifiers() as string[];
      expect(specifiers).toContain("react@18.2.0");
    });

    it("falls back to the declared range when nothing is installed", () => {
      const version = (pm as any).readInstalledVersion("react");
      expect(version).toBeUndefined();
    });
  });

  it("writes import map to VFS", async () => {
    await vfs.writeFile("/importmap.json", JSON.stringify({ test: "data" }));

    const importMapContent = (await vfs.readFile("/importmap.json")) as string;
    const importMap = JSON.parse(importMapContent);

    expect(importMap.test).toBe("data");
  });
});

const textEncoder = new TextEncoder();

const pad = (s: string, length: number): string => s.padEnd(length, "\0");

const compressGzip = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const compressed = stream.pipeThrough(new CompressionStream("gzip"));
  const reader = compressed.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

const createTarball = async (entries: { name: string; content: string }[]): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const contentBytes = textEncoder.encode(entry.content);
    const header = new Uint8Array(512);
    const nameBytes = textEncoder.encode(pad(entry.name, 100));
    const sizeBytes = textEncoder.encode(contentBytes.length.toString(8).padStart(11, "0") + " ");
    const typeBytes = textEncoder.encode("0");
    header.set(nameBytes, 0);
    header.set(sizeBytes, 124);
    header.set(typeBytes, 156);
    chunks.push(header);
    chunks.push(contentBytes);
    const padding = (512 - (contentBytes.length % 512)) % 512;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(512));
  chunks.push(new Uint8Array(512));

  const tar = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    tar.set(c, offset);
    offset += c.length;
  }
  return compressGzip(tar);
};

describe("lockfile-only install", () => {
  it("installs from a package-lock.json by fetching and extracting tarballs", async () => {
    const vfs = new VfsBus();
    const pm = new PackageManager({ vfs, cwd: "/", installStrategy: "lockfile-only" });

    await vfs.writeFile(
      "/package.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { tiny: "^1.0.0" },
      }),
    );

    await vfs.writeFile(
      "/package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0", dependencies: { tiny: "^1.0.0" } },
          "node_modules/tiny": {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz",
          },
        },
      }),
    );

    const tarball = await createTarball([
      {
        name: "package/package.json",
        content: JSON.stringify({ name: "tiny", version: "1.0.0", main: "index.js" }),
      },
      { name: "package/index.js", content: "module.exports = 42;" },
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("tiny")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => tarball.slice().buffer,
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch;

    try {
      await pm.install();

      const installedPkg = (await vfs.readFile("/node_modules/tiny/package.json")) as string;
      expect(JSON.parse(installedPkg).version).toBe("1.0.0");
      expect(vfs.hot.existsSync("/node_modules/tiny/index.js")).toBe(true);

      const importMap = JSON.parse((await vfs.readFile("/importmap.json")) as string);
      expect(importMap.imports["tiny"]).toBe("https://esm.sh/tiny@1.0.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("browser-native install", () => {
  it("resolves from registry, fetches tarballs, writes lockfile + import map", async () => {
    const vfs = new VfsBus();
    const pm = new PackageManager({ vfs, cwd: "/" });

    await vfs.writeFile(
      "/package.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { tiny: "^1.0.0" },
      }),
    );

    const packument = {
      name: "tiny",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          version: "1.0.0",
          dist: { tarball: "https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz" },
        },
      },
    };

    const tarball = await createTarball([
      {
        name: "package/package.json",
        content: JSON.stringify({ name: "tiny", version: "1.0.0", main: "index.js" }),
      },
      { name: "package/index.js", content: "module.exports = 42;" },
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const str = String(url);
      if (str === "https://registry.npmjs.org/tiny") {
        return {
          ok: true,
          status: 200,
          json: async () => packument,
        } as Response;
      }
      if (str.includes("tiny-1.0.0.tgz")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => tarball.slice().buffer,
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch;

    try {
      await pm.install();

      const installedPkg = (await vfs.readFile("/node_modules/tiny/package.json")) as string;
      expect(JSON.parse(installedPkg).version).toBe("1.0.0");
      expect(vfs.hot.existsSync("/node_modules/tiny/index.js")).toBe(true);

      const lockContent = (await vfs.readFile("/package-lock.json")) as string;
      const lock = JSON.parse(lockContent);
      expect(lock.lockfileVersion).toBe(3);
      expect(lock.packages["node_modules/tiny"].version).toBe("1.0.0");

      const importMap = JSON.parse((await vfs.readFile("/importmap.json")) as string);
      expect(importMap.imports["tiny"]).toBe("https://esm.sh/tiny@1.0.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
