import { describe, it, expect, vi } from "vitest";
import { createStreamShim } from "../src/stream.ts";
import streamPromises from "../src/stream/promises.ts";
import * as streamConsumers from "../src/stream/consumers.ts";
import * as streamWeb from "../src/stream/web.ts";

const shim = createStreamShim();
const {
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  Stream,
  pipeline,
  finished,
  compose,
  addAbortSignal,
  duplexPair,
  consumers,
  promises,
} = shim;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("node-web-shims: stream", () => {
  it("should match node:stream type shape", () => {
    const _nodeStream: typeof import("node:stream") =
      shim as unknown as typeof import("node:stream");
    expect(_nodeStream).toBeDefined();
  });

  it("exports the full Node surface", () => {
    for (const k of [
      "Readable",
      "Writable",
      "Duplex",
      "Transform",
      "PassThrough",
      "Stream",
      "pipeline",
      "finished",
      "addAbortSignal",
      "compose",
      "destroy",
      "promises",
      "consumers",
      "duplexPair",
      "getDefaultHighWaterMark",
      "setDefaultHighWaterMark",
      "isDisturbed",
      "isReadable",
      "isWritable",
      "isErrored",
      "isDestroyed",
      "getErrored",
    ]) {
      expect(shim[k as keyof typeof shim], k).toBeDefined();
    }
    expect(
      (shim as unknown as Record<string, { ReadableStream?: unknown }>).web.ReadableStream,
    ).toBe(globalThis.ReadableStream);
  });
});

describe("callable constructors", () => {
  it("classes work with and without `new`", () => {
    expect(new Readable()).toBeInstanceOf(Readable);
    // Function-call semantics (no `new`) must still construct.
    const r = (Readable as unknown as () => Readable)();
    expect(r).toBeInstanceOf(Readable);
    const w = (Writable as unknown as () => Writable)();
    expect(w).toBeInstanceOf(Writable);
    const d = (Duplex as unknown as () => Duplex)();
    expect(d).toBeInstanceOf(Duplex);
    const t = (Transform as unknown as () => Transform)();
    expect(t).toBeInstanceOf(Transform);
    const p = (PassThrough as unknown as () => PassThrough)();
    expect(p).toBeInstanceOf(PassThrough);
  });

  it("legacy Stream is callable via Stream.call(this)", () => {
    const s = new Stream();
    expect(s).toBeInstanceOf(Stream);
    // Events wiring comes from EventEmitter state init.
    expect(typeof s.emit).toBe("function");
    expect(typeof s.on).toBe("function");
    expect(typeof s.pipe).toBe("function");
  });

  it("subclass-style: Readable.call(this) constructs instance state", () => {
    const self = Object.create(Readable.prototype) as Readable;
    (Readable as unknown as (t: unknown, o?: unknown) => void).call(self, {});
    expect(self._readableState).toBeDefined();
    expect(self.readable).toBe(true);
  });
});

describe("Readable push/readable/data/end ordering", () => {
  it("push() buffers, emits 'readable' then 'end' after null", async () => {
    const r = new Readable({ read() {} });
    const events: string[] = [];
    r.on("readable", () => {
      let chunk;
      while ((chunk = r.read()) !== null) {
        events.push(`data:${String(chunk)}`);
      }
    });
    r.on("end", () => events.push("end"));

    r.push("hello");
    r.push("world");
    r.push(null);

    await vi.waitFor(() => expect(events).toContain("end"));
    // Node coalesces buffered non-objectMode chunks on read().
    expect(events).toEqual(["data:helloworld", "end"]);
  });

  it("push() returns false once buffered length reaches highWaterMark", () => {
    const r = new Readable({ read() {}, highWaterMark: 8 });
    expect(r.push("1234")).toBe(true); // length 4 < 8
    expect(r.push("5678")).toBe(false); // length 8 — at hwm → backpressure
    expect(r._readableState.length).toBe(8);
    expect(r.readableLength).toBe(r._readableState.length);
  });

  it("push(null) marks EOF; further push emits 'error'", async () => {
    const r = new Readable({ read() {} });
    const errP = new Promise<Error>((res) => r.on("error", res));
    r.push("a");
    r.push(null);
    expect(r._readableState.ended).toBe(true);
    r.push("b");
    const err = await errP;
    expect((err as { code?: string }).code).toBe("ERR_STREAM_PUSH_AFTER_EOF");
  });

  it("'data' events put the stream in flowing mode", async () => {
    const r = new Readable({ read() {} });
    const got: string[] = [];
    r.on("data", (c: Buffer) => got.push(c.toString()));
    const ended = new Promise<void>((res) => r.on("end", res));
    r.push("x");
    r.push(null);
    await ended;
    expect(got).toEqual(["x"]);
  });

  it("skips empty strings and null-terminates", async () => {
    const r = new Readable({ read() {} });
    expect(r.push("")).toBe(true); // ignored, still true
    expect(r._readableState.length).toBe(0);
    r.push(null);
    expect(r._readableState.ended).toBe(true);
  });

  it("_readableState.reading flips during _read", async () => {
    let readingSeen: boolean | undefined;
    const r = new Readable({
      read() {
        // `read` runs with `this` bound to the stream; capture via closure so
        // TS keeps the StreamOptions signature.
        readingSeen = r._readableState.reading;
        r.push("v");
        r.push(null);
      },
    });
    const ended = new Promise<void>((res) => r.on("end", res));
    r.resume();
    await ended;
    expect(readingSeen).toBe(true);
  });
});

describe("Readable.read / pause / resume / isPaused", () => {
  it("read() drains buffer; pause stops data events", async () => {
    const r = new Readable({ read() {} });
    r.push("a");
    r.push("b");
    r.push(null);
    await tick();
    expect(r.readableLength).toBeGreaterThan(0);
    r.pause();
    expect(r.isPaused()).toBe(true);
    expect(r.read()).toBeDefined();
    r.resume();
    expect(r.isPaused()).toBe(false);
  });
});

describe("Writable state + finish ordering", () => {
  it("prototype owns writableFinished; 'prefinish' is sync, 'finish' is async", async () => {
    const w = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    // Node: `writableFinished` is an own getter on Writable.prototype.
    expect(Object.prototype.hasOwnProperty.call(w, "writableFinished")).toBe(false);
    const desc = Object.getOwnPropertyDescriptor(Writable.prototype, "writableFinished");
    expect(typeof desc?.get).toBe("function");

    const order: string[] = [];
    w.on("prefinish", () => {
      order.push("prefinish");
      // finish must not be emitted synchronously from end().
      order.push(`finishedFlag:${w.writableFinished}`);
    });
    w.on("finish", () => {
      order.push("finish");
      order.push(`finishedFlag:${w.writableFinished}`);
    });
    w.end();
    // prefinish fires synchronously inside end().
    expect(order).toEqual(["prefinish", "finishedFlag:false"]);
    await vi.waitFor(() => expect(w.writableFinished).toBe(true));
    await tick();
    expect(order).toEqual(["prefinish", "finishedFlag:false", "finish", "finishedFlag:true"]);
    expect(w.writableEnded).toBe(true);
  });

  it("_final runs before 'finish'; write callbacks fire in order", async () => {
    const calls: string[] = [];
    const w = new Writable({
      write(c, _e, cb) {
        calls.push(`w:${c}`);
        cb();
      },
      final(cb) {
        calls.push("final");
        cb();
      },
    });
    const done = new Promise<void>((res) => w.on("finish", res));
    w.write("1");
    w.write("2");
    w.end("3");
    await done;
    expect(calls).toEqual(["w:1", "w:2", "w:3", "final"]);
  });

  it("write() returns false past highWaterMark and emits 'drain'", async () => {
    let release: (() => void) | undefined;
    const w = new Writable({
      highWaterMark: 1,
      write(_c, _e, cb) {
        release = cb; // hold the write open
      },
    });
    // Node increments length before comparing → at/above hwm returns false.
    expect(w.write("a")).toBe(false);
    const drainP = new Promise<void>((res) => w.once("drain", res));
    release!();
    await drainP;
  });

  it("writableLength tracks buffered chunks", () => {
    let hold: ((e?: Error | null) => void) | undefined;
    const w = new Writable({
      write(_c, _e, cb) {
        hold = cb;
      },
    });
    w.write("abc");
    // In-flight writes count toward writableLength until the cb fires.
    expect(w.writableLength).toBe(3);
    hold!();
    expect(w.writableLength).toBe(0);
  });

  it("write after end errors via callback and 'error'", async () => {
    const w = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    await new Promise<void>((res) => w.end(res));
    const cbErr = await new Promise<Error | null | undefined>((res) =>
      w.write("x", (e) => res(e as Error)),
    );
    expect(cbErr).toBeTruthy();
  });
});

describe("cork / uncork", () => {
  it("buffers writes while corked, flushes on uncork", async () => {
    const written: string[] = [];
    const w = new Writable({
      write(c, _e, cb) {
        written.push(String(c));
        cb();
      },
    });
    w.cork();
    expect(w.writableCorked).toBe(1);
    w.write("a");
    w.write("b");
    expect(written).toEqual([]);
    w.uncork();
    await vi.waitFor(() => expect(written).toEqual(["a", "b"]));
    expect(w.writableCorked).toBe(0);
  });

  it("end() fully uncorks", async () => {
    const written: string[] = [];
    const w = new Writable({
      write(c, _e, cb) {
        written.push(String(c));
        cb();
      },
    });
    w.cork();
    w.cork();
    w.write("x");
    const done = new Promise<void>((res) => w.on("finish", res));
    w.end();
    await done;
    expect(written).toEqual(["x"]);
    expect(w.writableCorked).toBe(0);
  });
});

describe("destroy semantics", () => {
  it("destroy(err) emits 'error' before 'close'", async () => {
    const r = new Readable({ read() {} });
    const order: string[] = [];
    const boom = new Error("boom");
    r.on("error", (e: Error) => order.push(`error:${e.message}`));
    r.on("close", () => order.push("close"));
    r.destroy(boom);
    await vi.waitFor(() => expect(order).toContain("close"));
    expect(order).toEqual(["error:boom", "close"]);
    expect(r.destroyed).toBe(true);
    expect(r.errored).toBe(boom);
  });

  it("destroy() without error emits 'close' and no 'error'", async () => {
    const w = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    const order: string[] = [];
    w.on("error", () => order.push("error"));
    w.on("close", () => order.push("close"));
    w.destroy();
    await vi.waitFor(() => expect(order).toEqual(["close"]));
    expect(w.destroyed).toBe(true);
  });

  it("destroy is idempotent", async () => {
    const r = new Readable({ read() {} });
    let closes = 0;
    r.on("close", () => closes++);
    r.destroy();
    r.destroy();
    await tick();
    expect(closes).toBe(1);
  });

  it("emitClose: false suppresses 'close'", async () => {
    const r = new Readable({ read() {}, emitClose: false });
    let closed = false;
    r.on("close", () => (closed = true));
    r.destroy();
    await tick();
    expect(closed).toBe(false);
    expect(r.destroyed).toBe(true);
  });
});

describe("pipe / unpipe", () => {
  it("emits 'pipe' on destination and ends it by default", async () => {
    const r = new Readable({ read() {} });
    const w = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    let pipeSeen = false;
    w.on("pipe", (src: unknown) => {
      pipeSeen = true;
      expect(src).toBe(r);
    });
    const done = new Promise<void>((res) => w.on("finish", res));
    r.pipe(w);
    expect(pipeSeen).toBe(true);
    r.push("x");
    r.push(null);
    await done;
  });

  it("end: false keeps destination open", async () => {
    const r = new Readable({ read() {} });
    const w = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    let finishedW = false;
    w.on("finish", () => (finishedW = true));
    const ended = new Promise<void>((res) => r.on("end", res));
    r.pipe(w, { end: false });
    r.push("x");
    r.push(null);
    await ended;
    await tick();
    expect(finishedW).toBe(false);
    w.end();
    await vi.waitFor(() => expect(finishedW).toBe(true));
  });

  it("pauses source on backpressure, resumes on drain", async () => {
    const r = new Readable({ read() {} });
    const cbs: Array<() => void> = [];
    const w = new Writable({
      highWaterMark: 1,
      write(_c, _e, cb) {
        cbs.push(cb);
      },
    });
    r.pipe(w);
    for (let i = 0; i < 4; i++) r.push(`c${i}`);
    await tick();
    // Destination signaled backpressure → source paused.
    expect(r._readableState.flowing).toBe(false);
    while (cbs.length) cbs.shift()!();
    await vi.waitFor(() => expect(r._readableState.flowing).not.toBe(false));
  });
});

describe("objectMode", () => {
  it("buffers arbitrary objects and counts items not bytes", async () => {
    const r = new Readable({ read() {}, objectMode: true });
    const obj = { a: 1 };
    r.push(obj);
    expect(r._readableState.length).toBe(1);
    expect(r.read()).toBe(obj);
    expect(r._readableState.length).toBe(0);
  });

  it("highWaterMark counts objects", () => {
    const r = new Readable({ read() {}, objectMode: true });
    const hwm = r._readableState.highWaterMark;
    expect(hwm).toBe(16);
  });
});

describe("async iteration", () => {
  it("for-await consumes chunks then ends", async () => {
    const r = new Readable({ read() {} });
    r.push("a");
    r.push("b");
    r.push(null);
    const got: string[] = [];
    for await (const c of r) got.push((c as Buffer).toString());
    // Node drains the buffer per read() → pushes coalesce into one chunk.
    expect(got).toEqual(["ab"]);
  });

  it("breaking out of for-await destroys the stream", async () => {
    const r = new Readable({ read() {} });
    // As in Node, the AbortError from early-exit destroy is emitted on the
    // stream — an unhandled 'error' would throw, so observe it.
    const errP = new Promise<Error>((res) => r.on("error", res));
    r.push("a");
    r.push("b");
    r.push(null);
    for await (const _c of r) break;
    await vi.waitFor(() => expect(r.destroyed).toBe(true));
    expect((await errP).name).toBe("AbortError");
  });
});

describe("pipeline / finished / compose / addAbortSignal", () => {
  it("pipeline(r, w, cb) calls back with no error on success", async () => {
    const r = Readable.from(["a", "b"]);
    const w = new Writable({
      objectMode: true,
      write(_c, _e, cb) {
        cb();
      },
    });
    const err = await new Promise<Error | null | undefined>((res) => pipeline(r, w, (e) => res(e)));
    expect(err == null).toBe(true);
    expect(w.writableFinished).toBe(true);
  });

  it("pipeline propagates errors and destroys intermediates", async () => {
    const boom = new Error("mid");
    const mid = new Transform({
      objectMode: true,
      transform(_c, _e, cb) {
        cb(boom);
      },
    });
    const src = Readable.from(["x"]);
    const dst = new Writable({
      objectMode: true,
      write(_c, _e, cb) {
        cb();
      },
    });
    const err = await new Promise<Error | null | undefined>((res) =>
      pipeline(src, mid, dst, (e) => res(e)),
    );
    expect(err).toBeTruthy();
    await vi.waitFor(() => expect(mid.destroyed).toBe(true));
  });

  it("promises.pipeline resolves with a generator sink's return value", async () => {
    const value = await promises.pipeline(
      Readable.from([1, 2, 3]),
      async function* (src: AsyncIterable<unknown>) {
        for await (const _c of src) yield _c;
      },
      new Writable({
        objectMode: true,
        write(_c, _e, cb) {
          cb();
        },
      }),
    );
    expect(value).toBeUndefined();
  });

  it("finished() resolves after end and errors on premature close", async () => {
    const r = new Readable({ read() {} });
    const p = promises.finished(r);
    r.push("x");
    r.push(null);
    r.resume();
    await p;

    const r2 = new Readable({ read() {} });
    const p2 = promises.finished(r2);
    r2.destroy();
    await expect(p2).rejects.toThrowError(/Premature close/i);
  });

  it("finished(stream, cb) style invokes callback", async () => {
    const w = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    const errP = new Promise<Error | null | undefined>((res) => finished(w, (e) => res(e)));
    w.end();
    const err = await errP;
    expect(err == null).toBe(true);
  });

  it("compose chains transforms into a duplex", async () => {
    const up = new Transform({
      objectMode: true,
      transform(c, _e, cb) {
        cb(null, String(c).toUpperCase());
      },
    });
    const excl = new Transform({
      objectMode: true,
      transform(c, _e, cb) {
        cb(null, `${c}!`);
      },
    });
    const d = compose(up, excl);
    const out: unknown[] = [];
    d.on("data", (c) => out.push(c));
    const done = new Promise<void>((res) => d.on("end", res));
    d.write("a");
    d.end();
    await done;
    expect(out).toEqual(["A!"]);
  });

  it("addAbortSignal destroys the stream on abort", async () => {
    const ac = new AbortController();
    const r = new Readable({ read() {} });
    addAbortSignal(ac.signal, r);
    const closed = new Promise<void>((res) => r.on("close", res));
    const errored = new Promise<Error>((res) => r.on("error", res));
    ac.abort();
    await closed;
    const e = await errored;
    expect(e.name).toBe("AbortError");
  });

  it("duplexPair cross-connects two duplexes", async () => {
    const [a, b] = duplexPair();
    const seen: unknown[] = [];
    b.on("data", (c) => seen.push(c));
    a.write("ping");
    await vi.waitFor(() => expect(seen).toEqual(["ping"]));
  });
});

describe("Readable.from", () => {
  it("wraps iterables in objectMode", async () => {
    const r = Readable.from([1, 2, 3]);
    const got: unknown[] = [];
    for await (const c of r) got.push(c);
    expect(got).toEqual([1, 2, 3]);
  });

  it("wraps async iterables", async () => {
    async function* gen() {
      yield "x";
      yield "y";
    }
    const r = Readable.from(gen());
    const got: unknown[] = [];
    for await (const c of r) got.push(c);
    expect(got).toEqual(["x", "y"]);
  });
});

describe("web interop", () => {
  it("Readable.toWeb yields a working ReadableStream", async () => {
    const r = Readable.from(["a", "b"]);
    const ws = Readable.toWeb(r);
    const reader = ws.getReader();
    const got: unknown[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      got.push((value as Buffer).toString());
    }
    expect(got).toEqual(["a", "b"]);
  });

  it("Readable.fromWeb consumes a web ReadableStream", async () => {
    const ws = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("hi"));
        c.close();
      },
    });
    const r = Readable.fromWeb(ws);
    const got: unknown[] = [];
    for await (const c of r) got.push(c);
    expect(got).toHaveLength(1);
  });

  it("Writable.toWeb writes through to the node stream", async () => {
    const got: unknown[] = [];
    const w = new Writable({
      objectMode: true,
      write(c, _e, cb) {
        got.push(c);
        cb();
      },
    });
    const ws = Writable.toWeb(w);
    const writer = ws.getWriter();
    await writer.write("chunk");
    await writer.close();
    await vi.waitFor(() => expect(got).toEqual(["chunk"]));
    expect(w.writableFinished).toBe(true);
  });

  it("stream/web module re-exports globals", () => {
    expect(streamWeb.ReadableStream).toBe(globalThis.ReadableStream);
    expect(streamWeb.WritableStream).toBe(globalThis.WritableStream);
    expect(streamWeb.TransformStream).toBe(globalThis.TransformStream);
  });
});

describe("stream/consumers", () => {
  it("text() concatenates chunks", async () => {
    expect(await consumers.text(Readable.from(["he", "llo"]))).toBe("hello");
  });
  it("buffer() returns a Buffer", async () => {
    const b = await consumers.buffer(Readable.from(["ab"]));
    expect(b.toString()).toBe("ab");
  });
  it("bytes() returns Uint8Array", async () => {
    const b = await consumers.bytes(Readable.from(["ab"]));
    expect(b).toBeInstanceOf(Uint8Array);
  });
  it("json() parses", async () => {
    expect(await consumers.json(Readable.from(['{"a":1}']))).toEqual({ a: 1 });
  });
  it("arrayBuffer() returns an ArrayBuffer", async () => {
    const ab = await consumers.arrayBuffer(Readable.from(["ab"]));
    expect(ab).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(ab)).toBe("ab");
  });
  it("subpath module exposes the same API", async () => {
    expect(await streamConsumers.text(Readable.from(["z"]))).toBe("z");
  });
});

describe("stream/promises subpath", () => {
  it("exposes pipeline and finished", async () => {
    expect(streamPromises.pipeline).toBe(promises.pipeline);
    expect(streamPromises.finished).toBe(promises.finished);
    const r = new Readable({ read() {} });
    const p = streamPromises.finished(r);
    r.push(null);
    r.resume();
    await p;
  });
});

describe("Transform / PassThrough", () => {
  it("Transform applies _transform and _flush", async () => {
    const t = new Transform({
      transform(c, _e, cb) {
        cb(null, `${String(c)}-t`);
      },
      flush(cb) {
        cb(null, "flushed");
      },
    });
    const got: string[] = [];
    t.on("data", (c: Buffer) => got.push(c.toString()));
    const done = new Promise<void>((res) => t.on("end", res));
    t.write("a");
    t.end();
    await done;
    expect(got).toEqual(["a-t", "flushed"]);
  });

  it("PassThrough forwards chunks unmodified", async () => {
    const p = new PassThrough();
    const got: string[] = [];
    p.on("data", (c: Buffer) => got.push(c.toString()));
    const done = new Promise<void>((res) => p.on("end", res));
    p.write("x");
    p.end();
    await done;
    expect(got).toEqual(["x"]);
  });

  it("Transform writable side emits 'finish' and readable side 'end'", async () => {
    const t = new PassThrough();
    const order: string[] = [];
    t.on("finish", () => order.push("finish"));
    const done = new Promise<void>((res) => t.on("end", res));
    t.resume();
    t.end("tail");
    await done;
    expect(order).toEqual(["finish"]);
  });
});

describe("default highWaterMark", () => {
  it("get/setDefaultHighWaterMark", () => {
    expect(shim.getDefaultHighWaterMark(false)).toBe(16 * 1024);
    expect(shim.getDefaultHighWaterMark(true)).toBe(16);
    shim.setDefaultHighWaterMark(false, 1024);
    try {
      const w = new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
      expect(w._writableState.highWaterMark).toBe(1024);
    } finally {
      shim.setDefaultHighWaterMark(false, 16 * 1024);
    }
  });
});
