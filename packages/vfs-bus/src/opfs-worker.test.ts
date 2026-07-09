import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpfsWorker } from "./opfs-worker.js";

function createMockWorker(responses: Record<string, any>): Worker {
  let onmessageFn: ((e: any) => void) | null = null;
  return {
    postMessage: (msg: any) => {
      const key = `${msg.method}:${msg.path}`;
      const resp = responses[key];
      if (resp?.error) {
        if (onmessageFn) onmessageFn({ data: { id: msg.id, ok: false, error: resp.error } });
      } else {
        if (onmessageFn) onmessageFn({ data: { id: msg.id, ok: true, data: resp } });
      }
    },
    set onmessage(fn: ((e: any) => void) | null) {
      onmessageFn = fn;
    },
    get onmessage() {
      return onmessageFn;
    },
    terminate: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as Worker;
}

function injectMockWorker(worker: OpfsWorker, responses: Record<string, any>): Worker {
  const mockW = createMockWorker(responses);
  (worker as any).worker = mockW;
  (worker as any).setupMessageHandler();
  return mockW;
}

describe("OpfsWorker", () => {
  let worker: OpfsWorker;

  beforeEach(() => {
    worker = new OpfsWorker();
  });

  afterEach(() => {
    worker.terminate();
  });

  it("readFile returns file content", async () => {
    injectMockWorker(worker, { "readFile:/hello.txt": new Uint8Array([104, 105]) });
    const data = await worker.readFile("/hello.txt");
    expect(data).toEqual(new Uint8Array([104, 105]));
  });

  it("writeFile sends content to worker", async () => {
    injectMockWorker(worker, { "writeFile:/test.txt": undefined });
    await worker.writeFile("/test.txt", new Uint8Array([1, 2, 3]));
  });

  it("mkdir sends to worker", async () => {
    injectMockWorker(worker, { "mkdir:/src": undefined });
    await worker.mkdir("/src");
  });

  it("readdir returns entries", async () => {
    injectMockWorker(worker, { "readdir:/src": ["a.ts", "b.ts"] });
    const entries = await worker.readdir("/src");
    expect(entries).toEqual(["a.ts", "b.ts"]);
  });

  it("rm sends to worker", async () => {
    injectMockWorker(worker, { "rm:/tmp.txt": undefined });
    await worker.rm("/tmp.txt");
  });

  it("exists returns true", async () => {
    injectMockWorker(worker, { "exists:/hello.txt": true });
    expect(await worker.exists("/hello.txt")).toBe(true);
  });

  it("exists returns false", async () => {
    injectMockWorker(worker, { "exists:/nope": false });
    expect(await worker.exists("/nope")).toBe(false);
  });

  it("readFile throws on ENOENT", async () => {
    injectMockWorker(worker, { "readFile:/missing.txt": { error: "ENOENT: /missing.txt" } });
    await expect(worker.readFile("/missing.txt")).rejects.toThrow("ENOENT");
  });

  it("terminate cleans up worker", async () => {
    const mockW = createMockWorker({});
    (worker as any).worker = mockW;
    worker.terminate();
    expect(mockW.terminate).toHaveBeenCalled();
  });

  it("throws when worker is null", async () => {
    (worker as any).worker = null;
    await expect(worker.readFile("/test.txt")).rejects.toThrow("OPFS Worker unavailable");
  });
});

describe("OpfsWorker + VfsBus cold layer", () => {
  it("readFile falls back to cold and promotes to hot", async () => {
    const { VfsBus } = await import("./vfs-bus.js");
    const vfs = new VfsBus();

    injectMockWorker(vfs.cold, { "readFile:/cold.txt": new Uint8Array([99, 111, 108, 100]) });
    const data = await vfs.readFile("/cold.txt");
    expect(data).toEqual(new Uint8Array([99, 111, 108, 100]));

    const hotData = vfs.hot.readFileSync("/cold.txt");
    expect(new Uint8Array(hotData as unknown as ArrayBuffer)).toEqual(
      new Uint8Array([99, 111, 108, 100]),
    );

    vfs.destroy();
  });

  it("readFile prefers hot layer", async () => {
    const { VfsBus } = await import("./vfs-bus.js");
    const vfs = new VfsBus();

    await vfs.writeFile("/hot.txt", "hot-content");
    injectMockWorker(vfs.cold, { "readFile:/hot.txt": new Uint8Array([99, 111, 108, 100]) });

    const data = await vfs.readFile("/hot.txt");
    expect(data).toBe("hot-content");

    vfs.destroy();
  });

  it("writeFile writes to hot and cold", async () => {
    const { VfsBus } = await import("./vfs-bus.js");
    const vfs = new VfsBus();

    const coldWrites: string[] = [];
    const mockW = createMockWorker({ "writeFile:/sync.txt": undefined });
    const origPost = mockW.postMessage.bind(mockW);
    mockW.postMessage = (msg: any) => {
      coldWrites.push(`${msg.method}:${msg.path}`);
      origPost(msg);
    };
    (vfs.cold as any).worker = mockW;

    await vfs.writeFile("/sync.txt", "data");

    expect(vfs.hot.readFileSync("/sync.txt", "utf8")).toBe("data");
    expect(coldWrites).toContain("writeFile:/sync.txt");

    vfs.destroy();
  });

  it("exists checks cold when not in hot", async () => {
    const { VfsBus } = await import("./vfs-bus.js");
    const vfs = new VfsBus();

    injectMockWorker(vfs.cold, { "exists:/cold-file.txt": true });
    expect(await vfs.exists("/cold-file.txt")).toBe(true);

    vfs.destroy();
  });

  it("readdir falls back to cold and promotes entries", async () => {
    const { VfsBus } = await import("./vfs-bus.js");
    const vfs = new VfsBus();

    injectMockWorker(vfs.cold, {
      "readdir:/cold-dir": ["a.ts", "b.ts"],
      "readFile:/cold-dir/a.ts": new Uint8Array([97]),
      "readFile:/cold-dir/b.ts": new Uint8Array([98]),
    });

    const entries = await vfs.readdir("/cold-dir");
    expect(entries.sort()).toEqual(["a.ts", "b.ts"]);
    expect(vfs.hot.existsSync("/cold-dir/a.ts")).toBe(true);
    expect(vfs.hot.existsSync("/cold-dir/b.ts")).toBe(true);

    vfs.destroy();
  });
});
