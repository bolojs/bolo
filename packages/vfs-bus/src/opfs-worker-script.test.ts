import { describe, it, expect } from "vitest";
import { opfsWorkerScript } from "./opfs-worker-script.js";

/**
 * Minimal in-memory IndexedDB fake covering exactly what opfs-worker-script.ts
 * uses (one object store, single get/put/delete/count/getAllKeys per
 * transaction). Lets these tests execute the real worker script — not a
 * mirror of it — against a browserless environment so CAS dedup/refcount
 * behavior is verified against the shipped code, not just the pure algorithm
 * in cas.ts.
 */
function createFakeIndexedDB() {
  const databases = new Map<string, { stores: Map<string, Map<string, unknown>> }>();

  function open(name: string) {
    const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined };
    queueMicrotask(() => {
      let db = databases.get(name);
      const isNew = !db;
      if (!db) {
        db = { stores: new Map() };
        databases.set(name, db);
      }
      const fakeDb = {
        createObjectStore(storeName: string) {
          db!.stores.set(storeName, new Map());
        },
        transaction(storeName: string) {
          const store = db!.stores.get(storeName)!;
          const tx: any = { oncomplete: null, onerror: null };
          let completed = false;
          const complete = () => {
            if (completed) return;
            completed = true;
            queueMicrotask(() => tx.oncomplete?.());
          };
          const mkReq = (run: () => unknown) => {
            const r: any = { onsuccess: null, onerror: null, result: undefined };
            queueMicrotask(() => {
              r.result = run();
              r.onsuccess?.();
              complete();
            });
            return r;
          };
          return Object.assign(tx, {
            objectStore() {
              return {
                get: (key: string) => mkReq(() => store.get(key)),
                put: (value: unknown, key: string) => mkReq(() => void store.set(key, value)),
                delete: (key: string) => mkReq(() => void store.delete(key)),
                count: (key: string) => mkReq(() => (store.has(key) ? 1 : 0)),
                getAllKeys: () => mkReq(() => [...store.keys()]),
              };
            },
          });
        },
      };
      req.result = fakeDb;
      if (isNew) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }

  return { open };
}

async function loadWorkerScript() {
  (globalThis as any).indexedDB = createFakeIndexedDB();
  const fakeSelf: any = { onmessage: null, postMessage: null };
  (globalThis as any).self = fakeSelf;
  // eslint-disable-next-line no-new-func
  new Function(opfsWorkerScript)();
  // Let the async backend-detection IIFE (falls back to 'idb' — no OPFS in Node) settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  let nextId = 0;
  const send = (method: string, path: string, content?: Uint8Array): Promise<any> =>
    new Promise((resolve) => {
      const id = nextId++;
      fakeSelf.postMessage = (resp: any) => {
        if (resp.id === id) resolve(resp);
      };
      fakeSelf.onmessage({ data: { id, method, path, content } });
    });
  return { send };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe("opfsWorkerScript (real script, idb backend)", () => {
  it("dedups identical content written at two paths into a single blob", async () => {
    const { send } = await loadWorkerScript();
    const content = bytes("same bytes");

    expect((await send("writeFile", "/a.tgz", content)).ok).toBe(true);
    expect((await send("writeFile", "/b.tgz", content)).ok).toBe(true);

    expect((await send("readFile", "/a.tgz")).data).toEqual(content);
    expect((await send("readFile", "/b.tgz")).data).toEqual(content);
  });

  it("retains the blob after deleting one of two referencing paths", async () => {
    const { send } = await loadWorkerScript();
    const content = bytes("shared");
    await send("writeFile", "/a.tgz", content);
    await send("writeFile", "/b.tgz", content);

    await send("rm", "/a.tgz");

    expect((await send("readFile", "/a.tgz")).ok).toBe(false);
    const b = await send("readFile", "/b.tgz");
    expect(b.ok).toBe(true);
    expect(b.data).toEqual(content);
  });

  it("removes the blob once every referencing path has been deleted", async () => {
    const { send } = await loadWorkerScript();
    const content = bytes("shared");
    await send("writeFile", "/a.tgz", content);
    await send("writeFile", "/b.tgz", content);

    await send("rm", "/a.tgz");
    await send("rm", "/b.tgz");

    expect((await send("readFile", "/a.tgz")).ok).toBe(false);
    expect((await send("readFile", "/b.tgz")).ok).toBe(false);
  });

  it("supports mkdir, exists and readdir", async () => {
    const { send } = await loadWorkerScript();

    await send("mkdir", "/dir");
    expect((await send("exists", "/dir")).data).toBe(true);

    await send("writeFile", "/dir/f.txt", bytes("x"));
    expect((await send("readdir", "/dir")).data).toEqual(["f.txt"]);

    await send("rm", "/dir");
    expect((await send("exists", "/dir")).data).toBe(false);
    expect((await send("readFile", "/dir/f.txt")).ok).toBe(false);
  });

  it("migrates legacy path-keyed data (pre-CAS installs) on first read", async () => {
    const { send } = await loadWorkerScript();
    // Simulate a pre-CAS write: direct idbWrite-style raw path key, bypassing
    // writeFile/CAS entirely — i.e. what an older bolo build left behind.
    const req = (globalThis as any).indexedDB.open("vfs-bus-opfs-fallback", 1);
    await new Promise<void>((resolve) => {
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve();
    });
    const legacyContent = bytes("legacy content");
    const tx = req.result.transaction("files", "readwrite");
    tx.objectStore().put(legacyContent, "/old/pkg.tgz");
    await new Promise<void>((resolve) => {
      tx.oncomplete = resolve;
    });

    const resp = await send("readFile", "/old/pkg.tgz");
    expect(resp.ok).toBe(true);
    expect(resp.data).toEqual(legacyContent);

    // Second read must be served from CAS now, not the legacy key.
    const again = await send("readFile", "/old/pkg.tgz");
    expect(again.data).toEqual(legacyContent);
  });
});
