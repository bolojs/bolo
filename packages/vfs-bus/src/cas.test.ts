import { describe, it, expect } from "vitest";
import { CasStore, type CasBlobBackend, type CasManifestState } from "./cas.js";

function createMemoryBackend(): CasBlobBackend & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  let manifest: CasManifestState | undefined;
  return {
    blobs,
    async getBlob(hash) {
      return blobs.get(hash);
    },
    async putBlob(hash, content) {
      blobs.set(hash, content);
    },
    async deleteBlob(hash) {
      blobs.delete(hash);
    },
    async loadManifest() {
      return manifest;
    },
    async saveManifest(state) {
      manifest = state;
    },
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe("CasStore", () => {
  it("stores identical content written to two different paths as a single blob", async () => {
    const backend = createMemoryBackend();
    const cas = new CasStore(backend);
    const content = bytes("hello world");

    await cas.writeFile("/a.txt", content);
    await cas.writeFile("/b.txt", content);

    expect(backend.blobs.size).toBe(1);
    expect(await cas.readFile("/a.txt")).toEqual(content);
    expect(await cas.readFile("/b.txt")).toEqual(content);
  });

  it("retains the blob when only one of two referencing paths is deleted", async () => {
    const backend = createMemoryBackend();
    const cas = new CasStore(backend);
    const content = bytes("shared content");

    await cas.writeFile("/a.txt", content);
    await cas.writeFile("/b.txt", content);
    await cas.rm("/a.txt");

    expect(backend.blobs.size).toBe(1);
    await expect(cas.readFile("/a.txt")).rejects.toThrow("ENOENT");
    expect(await cas.readFile("/b.txt")).toEqual(content);
  });

  it("deletes the blob once every referencing path is gone", async () => {
    const backend = createMemoryBackend();
    const cas = new CasStore(backend);
    const content = bytes("shared content");

    await cas.writeFile("/a.txt", content);
    await cas.writeFile("/b.txt", content);
    await cas.rm("/a.txt");
    await cas.rm("/b.txt");

    expect(backend.blobs.size).toBe(0);
    await expect(cas.readFile("/b.txt")).rejects.toThrow("ENOENT");
  });

  it("does not delete the blob when overwriting a path with new content that still shares the old hash elsewhere", async () => {
    const backend = createMemoryBackend();
    const cas = new CasStore(backend);
    const shared = bytes("v1");
    const other = bytes("v2");

    await cas.writeFile("/a.txt", shared);
    await cas.writeFile("/b.txt", shared);
    await cas.writeFile("/a.txt", other);

    expect(backend.blobs.size).toBe(2);
    expect(await cas.readFile("/a.txt")).toEqual(other);
    expect(await cas.readFile("/b.txt")).toEqual(shared);
  });

  it("supports mkdir + exists for directories that have no files yet", async () => {
    const backend = createMemoryBackend();
    const cas = new CasStore(backend);

    await cas.mkdir("/empty-dir");

    expect(await cas.exists("/empty-dir")).toBe(true);
    expect(await cas.exists("/not-there")).toBe(false);
  });

  it("exists is true for a directory implied by a nested file, without an explicit mkdir", async () => {
    const backend = createMemoryBackend();
    const cas = new CasStore(backend);

    await cas.writeFile("/dir/nested/file.txt", bytes("x"));

    expect(await cas.exists("/dir")).toBe(true);
    expect(await cas.exists("/dir/nested")).toBe(true);
  });

  it("readdir lists immediate children only", async () => {
    const backend = createMemoryBackend();
    const cas = new CasStore(backend);

    await cas.writeFile("/dir/a.txt", bytes("a"));
    await cas.writeFile("/dir/sub/b.txt", bytes("b"));

    expect((await cas.readdir("/dir")).sort()).toEqual(["a.txt", "sub"]);
  });

  it("rm with recursive removes nested files and drops their blob refs", async () => {
    const backend = createMemoryBackend();
    const cas = new CasStore(backend);
    const content = bytes("nested content");

    await cas.writeFile("/dir/a.txt", content);
    await cas.writeFile("/dir/sub/b.txt", content);
    await cas.rm("/dir", { recursive: true });

    expect(backend.blobs.size).toBe(0);
    expect(await cas.exists("/dir")).toBe(false);
    await expect(cas.readFile("/dir/a.txt")).rejects.toThrow("ENOENT");
  });

  it("lazily migrates legacy path-keyed data on first read, then serves it from CAS", async () => {
    const backend = createMemoryBackend();
    const legacyStore = new Map<string, Uint8Array>();
    legacyStore.set("/old/file.txt", bytes("legacy content"));
    backend.legacy = {
      async read(path) {
        return legacyStore.get(path);
      },
      async exists(path) {
        return legacyStore.has(path);
      },
      async list(path) {
        const prefix = `${path}/`;
        return [...legacyStore.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length).split("/")[0]);
      },
      async remove(path) {
        legacyStore.delete(path);
      },
    };
    const cas = new CasStore(backend);

    const content = await cas.readFile("/old/file.txt");
    expect(content).toEqual(bytes("legacy content"));
    expect(legacyStore.has("/old/file.txt")).toBe(false);
    expect(backend.blobs.size).toBe(1);

    // Second read is served purely from CAS, no legacy fallback needed.
    expect(await cas.readFile("/old/file.txt")).toEqual(bytes("legacy content"));
  });
});
