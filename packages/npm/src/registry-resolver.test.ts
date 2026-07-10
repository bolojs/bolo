import { describe, it, expect, afterEach } from "vitest";
import { resolvePackage } from "./registry-resolver.js";

const mockPackument = (name: string, versions: Record<string, any>) => ({
  name,
  "dist-tags": { latest: Object.keys(versions).at(-1) },
  versions,
});

const mockVersion = (tarball: string, deps: Record<string, string> = {}) => ({
  version: tarball.match(/-(\d+\.\d+\.\d+)\.tgz/)?.[1] ?? "1.0.0",
  dist: { tarball, integrity: "sha512-xxx" },
  dependencies: deps,
});

const mockFetch = (packuments: Record<string, any>) =>
  (async (url: string | URL | Request) => {
    const path = String(url).replace("https://registry.npmjs.org/", "");
    const pkg = packuments[path];
    if (!pkg) return { ok: false, status: 404 } as Response;
    return {
      ok: true,
      status: 200,
      json: async () => pkg,
    } as Response;
  }) as typeof fetch;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolvePackage", () => {
  it("picks the highest version satisfying a range", async () => {
    globalThis.fetch = mockFetch({
      lodash: mockPackument("lodash", {
        "4.17.20": mockVersion("https://reg/lodash/-/lodash-4.17.20.tgz"),
        "4.17.21": mockVersion("https://reg/lodash/-/lodash-4.17.21.tgz"),
        "5.0.0": mockVersion("https://reg/lodash/-/lodash-5.0.0.tgz"),
      }),
    });

    const resolved = await resolvePackage("lodash", "^4.0.0");
    expect(resolved.version).toBe("4.17.21");
    expect(resolved.tarballUrl).toBe("https://reg/lodash/-/lodash-4.17.21.tgz");
    expect(resolved.integrity).toBe("sha512-xxx");
  });

  it("uses dist-tags latest for *", async () => {
    globalThis.fetch = mockFetch({
      lodash: {
        name: "lodash",
        "dist-tags": { latest: "5.0.0" },
        versions: {
          "4.17.21": mockVersion("https://reg/lodash/-/lodash-4.17.21.tgz"),
          "5.0.0": mockVersion("https://reg/lodash/-/lodash-5.0.0.tgz"),
        },
      },
    });

    const resolved = await resolvePackage("lodash", "*");
    expect(resolved.version).toBe("5.0.0");
  });

  it("returns dependencies from the matched version", async () => {
    globalThis.fetch = mockFetch({
      express: mockPackument("express", {
        "4.18.0": mockVersion("https://reg/express/-/express-4.18.0.tgz", {
          "body-parser": "^1.20.0",
        }),
      }),
    });

    const resolved = await resolvePackage("express", "^4.0.0");
    expect(resolved.dependencies["body-parser"]).toBe("^1.20.0");
  });

  it("handles npm: alias syntax", async () => {
    globalThis.fetch = mockFetch({
      "real-name": mockPackument("real-name", {
        "2.0.0": mockVersion("https://reg/real-name/-/real-name-2.0.0.tgz"),
      }),
    });

    const resolved = await resolvePackage("alias-name", "npm:real-name@^2.0.0");
    expect(resolved.name).toBe("alias-name");
    expect(resolved.version).toBe("2.0.0");
    expect(resolved.tarballUrl).toBe("https://reg/real-name/-/real-name-2.0.0.tgz");
  });

  it("throws when no version satisfies the range", async () => {
    globalThis.fetch = mockFetch({
      lodash: mockPackument("lodash", {
        "4.17.21": mockVersion("https://reg/lodash/-/lodash-4.17.21.tgz"),
      }),
    });

    await expect(resolvePackage("lodash", "^5.0.0")).rejects.toThrow(
      "No version of lodash satisfies ^5.0.0",
    );
  });

  it("throws on registry fetch failure", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch;

    await expect(resolvePackage("nonexistent", "^1.0.0")).rejects.toThrow(
      "Registry fetch failed for nonexistent: 404",
    );
  });
});
