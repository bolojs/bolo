import {
  Deflate as FflateDeflate,
  Gunzip as FflateGunzip,
  Gzip as FflateGzip,
  Inflate as FflateInflate,
  Unzlib as FflateUnzlib,
  Unzip as FflateUnzip,
  Zlib as FflateZlib,
} from "fflate";

import { Buffer, toU8, type BinaryLike } from "../internal/binary.js";
import {
  brotliCompressSync,
  brotliDecompressSync,
  type BrotliOptions,
  type ZlibOptions,
} from "./codecs.js";

/**
 * Minimal evented Transform for the zlib stream classes. unenv's Transform is
 * a shape-only stub (no emitter), so the zlib streams carry their own
 * write/end/pipe/on('data'|'end'|'error') machinery — enough for
 * `src.pipe(createGzip()).pipe(dst)` and manual `write`/`end` flows.
 */
type Listener = (...args: never[]) => void;

interface PushSource {
  push(chunk: Uint8Array, last: boolean): void;
  ondata: ((chunk: Uint8Array, final: boolean) => void) | null;
}

export class ZlibBase {
  #listeners = new Map<string, Set<Listener>>();
  #output: Buffer[] = [];
  #ended = false;
  #flowing = false;
  #source: PushSource | null;
  #buffered: Uint8Array[] | null;
  #flushFn: ((chunks: Uint8Array[]) => Uint8Array | Promise<Uint8Array>) | null;
  #pendingFlush: Promise<unknown> | null = null;

  constructor(
    source: PushSource | null,
    bufferedFlush?: (chunks: Uint8Array[]) => Uint8Array | Promise<Uint8Array>,
  ) {
    this.#source = source;
    this.#flushFn = bufferedFlush ?? null;
    this.#buffered = bufferedFlush ? [] : null;
    if (source) {
      source.ondata = (chunk, _final) => {
        this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
      };
    }
  }

  // ---- EventEmitter subset ----

  on(event: string, listener: Listener): this {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener);
    if (event === "data") this.#drain();
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrap = ((...args: unknown[]) => {
      this.off(event, wrap);
      (listener as (...a: unknown[]) => void)(...args);
    }) as Listener;
    return this.on(event, wrap);
  }

  off(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) {
      if (event === "error") {
        throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
      }
      return false;
    }
    for (const l of [...set]) (l as (...a: unknown[]) => void)(...args);
    return true;
  }

  // ---- readable/writable subset ----

  push(chunk: Buffer | null): boolean {
    if (chunk === null) {
      this.#ended = true;
      queueMicrotask(() => {
        this.emit("end");
        this.emit("finish");
      });
      return false;
    }
    this.#output.push(chunk);
    this.#drain();
    return true;
  }

  #drain(): void {
    const set = this.#listeners.get("data");
    if (!set || set.size === 0) return;
    this.#flowing = true;
    const queued = this.#output.splice(0);
    for (const c of queued) this.emit("data", c);
  }

  read(): Buffer | null {
    return this.#output.length ? Buffer.concat(this.#output.splice(0)) : null;
  }

  write(
    chunk: BinaryLike,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    try {
      this.#transform(toU8(chunk), false);
      done?.(null);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      done?.(e);
      queueMicrotask(() => this.emit("error", e));
    }
    return true;
  }

  end(
    chunk?: BinaryLike | (() => void),
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ): this {
    const data = typeof chunk === "function" ? undefined : chunk;
    const done =
      (typeof chunk === "function" ? chunk : undefined) ??
      (typeof encodingOrCb === "function" ? encodingOrCb : undefined) ??
      cb;
    try {
      if (data !== undefined) this.#transform(toU8(data), false);
      this.#transform(new Uint8Array(0), true);
      const finish = (): void => {
        this.push(null);
        if (done) queueMicrotask(done);
      };
      // Buffered codecs with an async flush (zstd) finish on the flush
      // promise so 'data' precedes 'end'.
      if (this.#pendingFlush) this.#pendingFlush.then(finish, finish);
      else finish();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      queueMicrotask(() => this.emit("error", e));
    }
    return this;
  }

  #transform(chunk: Uint8Array, last: boolean): void {
    if (this.#source) {
      this.#source.push(chunk, last);
      return;
    }
    // Buffered codecs (Brotli, zstd) accumulate until end().
    this.#buffered?.push(chunk);
    if (last && this.#flushFn && this.#buffered) {
      const result = this.#flushFn(this.#buffered);
      if (result instanceof Promise) {
        this.#pendingFlush = result.then(
          (r) => {
            this.push(Buffer.from(r.buffer, r.byteOffset, r.length));
          },
          (err) => {
            const e = err instanceof Error ? err : new Error(String(err));
            queueMicrotask(() => this.emit("error", e));
          },
        );
      } else {
        this.push(Buffer.from(result.buffer, result.byteOffset, result.length));
      }
    }
  }

  flush(cb?: () => void): void {
    if (this.#source) this.#source.push(new Uint8Array(0), false);
    cb?.();
  }

  close(cb?: () => void): void {
    cb?.();
  }

  pipe<
    T extends {
      write(c: BinaryLike): unknown;
      end(): unknown;
      on?(e: string, l: Listener): unknown;
    },
  >(dest: T, opts?: { end?: boolean }): T {
    this.on("data", ((c: Buffer) => dest.write(c)) as Listener);
    this.on("error", ((e: Error) => {
      if (typeof dest.on === "function") dest.on("error", (() => {}) as Listener);
      (dest as unknown as { emit?: (e: string, a: unknown) => void }).emit?.("error", e);
    }) as Listener);
    if (opts?.end !== false) this.on("end", (() => dest.end()) as Listener);
    return dest;
  }

  unpipe(_dest?: unknown): this {
    this.#listeners.delete("data");
    this.#listeners.delete("end");
    return this;
  }

  get readableEnded(): boolean {
    return this.#ended;
  }

  get bytesWritten(): number {
    return 0;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    // 'data' events are consumed by the emit path (chunks leave #output), so
    // the iterator collects them into its own queue instead of racing read().
    const queue: Buffer[] = [];
    let notify: (() => void) | null = null;
    const onData = ((c: Buffer) => {
      queue.push(c);
      notify?.();
    }) as Listener;
    const onEnd = (() => notify?.()) as Listener;
    this.on("data", onData);
    this.on("end", onEnd);
    try {
      for (;;) {
        while (queue.length) yield queue.shift() as Buffer;
        // Chunks buffered before the listener attached are still in #output.
        const rest = this.read();
        if (rest) yield rest;
        if (this.#ended) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      this.off("data", onData);
      this.off("end", onEnd);
    }
  }
}

// ---- concrete codec streams ----

type FflateLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

const toFflateOpts = (opts?: ZlibOptions): { level?: FflateLevel; dictionary?: Uint8Array } => {
  const out: { level?: FflateLevel; dictionary?: Uint8Array } = {};
  if (opts?.level !== undefined) out.level = opts.level as FflateLevel;
  if (opts?.dictionary !== undefined) out.dictionary = toU8(opts.dictionary);
  return out;
};

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

export class Deflate extends ZlibBase {
  constructor(opts?: ZlibOptions) {
    super(new FflateZlib(toFflateOpts(opts)) as unknown as PushSource);
  }
}
export class Inflate extends ZlibBase {
  constructor(opts?: ZlibOptions) {
    super(new FflateUnzlib(toFflateOpts(opts)) as unknown as PushSource);
  }
}
export class DeflateRaw extends ZlibBase {
  constructor(opts?: ZlibOptions) {
    super(new FflateDeflate(toFflateOpts(opts)) as unknown as PushSource);
  }
}
export class InflateRaw extends ZlibBase {
  constructor(opts?: ZlibOptions) {
    super(new FflateInflate(toFflateOpts(opts)) as unknown as PushSource);
  }
}
export class Gzip extends ZlibBase {
  constructor(opts?: ZlibOptions) {
    super(new FflateGzip(toFflateOpts(opts)) as unknown as PushSource);
  }
}
export class Gunzip extends ZlibBase {
  constructor(opts?: ZlibOptions) {
    super(new FflateGunzip(toFflateOpts(opts)) as unknown as PushSource);
  }
}
export class Unzip extends ZlibBase {
  constructor(opts?: ZlibOptions) {
    super(new FflateUnzip() as unknown as PushSource);
  }
}

export class BrotliCompress extends ZlibBase {
  constructor(opts?: BrotliOptions) {
    super(null, (chunks) => {
      const r = brotliCompressSync(concat(chunks), opts);
      return r instanceof Uint8Array || Buffer.isBuffer(r) ? (r as Buffer) : r.buffer;
    });
  }
}
export class BrotliDecompress extends ZlibBase {
  constructor(opts?: BrotliOptions) {
    super(null, (chunks) => {
      const r = brotliDecompressSync(concat(chunks), opts);
      return r instanceof Uint8Array || Buffer.isBuffer(r) ? (r as Buffer) : r.buffer;
    });
  }
}

export const createDeflate = (opts?: ZlibOptions): Deflate => new Deflate(opts);
export const createInflate = (opts?: ZlibOptions): Inflate => new Inflate(opts);
export const createDeflateRaw = (opts?: ZlibOptions): DeflateRaw => new DeflateRaw(opts);
export const createInflateRaw = (opts?: ZlibOptions): InflateRaw => new InflateRaw(opts);
export const createGzip = (opts?: ZlibOptions): Gzip => new Gzip(opts);
export const createGunzip = (opts?: ZlibOptions): Gunzip => new Gunzip(opts);
export const createUnzip = (opts?: ZlibOptions): Unzip => new Unzip(opts);
export const createBrotliCompress = (opts?: BrotliOptions): BrotliCompress =>
  new BrotliCompress(opts);
export const createBrotliDecompress = (opts?: BrotliOptions): BrotliDecompress =>
  new BrotliDecompress(opts);
