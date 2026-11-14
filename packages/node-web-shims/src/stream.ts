/**
 * node:stream shim — faithful port of Node's lib/internal/streams semantics
 * (Node v22), replacing unenv's thin stubs. unenv's Readable.push() is a no-op
 * in flowing mode, pipeline/finished/PassThrough/compose throw
 * "not implemented", and `stream/promises` is stubbed — this module implements
 * the real machinery:
 *
 *  - Function-constructor classes (`Readable()` without `new` returns a new
 *    instance, like Node), legacy `Stream` base callable via `.call(this)`.
 *  - Backpressure: highWaterMark, readableLength/writableLength, write()
 *    return value + 'drain', pipe() await-drain.
 *  - cork()/uncork() buffering, _writev batching.
 *  - destroy(err) -> 'error' -> 'close' ordering; 'finish' emitted a tick
 *    after a synchronous 'prefinish'/_final; 'end'/'readable'/'data' ordering
 *    per lib/internal/streams/readable.js.
 *  - objectMode, Symbol.asyncIterator + iterator helpers (map/filter/...),
 *    Symbol.asyncDispose.
 *  - pipeline/finished/compose/addAbortSignal/duplexPair, promises facade.
 *  - Readable/Writable/Duplex toWeb/fromWeb interop and stream/consumers.
 */

import { EventEmitter as _EventEmitter, init as initEmitter, addAbortListener } from "./events.js";
import { Buffer as _Buffer } from "./buffer.js";

// `_EventEmitter`/`_Buffer` come through unenv shim wrappers whose `.d.ts`
// surface is value-only (`unknown`/`const`). Re-expose them here with the
// concrete instance types our port needs.
const EventEmitter = _EventEmitter;
type EventEmitter = InstanceType<typeof _EventEmitter>;
const Buffer = _Buffer as typeof import("node:buffer").Buffer & {
  isView: (v: unknown) => v is ArrayBufferView;
};

// ---------------------------------------------------------------------------
// Scheduling + errors
// ---------------------------------------------------------------------------

const g = globalThis as {
  process?: { nextTick?: (fn: (...a: unknown[]) => void, ...args: unknown[]) => void };
  __browserContainers?: {
    process?: { nextTick?: (fn: (...a: unknown[]) => void, ...args: unknown[]) => void };
    shims?: {
      process?: { nextTick?: (fn: (...a: unknown[]) => void, ...args: unknown[]) => void };
    };
  };
};

// Prefer the realm's process.nextTick when one exists (Node semantics:
// drains before promise jobs); container realms keep the process shim on
// `__browserContainers` rather than a global `process`, so check both.
// queueMicrotask is the last resort — it interleaves with promise jobs
// instead of draining first, which breaks Node's readable-event ordering.
const nextTick = (fn: (...args: any[]) => void, ...args: unknown[]): void => {
  const proc = g.process ?? g.__browserContainers?.process ?? g.__browserContainers?.shims?.process;
  const nt = proc?.nextTick;
  if (typeof nt === "function") {
    nt.call(proc, fn as (...a: unknown[]) => void, ...args);
  } else {
    queueMicrotask(() => (fn as (...a: unknown[]) => void)(...args));
  }
};

interface ErrnoException extends Error {
  code?: string;
  context?: unknown;
}

const makeError = (code: string, message: string): ErrnoException => {
  const err = new Error(message) as ErrnoException;
  err.code = code;
  err.name = code;
  return err;
};

class AbortError extends Error {
  code = "ABORT_ERR";
  name = "AbortError";
  constructor(message = "The operation was aborted") {
    super(message);
  }
}

const aggregateTwoErrors = (a: unknown, b: unknown): unknown => {
  if (a && b && a !== b) {
    const err = b as ErrnoException;
    (err as { errors?: unknown[] }).errors = [a, b];
    return err;
  }
  return b ?? a;
};

const ERR = {
  METHOD_NOT_IMPLEMENTED: (m: string) =>
    makeError("ERR_METHOD_NOT_IMPLEMENTED", `The ${m} method is not implemented`),
  INVALID_ARG_TYPE: (name: string, expected: string | string[], actual: unknown) =>
    makeError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be of type ${
        Array.isArray(expected) ? "one of " + expected.join(", ") : expected
      }. Received ${typeof actual === "object" ? JSON.stringify(actual) : String(actual)}`,
    ),
  INVALID_ARG_VALUE: (name: string, value: unknown) =>
    makeError(
      "ERR_INVALID_ARG_VALUE",
      `The argument '${name}' is invalid. Received ${String(value)}`,
    ),
  MISSING_ARGS: (name: string) =>
    makeError("ERR_MISSING_ARGS", `The "${name}" argument must be specified`),
  MULTIPLE_CALLBACK: () => makeError("ERR_MULTIPLE_CALLBACK", "Callback called multiple times"),
  STREAM_NULL_VALUES: () =>
    makeError("ERR_STREAM_NULL_VALUES", "May not write null values to stream"),
  STREAM_WRITE_AFTER_END: () => makeError("ERR_STREAM_WRITE_AFTER_END", "write after end"),
  STREAM_PUSH_AFTER_EOF: () => makeError("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF"),
  STREAM_DESTROYED: (method: string) =>
    makeError("ERR_STREAM_DESTROYED", `Cannot call ${method} after a stream was destroyed`),
  STREAM_ALREADY_FINISHED: (method: string) =>
    makeError("ERR_STREAM_ALREADY_FINISHED", `Cannot call ${method} after a stream was finished`),
  STREAM_CANNOT_PIPE: () => makeError("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable"),
  STREAM_PREMATURE_CLOSE: () => makeError("ERR_STREAM_PREMATURE_CLOSE", "Premature close"),
  UNKNOWN_ENCODING: (enc: unknown) =>
    makeError("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${String(enc)}`),
};

const nop = (): void => {};

const isArrayBufferView = (value: unknown): value is ArrayBufferView => ArrayBuffer.isView(value);

const isUint8Array = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

const uint8ArrayToBuffer = (chunk: Uint8Array): Buffer =>
  Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

const isIterable = (x: unknown): x is Iterable<unknown> =>
  typeof (x as { [Symbol.iterator]?: unknown } | null)?.[Symbol.iterator] === "function";
const isAsyncIterable = (x: unknown): x is AsyncIterable<unknown> =>
  typeof (x as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === "function";
const isReadableStreamLike = (x: unknown): x is ReadableStream =>
  typeof x === "object" && x !== null && typeof (x as ReadableStream).getReader === "function";
const isWritableStreamLike = (x: unknown): x is WritableStream =>
  typeof x === "object" && x !== null && typeof (x as WritableStream).getWriter === "function";

const normalizeEncoding = (enc: string): string => {
  const e = enc.toLowerCase();
  if (e === "utf8" || e === "utf-8") return "utf8";
  if (e === "latin1" || e === "binary") return "latin1";
  if (e === "ucs2" || e === "ucs-2" || e === "utf16le" || e === "utf-16le") return "utf16le";
  if (e === "base64" || e === "base64url") return "base64";
  if (e === "hex") return "hex";
  if (e === "ascii") return "ascii";
  return e;
};

const isValidEncoding = (enc: string): boolean => {
  const e = normalizeEncoding(enc);
  return (
    e === "utf8" ||
    e === "latin1" ||
    e === "utf16le" ||
    e === "base64" ||
    e === "hex" ||
    e === "ascii"
  );
};

/**
 * Minimal streaming decoder backing setEncoding()/options.encoding. utf8 and
 * utf16le go through a streaming TextDecoder; latin1 maps byte->charCode
 * directly (exact ISO-8859-1, unlike TextDecoder's windows-1252); hex/base64/
 * ascii are best-effort per-chunk decodes.
 */
class StreamDecoder {
  private decoder?: TextDecoder;
  private readonly enc: string;
  constructor(enc: string) {
    this.enc = normalizeEncoding(enc);
    if (this.enc === "utf8") this.decoder = new TextDecoder("utf-8");
    else if (this.enc === "utf16le") this.decoder = new TextDecoder("utf-16le");
  }
  write(buf: Uint8Array | Buffer): string {
    if (this.decoder) return this.decoder.decode(buf as Uint8Array, { stream: true });
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as Uint8Array);
    if (this.enc === "latin1") {
      let s = "";
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return s;
    }
    return b.toString((this.enc === "ascii" ? "latin1" : this.enc) as BufferEncoding);
  }
  end(): string {
    return this.decoder ? this.decoder.decode() : "";
  }
}

// ---------------------------------------------------------------------------
// Default highWaterMark (lib/internal/streams/state.js)
// ---------------------------------------------------------------------------

let defaultHighWaterMarkBytes = 16 * 1024;
let defaultHighWaterMarkObjectMode = 16;

export const getDefaultHighWaterMark = (objectMode: boolean): number =>
  objectMode ? defaultHighWaterMarkObjectMode : defaultHighWaterMarkBytes;

export const setDefaultHighWaterMark = (objectMode: boolean, value: number): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw ERR.INVALID_ARG_VALUE("value", value);
  }
  if (objectMode) defaultHighWaterMarkObjectMode = value;
  else defaultHighWaterMarkBytes = value;
};

const getHighWaterMark = (
  state: { objectMode: boolean },
  options: StreamOptions | undefined,
  duplexKey: "readableHighWaterMark" | "writableHighWaterMark",
  isDuplex: boolean,
): number => {
  const hwm = options
    ? options.highWaterMark != null
      ? options.highWaterMark
      : isDuplex
        ? options[duplexKey]
        : null
    : null;
  if (hwm != null) {
    if (!Number.isInteger(hwm) || hwm < 0) {
      throw ERR.INVALID_ARG_VALUE(isDuplex ? `options.${duplexKey}` : "options.highWaterMark", hwm);
    }
    return Math.floor(hwm);
  }
  return getDefaultHighWaterMark(state.objectMode);
};

// ---------------------------------------------------------------------------
// Legacy Stream base (lib/internal/streams/legacy.js)
// ---------------------------------------------------------------------------

export interface StreamOptions {
  objectMode?: boolean;
  highWaterMark?: number;
  readableHighWaterMark?: number;
  writableHighWaterMark?: number;
  readableObjectMode?: boolean;
  writableObjectMode?: boolean;
  readable?: boolean;
  writable?: boolean;
  allowHalfOpen?: boolean;
  emitClose?: boolean;
  autoDestroy?: boolean;
  construct?: (cb: (err?: Error | null) => void) => void;
  destroy?: (err: Error | null, cb: (err?: Error | null) => void) => void;
  read?: (size: number) => void;
  write?: (chunk: unknown, encoding: string, cb: (err?: Error | null) => void) => void;
  writev?: (
    chunks: Array<{ chunk: unknown; encoding: string }>,
    cb: (err?: Error | null) => void,
  ) => void;
  final?: (cb: (err?: Error | null) => void) => void;
  transform?: (
    chunk: unknown,
    encoding: string,
    cb: (err?: Error | null, data?: unknown) => void,
  ) => void;
  flush?: (cb: (err?: Error | null, data?: unknown) => void) => void;
  signal?: AbortSignal;
  encoding?: string;
  defaultEncoding?: string;
  decodeStrings?: boolean;
}

type DestLike = {
  writable?: boolean;
  write?: (chunk: unknown, encoding?: string | ((err?: Error | null) => void)) => unknown;
  end?: (cb?: () => void) => unknown;
  emit?: (ev: string, ...args: unknown[]) => unknown;
  on?: (ev: string, fn: (...args: any[]) => void) => unknown;
  once?: (ev: string, fn: (...args: any[]) => void) => unknown;
  removeListener?: (ev: string, fn: (...args: any[]) => void) => unknown;
  listenerCount?: (ev: string) => number;
  _writableState?: WritableState;
  _isStdio?: boolean;
  writableNeedDrain?: boolean;
};

export interface Stream extends EventEmitter {
  readable?: boolean;
  writable?: boolean;
  _readableState?: ReadableState;
  _writableState?: WritableState;
  pipe<T extends DestLike>(dest: T, options?: { end?: boolean }): T;
  pause?(): unknown;
  resume?(): unknown;
  destroyed?: boolean;
}
export interface StreamCtor {
  new (opts?: StreamOptions): Stream;
  (this: Stream, opts?: StreamOptions): void;
  prototype: Stream;
}

const prependListener = (
  emitter: EventEmitter & { _events?: Record<string, unknown> },
  event: string,
  fn: (...args: any[]) => void,
): void => {
  if (typeof emitter.prependListener === "function") {
    emitter.prependListener(event, fn);
    return;
  }
  const events = emitter._events;
  if (!events || events[event] === undefined) emitter.on(event, fn);
  else if (Array.isArray(events[event])) (events[event] as unknown[]).unshift(fn);
  else events[event] = [fn, events[event]];
};

/**
 * `stream.Stream` — Node's legacy base. A plain function constructor, so
 * `stream.Stream.call(this)` works for old-style subclasses and `new Stream()`
 * initializes an EventEmitter.
 */
export const Stream = function Stream(this: Stream, _opts?: StreamOptions): void {
  initEmitter(this);
} as unknown as StreamCtor;
Object.setPrototypeOf(Stream.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Stream, EventEmitter);

Stream.prototype.pipe = function pipe<T extends DestLike>(
  this: Stream & { pause?: () => void; resume?: () => void; on: EventEmitter["on"] },
  dest: T,
  options?: { end?: boolean },
): T {
  const ondata = (chunk: unknown): void => {
    if (
      dest.writable &&
      typeof dest.write === "function" &&
      dest.write(chunk) === false &&
      this.pause
    ) {
      this.pause();
    }
  };

  const ondrain = (): void => {
    if (this.readable && this.resume) {
      this.resume();
    }
  };

  this.on("data", ondata);
  dest.on!("drain", ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // this gets the 'end' or 'close' events. Only dest.end() once.
  let didOnEnd = false;
  const onend = (): void => {
    if (typeof dest.end === "function" && !didOnEnd) {
      didOnEnd = true;
      dest.end();
    }
  };
  if (!dest._isStdio && (!options || options.end !== false)) {
    this.on("end", onend);
    this.on("close", onend);
  }

  let didOnError = false;
  const onerror = (err: unknown): void => {
    if (didOnError) return;
    didOnError = true;
    cleanup();
    // Only suppress the throw if dest has an 'error' listener — Node leaves
    // error propagation to the dest otherwise.
    if (typeof dest.emit === "function" && dest.emit("error", err) === false) {
      throw err;
    }
  };

  prependListener(
    this as unknown as EventEmitter & { _events?: Record<string, unknown> },
    "error",
    onerror as never,
  );
  prependListener(
    dest as unknown as EventEmitter & { _events?: Record<string, unknown> },
    "error",
    onerror as never,
  );

  const cleanup = (): void => {
    this.removeListener("data", ondata);
    dest.removeListener!("drain", ondrain);
    this.removeListener("end", onend);
    this.removeListener("close", onend);
    this.removeListener("error", onerror as never);
    dest.removeListener!("error", onerror as never);
    this.removeListener("end", cleanup);
    this.removeListener("close", cleanup);
    dest.removeListener!("close", cleanup);
  };
  this.on("end", cleanup);
  this.on("close", cleanup);
  dest.on!("close", cleanup);

  dest.emit!("pipe", this);

  return dest;
};

// ---------------------------------------------------------------------------
// Stream predicates (lib/internal/streams/utils.js)
// ---------------------------------------------------------------------------

interface ReadableStateShape {
  objectMode: boolean;
  highWaterMark: number;
  buffer: unknown[];
  bufferIndex: number;
  length: number;
  pipes: DestLike[];
  hasFlowing: boolean;
  flowing: boolean;
  hasPaused: boolean;
  paused: boolean;
  ended: boolean;
  endEmitted: boolean;
  reading: boolean;
  sync: boolean;
  needReadable: boolean;
  emittedReadable: boolean;
  readableListening: boolean;
  dataListening: boolean;
  resumeScheduled: boolean;
  awaitDrainWriters: DestLike | Set<DestLike> | null;
  multiAwaitDrain: boolean;
  readingMore: boolean;
  dataEmitted: boolean;
  decoder: StreamDecoder | null;
  encoding: string | null;
  destroyed: boolean;
  closed: boolean;
  closeEmitted: boolean;
  errored: Error | null;
  errorEmitted: boolean;
  emitClose: boolean;
  autoDestroy: boolean;
  constructed: boolean;
  aborted: boolean;
  defaultEncoding: string;
  readable: boolean;
  awaitDrain?: number;
}

interface BufferedChunk {
  chunk: unknown;
  encoding: string;
  callback: (err?: Error | null) => void;
}

interface WritableStateShape {
  objectMode: boolean;
  highWaterMark: number;
  finalCalled: boolean;
  needDrain: boolean;
  ending: boolean;
  ended: boolean;
  finished: boolean;
  destroyed: boolean;
  decodeStrings: boolean;
  defaultEncoding: string;
  length: number;
  writing: boolean;
  corked: number;
  sync: boolean;
  bufferProcessing: boolean;
  writecb: ((err?: Error | null) => void) | null;
  writelen: number;
  buffered: BufferedChunk[];
  bufferedIndex: number;
  pendingcb: number;
  prefinished: boolean;
  errorEmitted: boolean;
  emitClose: boolean;
  autoDestroy: boolean;
  errored: Error | null;
  closed: boolean;
  closeEmitted: boolean;
  constructed: boolean;
  onFinished: Array<(err?: Error | null) => void>;
  writable: boolean;
  expectWriteCb: boolean;
}

type ReadableState = ReadableStateShape;
type WritableState = WritableStateShape;

type AnyStream = Stream & {
  _readableState?: ReadableState;
  _writableState?: WritableState;
  readable?: boolean;
  writable?: boolean;
  readableEnded?: boolean;
  writableEnded?: boolean;
  writableFinished?: boolean;
  readableAborted?: boolean;
  readableDidRead?: boolean;
  readableFlowing?: boolean | null;
  closed?: boolean;
  errored?: Error | null;
  destroyed?: boolean;
  aborted?: boolean;
  abort?: () => void;
  setHeader?: (...a: unknown[]) => unknown;
  req?: {
    on: (ev: string, fn: (...a: never[]) => void) => unknown;
    removeListener: (ev: string, fn: (...a: never[]) => void) => unknown;
  };
  destroy?: (err?: Error) => unknown;
  end?: (...a: unknown[]) => unknown;
  write?: (...a: unknown[]) => unknown;
};

const isReadableNodeStream = (stream: unknown, strict = false): boolean => {
  const s = stream as (AnyStream & EventEmitter) | null;
  return Boolean(
    s &&
    typeof s.pipe === "function" &&
    typeof s.on === "function" &&
    (!strict || (typeof s.pause === "function" && typeof s.resume === "function")) &&
    (!s._writableState || s._readableState?.readable !== false) &&
    // Duplex
    (!s._writableState || s._readableState),
  );
};

const isWritableNodeStream = (stream: unknown): boolean => {
  const s = stream as AnyStream | null;
  return (
    typeof s === "object" &&
    s !== null &&
    s._writableState !== undefined &&
    s._writableState.writable !== false &&
    typeof s.write === "function" &&
    typeof s.end === "function"
  );
};

const isNodeStream = (stream: unknown): boolean =>
  isReadableNodeStream(stream) || isWritableNodeStream(stream);

const isWebStream = (stream: unknown): boolean =>
  isReadableStreamLike(stream) || isWritableStreamLike(stream);

const isReadableFinished = (stream: AnyStream, strict?: boolean): boolean | undefined => {
  const rState = stream._readableState;
  if (rState?.errored) return false;
  if (rState?.readable === false) return undefined;
  if (stream.readableEnded === true) return true;
  return strict ? undefined : false;
};

const isWritableFinished = (stream: AnyStream, strict?: boolean): boolean | undefined => {
  const wState = stream._writableState;
  if (wState?.errored) return false;
  if (wState?.writable === false) return undefined;
  if (stream.writableFinished === true) return true;
  return strict ? undefined : false;
};

const willEmitClose = (stream: AnyStream): boolean => {
  const rState = stream._readableState;
  const wState = stream._writableState;
  if (rState) return rState.emitClose !== false && rState.closed !== true;
  if (wState) return wState.emitClose !== false && wState.closed !== true;
  return stream.closed !== true;
};

export const isDisturbed = (stream: unknown): boolean => {
  const s = stream as AnyStream | null;
  return Boolean(s && (s.readableDidRead || s.readableAborted));
};

export const isErrored = (stream: unknown): boolean => {
  const s = stream as AnyStream | null;
  if (!s || typeof s !== "object") return false;
  return Boolean(s.errored ?? s._readableState?.errored ?? s._writableState?.errored ?? null);
};

export const getErrored = (stream: unknown): Error | null => {
  const s = stream as AnyStream | null;
  if (!s || typeof s !== "object") return null;
  return (s.errored ??
    s._readableState?.errored ??
    s._writableState?.errored ??
    null) as Error | null;
};

export const isDestroyed = (stream: unknown): boolean => {
  const s = stream as AnyStream | null;
  if (!s || typeof s !== "object") return false;
  return Boolean(
    (s._writableState?.destroyed ?? s._readableState?.destroyed) ||
    (s.destroyed && s._readableState === undefined && s._writableState === undefined),
  );
};

export const isReadable = (stream: unknown): boolean | null => {
  const s = stream as AnyStream | null;
  if (!s || typeof s !== "object") return false;
  if (s._readableState) return !isReadableFinished(s);
  const r = s.readable;
  return r === null || r === undefined ? null : Boolean(r);
};

export const isWritable = (stream: unknown): boolean | null => {
  const s = stream as AnyStream | null;
  if (!s || typeof s !== "object") return false;
  if (s._writableState) return !isWritableFinished(s);
  const w = s.writable;
  return w === null || w === undefined ? null : Boolean(w);
};

// ---------------------------------------------------------------------------
// destroy machinery (lib/internal/streams/destroy.js)
// ---------------------------------------------------------------------------

const kDestroy = Symbol("bolo.stream.kDestroy");
const kConstruct = Symbol("bolo.stream.kConstruct");

const checkError = (err: unknown, w?: WritableState, r?: ReadableState): void => {
  if (err) {
    if (w && !w.errored) w.errored = err as Error;
    if (r && !r.errored) r.errored = err as Error;
  }
};

const destroyImpl = {
  destroy(this: AnyStream & EventEmitter, err?: Error | null, cb?: (err?: Error | null) => void) {
    const r = this._readableState;
    const w = this._writableState;
    const s = w ?? r;

    if ((w && w.destroyed) || (r && r.destroyed)) {
      if (typeof cb === "function") cb();
      return this;
    }

    checkError(err, w, r);

    if (w) w.destroyed = true;
    if (r) r.destroyed = true;

    // If still constructing then defer calling _destroy.
    if (s && !s.constructed) {
      this.once(kDestroy as unknown as string, (er?: Error | null) => {
        callDestroy(this, aggregateTwoErrors(er, err) as Error | null, cb);
      });
    } else {
      callDestroy(this, err ?? null, cb);
    }

    return this;
  },

  undestroy(this: AnyStream) {
    const r = this._readableState;
    const w = this._writableState;

    if (r) {
      r.constructed = true;
      r.closed = false;
      r.closeEmitted = false;
      r.destroyed = false;
      r.errored = null;
      r.errorEmitted = false;
      r.reading = false;
      r.ended = r.readable === false;
      r.endEmitted = r.readable === false;
    }

    if (w) {
      w.constructed = true;
      w.destroyed = false;
      w.closed = false;
      w.closeEmitted = false;
      w.errored = null;
      w.errorEmitted = false;
      w.finalCalled = false;
      w.prefinished = false;
      w.ended = w.writable === false;
      w.ending = w.writable === false;
      w.finished = w.writable === false;
    }
  },

  errorOrDestroy(stream: AnyStream & EventEmitter, err: unknown, sync?: boolean) {
    const r = stream._readableState;
    const w = stream._writableState;

    if ((w && w.destroyed) || (r && r.destroyed)) return stream;

    if ((r && r.autoDestroy) || (w && w.autoDestroy)) {
      (stream as { destroy: (e?: Error) => unknown }).destroy(err as Error);
    } else if (err) {
      if (w && !w.errored) w.errored = err as Error;
      if (r && !r.errored) r.errored = err as Error;
      if (sync) nextTick(emitErrorNT, stream, err);
      else emitErrorNT(stream, err);
    }
  },

  construct(stream: AnyStream & EventEmitter, cb: (err?: Error | null) => void) {
    if (typeof (stream as { _construct?: unknown })._construct !== "function") {
      return;
    }

    const r = stream._readableState;
    const w = stream._writableState;

    if (r) r.constructed = false;
    if (w) w.constructed = false;

    stream.once(kConstruct as unknown as string, cb);

    nextTick(constructNT, stream);
  },
};

const constructNT = (stream: AnyStream & EventEmitter): void => {
  let called = false;
  const onConstruct = (err?: Error | null): void => {
    if (called) {
      errorOrDestroy(stream, ERR.MULTIPLE_CALLBACK());
      return;
    }
    called = true;

    const r = stream._readableState;
    const w = stream._writableState;
    const s = w ?? r;

    if (s) {
      s.constructed = true;
      if (err) s.errored = err;
    }

    if (err) {
      errorOrDestroy(stream, err, true);
      return;
    }

    stream.emit(kConstruct as unknown as string);
  };

  try {
    (stream as unknown as { _construct: (cb: (e?: Error | null) => void) => void })._construct(
      onConstruct,
    );
  } catch (err) {
    onConstruct(err as Error);
  }
};

const callDestroy = (
  self: AnyStream &
    EventEmitter & { _destroy?: (e: Error | null, cb: (e?: Error | null) => void) => void },
  err: Error | null,
  cb?: (err?: Error | null) => void,
): void => {
  let called = false;

  const onDestroy = (err2?: Error | null): void => {
    if (called) return;
    called = true;

    const r = self._readableState;
    const w = self._writableState;

    checkError(err2, w, r);

    if (w) w.closed = true;
    if (r) r.closed = true;

    if (typeof cb === "function") cb(err2);

    if (err2) {
      nextTick(emitErrorCloseNT, self, err2);
    } else {
      nextTick(emitCloseNT, self);
    }
  };

  try {
    if (typeof self._destroy === "function") {
      self._destroy(err ?? null, onDestroy);
    } else {
      onDestroy(err);
    }
  } catch (e) {
    onDestroy(e as Error);
  }
};

const emitErrorCloseNT = (self: AnyStream & EventEmitter, err: unknown): void => {
  emitErrorNT(self, err);
  emitCloseNT(self);
};

const emitCloseNT = (self: AnyStream & EventEmitter): void => {
  const r = self._readableState;
  const w = self._writableState;

  if (w) w.closeEmitted = true;
  if (r) r.closeEmitted = true;

  if ((w && w.emitClose) || (r && r.emitClose) || (!w && !r)) {
    self.emit("close");
  }
};

const emitErrorNT = (self: AnyStream & EventEmitter, err: unknown): void => {
  const r = self._readableState;
  const w = self._writableState;

  if ((w && w.errorEmitted) || (r && r.errorEmitted)) return;

  if (w) w.errorEmitted = true;
  if (r) r.errorEmitted = true;

  self.emit("error", err);
};

const errorOrDestroy = destroyImpl.errorOrDestroy;

// ---------------------------------------------------------------------------
// addAbortSignal (lib/internal/streams/add-abort-signal.js)
// ---------------------------------------------------------------------------

export const addAbortSignal = <T extends AnyStream & EventEmitter>(
  signal: AbortSignal,
  stream: T,
): T => {
  if (typeof signal !== "object" || !("aborted" in signal)) {
    throw ERR.INVALID_ARG_TYPE("signal", "AbortSignal", signal);
  }
  const onAbort = (): void => {
    (stream as { destroy: (e?: Error) => unknown }).destroy(new AbortError());
  };
  if (signal.aborted) {
    nextTick(onAbort);
  } else {
    addAbortListener(signal, onAbort);
    stream.once("close", () => signal.removeEventListener("abort", onAbort));
  }
  return stream;
};

// ---------------------------------------------------------------------------
// Writable (lib/internal/streams/writable.js)
// ---------------------------------------------------------------------------

const newWritableState = (options: StreamOptions | undefined, isDuplex: boolean): WritableState => {
  const state: WritableState = {
    objectMode: Boolean(options?.objectMode) || Boolean(isDuplex && options?.writableObjectMode),
    highWaterMark: 0,
    finalCalled: false,
    needDrain: false,
    ending: false,
    ended: false,
    finished: false,
    destroyed: false,
    decodeStrings: options?.decodeStrings !== false,
    defaultEncoding:
      options?.defaultEncoding && isValidEncoding(options.defaultEncoding)
        ? normalizeEncoding(options.defaultEncoding)
        : "utf8",
    length: 0,
    writing: false,
    corked: 0,
    sync: true,
    bufferProcessing: false,
    writecb: null,
    writelen: 0,
    buffered: [],
    bufferedIndex: 0,
    pendingcb: 0,
    prefinished: false,
    errorEmitted: false,
    emitClose: options?.emitClose !== false,
    autoDestroy: options?.autoDestroy !== false,
    errored: null,
    closed: false,
    closeEmitted: false,
    constructed: true,
    onFinished: [],
    writable: options?.writable !== false,
    expectWriteCb: false,
  };
  if (options?.defaultEncoding && !isValidEncoding(options.defaultEncoding)) {
    throw ERR.UNKNOWN_ENCODING(options.defaultEncoding);
  }
  state.highWaterMark = getHighWaterMark(
    { objectMode: state.objectMode },
    options,
    "writableHighWaterMark",
    isDuplex,
  );
  return state;
};

export interface Writable extends Stream {
  _writableState: WritableState;
  _write(chunk: unknown, encoding: string, cb: (err?: Error | null) => void): void;
  _writev?(
    chunks: Array<{ chunk: unknown; encoding: string }>,
    cb: (err?: Error | null) => void,
  ): void;
  _final?(cb: (err?: Error | null) => void): void;
  _construct?(cb: (err?: Error | null) => void): void;
  _destroy(err: Error | null, cb: (err?: Error | null) => void): void;
  writable: boolean;
  writableEnded: boolean;
  writableFinished: boolean;
  writableHighWaterMark: number;
  writableLength: number;
  writableObjectMode: boolean;
  writableCorked: number;
  writableNeedDrain: boolean;
  writableAborted: boolean;
  writableBuffer: BufferedChunk[];
  writableErrored: Error | null;
  closed: boolean;
  closeEmitted?: boolean;
  errored: Error | null;
  destroyed: boolean;
  write(chunk: unknown, cb?: (err?: Error | null) => void): boolean;
  write(chunk: unknown, encoding?: string, cb?: (err?: Error | null) => void): boolean;
  end(cb?: () => void): this;
  end(chunk: unknown, cb?: () => void): this;
  end(chunk: unknown, encoding?: string, cb?: () => void): this;
  cork(): void;
  uncork(): void;
  setDefaultEncoding(encoding: string): this;
  destroy(error?: Error | null): this;
  _undestroy(): void;
}
export interface WritableCtor {
  new (opts?: StreamOptions): Writable;
  (this: Writable, opts?: StreamOptions): void;
  prototype: Writable;
  fromWeb(writableStream: WritableStream, options?: StreamOptions): Writable;
  toWeb(streamWritable: Writable): WritableStream;
}

export const Writable = function Writable(this: Writable, options?: StreamOptions): void {
  if (!(this instanceof Writable)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (Writable as unknown as { new (o?: StreamOptions): Writable })(options) as never;
  }

  this._writableState = newWritableState(options, false);

  if (options) {
    if (typeof options.write === "function") this._write = options.write;
    if (typeof options.writev === "function") this._writev = options.writev;
    if (typeof options.destroy === "function") this._destroy = options.destroy;
    if (typeof options.final === "function") this._final = options.final;
    if (typeof options.construct === "function") this._construct = options.construct;
    if (options.signal) addAbortSignal(options.signal, this as unknown as AnyStream & EventEmitter);
  }

  Stream.call(this, options);

  if (this._construct != null) {
    destroyImpl.construct(this as unknown as AnyStream & EventEmitter, () => {
      onConstructedWritable(this);
    });
  }
} as unknown as WritableCtor;
Object.setPrototypeOf(Writable.prototype, Stream.prototype);
Object.setPrototypeOf(Writable, Stream);

const onConstructedWritable = (stream: Writable): void => {
  const state = stream._writableState;
  state.constructed = true;
  if (!state.writing) clearBuffer(stream, state);
  if (state.ending) finishMaybe(stream, state);
};

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function pipe(this: Writable): never {
  errorOrDestroy(this as unknown as AnyStream & EventEmitter, ERR.STREAM_CANNOT_PIPE());
  throw ERR.STREAM_CANNOT_PIPE();
};

const _write = (
  stream: Writable,
  chunk: unknown,
  encoding: string | null | ((err?: Error | null) => void),
  cb?: ((err?: Error | null) => void) | null,
): true | Error => {
  const state = stream._writableState;

  if (typeof encoding === "function") {
    cb = encoding;
    encoding = null;
  }
  const callback = typeof cb === "function" ? cb : nop;
  let enc = typeof encoding === "string" ? encoding : null;

  if (chunk === null) {
    throw ERR.STREAM_NULL_VALUES();
  }

  if (!state.objectMode) {
    if (!enc) {
      enc = state.defaultEncoding === "utf8" ? "utf8" : state.defaultEncoding;
    } else if (enc !== "buffer" && !isValidEncoding(enc)) {
      throw ERR.UNKNOWN_ENCODING(enc);
    }

    if (typeof chunk === "string") {
      if (state.decodeStrings) {
        chunk = Buffer.from(chunk, enc as BufferEncoding);
        enc = "buffer";
      }
    } else if (Buffer.isBuffer(chunk)) {
      enc = "buffer";
    } else if (isArrayBufferView(chunk)) {
      chunk = uint8ArrayToBuffer(chunk as Uint8Array);
      enc = "buffer";
    } else {
      throw ERR.INVALID_ARG_TYPE("chunk", ["string", "Buffer", "TypedArray", "DataView"], chunk);
    }
  }

  let err: Error | null = null;
  if (state.ending) {
    err = ERR.STREAM_WRITE_AFTER_END();
  } else if (state.destroyed) {
    err = ERR.STREAM_DESTROYED("write");
  }

  if (err) {
    nextTick(callback, err);
    errorOrDestroy(stream as unknown as AnyStream & EventEmitter, err, true);
    return err;
  }

  state.pendingcb++;
  return writeOrBuffer(stream, state, chunk, enc ?? "buffer", callback);
};

Writable.prototype.write = function write(
  this: Writable,
  chunk: unknown,
  encoding?: string | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
): boolean {
  return _write(this, chunk, encoding ?? null, cb) === true;
};

// If we're already writing something, then just put this in the queue,
// and wait our turn. Otherwise, call _write.
const writeOrBuffer = (
  stream: Writable,
  state: WritableState,
  chunk: unknown,
  encoding: string,
  callback: (err?: Error | null) => void,
): true => {
  const len = state.objectMode ? 1 : (chunk as { length: number }).length;

  state.length += len;

  if (state.writing || state.errored || state.corked !== 0 || !state.constructed) {
    state.buffered.push({ chunk, encoding, callback });
  } else {
    state.writelen = len;
    if (callback !== nop) state.writecb = callback;
    state.writing = true;
    state.sync = true;
    state.expectWriteCb = true;
    stream._write(chunk, encoding, stateOnwrite(stream, state));
    state.sync = false;
  }

  const ret = state.length < state.highWaterMark;
  if (!ret) state.needDrain = true;

  // Return false if errored or destroyed in order to break
  // any synchronous while(stream.write(data)) loops.
  return (ret && !state.destroyed && !state.errored) as true;
};

// Bound once per write batch; keeps a stable function identity for _write cb.
const stateOnwrite = (stream: Writable, state: WritableState): ((err?: Error | null) => void) => {
  const onwrite = (er?: Error | null): void => {
    if (!state.expectWriteCb) {
      errorOrDestroy(stream as unknown as AnyStream & EventEmitter, ERR.MULTIPLE_CALLBACK());
      return;
    }

    const sync = state.sync;
    const cb = state.writecb ?? nop;

    state.writing = false;
    state.expectWriteCb = false;
    state.writecb = null;
    state.length -= state.writelen;
    state.writelen = 0;

    if (er) {
      if (!state.errored) state.errored = er;
      const rState = (stream as unknown as { _readableState?: ReadableState })._readableState;
      if (rState && !rState.errored) rState.errored = er;

      if (sync) {
        nextTick(onwriteError, stream, state, er, cb);
      } else {
        onwriteError(stream, state, er, cb);
      }
    } else {
      if (state.buffered.length > state.bufferedIndex) {
        clearBuffer(stream, state);
      }

      if (sync) {
        const needDrain = state.needDrain && state.length === 0;
        const needTick = needDrain || state.destroyed || cb !== nop;

        if (needTick) {
          nextTick(afterWrite, stream, state, 1, cb);
        } else {
          state.pendingcb--;
          if (state.ending) finishMaybe(stream, state);
        }
      } else {
        afterWrite(stream, state, 1, cb);
      }
    }
  };
  return onwrite;
};

const onwriteError = (
  stream: Writable,
  state: WritableState,
  er: Error,
  cb: (err?: Error | null) => void,
): void => {
  --state.pendingcb;

  cb(er);
  // Ensure callbacks are invoked even when autoDestroy is not enabled.
  errorBuffer(stream, state);
  // This can emit error, but error must always follow cb.
  errorOrDestroy(stream as unknown as AnyStream & EventEmitter, er);
};

const afterWrite = (
  stream: Writable,
  state: WritableState,
  count: number,
  cb: (err?: Error | null) => void,
): void => {
  const needDrain = !state.ending && state.needDrain && !state.destroyed && state.length === 0;
  if (needDrain) {
    state.needDrain = false;
    stream.emit("drain");
  }

  while (count-- > 0) {
    state.pendingcb--;
    cb(null);
  }

  if (state.destroyed) {
    errorBuffer(stream, state);
  }

  if (state.ending) {
    finishMaybe(stream, state);
  }
};

// If there's something in the buffer waiting, then invoke callbacks.
const errorBuffer = (stream: Writable, state: WritableState): void => {
  if (state.writing) return;
  void stream;

  for (let n = state.bufferedIndex; n < state.buffered.length; ++n) {
    const { chunk, callback } = state.buffered[n];
    const len = state.objectMode ? 1 : (chunk as { length: number }).length;
    state.length -= len;
    callback(state.errored ?? ERR.STREAM_DESTROYED("write"));
  }

  callFinishedCallbacks(state, state.errored ?? ERR.STREAM_DESTROYED("end"));

  resetBuffer(state);
};

const resetBuffer = (state: WritableState): void => {
  state.buffered = [];
  state.bufferedIndex = 0;
};

// If there's something in the buffer waiting, then process it.
const clearBuffer = (stream: Writable, state: WritableState): void => {
  if (
    state.destroyed ||
    state.bufferProcessing ||
    state.corked !== 0 ||
    state.buffered.length === state.bufferedIndex ||
    !state.constructed
  ) {
    return;
  }

  const objectMode = state.objectMode;
  const buffered = state.buffered;
  const bufferedLength = buffered.length - state.bufferedIndex;

  if (bufferedLength === 0) return;

  let i = state.bufferedIndex;

  state.bufferProcessing = true;
  if (bufferedLength > 1 && stream._writev) {
    state.pendingcb -= bufferedLength - 1;
    const callback = (err?: Error | null) => {
      for (let n = i; n < buffered.length; ++n) {
        buffered[n].callback(err);
      }
    };
    const chunks = buffered.slice(i);

    doWrite(stream, state, true, state.length, chunks, "", callback);

    resetBuffer(state);
  } else {
    do {
      const { chunk, encoding, callback } = buffered[i];
      buffered[i] = null as unknown as BufferedChunk;
      i++;
      const len = objectMode ? 1 : (chunk as { length: number }).length;
      doWrite(stream, state, false, len, chunk, encoding, callback);
    } while (i < buffered.length && !state.writing);

    if (i === buffered.length) {
      resetBuffer(state);
    } else if (i > 256) {
      buffered.splice(0, i);
      state.bufferedIndex = 0;
    } else {
      state.bufferedIndex = i;
    }
  }
  state.bufferProcessing = false;
};

const doWrite = (
  stream: Writable,
  state: WritableState,
  writev: boolean,
  len: number,
  chunk: unknown,
  encoding: string,
  cb: (err?: Error | null) => void,
): void => {
  state.writelen = len;
  if (cb !== nop) state.writecb = cb;
  state.writing = true;
  state.sync = true;
  state.expectWriteCb = true;
  if (state.destroyed) {
    stateOnwrite(stream, state)(ERR.STREAM_DESTROYED("write"));
  } else if (writev && stream._writev) {
    stream._writev(
      chunk as Array<{ chunk: unknown; encoding: string }>,
      stateOnwrite(stream, state),
    );
  } else {
    stream._write(chunk, encoding, stateOnwrite(stream, state));
  }
  state.sync = false;
};

Writable.prototype._write = function _writeImpl(
  this: Writable,
  chunk: unknown,
  encoding: string,
  cb: (err?: Error | null) => void,
): void {
  if (this._writev) {
    this._writev([{ chunk, encoding }], cb);
  } else {
    throw ERR.METHOD_NOT_IMPLEMENTED("_write()");
  }
};

Writable.prototype._writev = undefined;

Writable.prototype.cork = function cork(this: Writable): void {
  this._writableState.corked++;
};

Writable.prototype.uncork = function uncork(this: Writable): void {
  const state = this._writableState;
  if (state.corked) {
    state.corked--;
    if (!state.corked && !state.writing && !state.bufferProcessing) {
      clearBuffer(this, state);
    }
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(
  this: Writable,
  encoding: string,
): Writable {
  const enc = String(encoding).toLowerCase();
  if (!isValidEncoding(enc)) throw ERR.UNKNOWN_ENCODING(enc);
  this._writableState.defaultEncoding = normalizeEncoding(enc);
  return this;
};

Writable.prototype.end = function end(
  this: Writable,
  chunk?: unknown,
  encoding?: string | (() => void),
  cb?: () => void,
): Writable {
  const state = this._writableState;

  if (typeof chunk === "function") {
    cb = chunk as () => void;
    chunk = null;
    encoding = undefined;
  } else if (typeof encoding === "function") {
    cb = encoding as () => void;
    encoding = undefined;
  }

  let err: Error | null = null;

  if (chunk != null) {
    const ret = _write(this, chunk, (encoding as string | null) ?? null, null);
    if (ret instanceof Error) err = ret;
  }

  // .end() fully uncorks.
  if (state.corked !== 0) {
    state.corked = 1;
    this.uncork();
  }

  if (err) {
    // Do nothing...
  } else if (!state.ending && !state.errored) {
    state.ending = true;
    finishMaybe(this, state, true);
    state.ended = true;
  } else if (state.finished) {
    err = ERR.STREAM_ALREADY_FINISHED("end");
  } else if (state.destroyed) {
    err = ERR.STREAM_DESTROYED("end");
  }

  if (typeof cb === "function") {
    if (err) {
      nextTick(cb, err);
    } else if (state.errored) {
      nextTick(cb, state.errored);
    } else if (state.finished) {
      nextTick(cb, null);
    } else {
      state.onFinished.push(cb);
    }
  }

  return this;
};

Writable.prototype._destroy = function _destroyImpl(
  this: Writable,
  err: Error | null,
  cb: (err?: Error | null) => void,
): void {
  cb(err);
};

Writable.prototype.destroy = destroyImpl.destroy as unknown as Writable["destroy"];
Writable.prototype._undestroy = destroyImpl.undestroy as unknown as Writable["_undestroy"];

const needFinish = (state: WritableState): boolean =>
  state.ending &&
  state.constructed &&
  !state.destroyed &&
  !state.finished &&
  !state.writing &&
  !state.errorEmitted &&
  !state.closeEmitted &&
  !state.errored &&
  state.buffered.length === state.bufferedIndex &&
  state.length === 0;

const onFinish = (stream: Writable, state: WritableState, err?: Error | null): void => {
  if (state.prefinished) {
    errorOrDestroy(stream as unknown as AnyStream & EventEmitter, err ?? ERR.MULTIPLE_CALLBACK());
    return;
  }
  state.pendingcb--;
  if (err) {
    callFinishedCallbacks(state, err);
    errorOrDestroy(stream as unknown as AnyStream & EventEmitter, err, state.sync);
  } else if (needFinish(state)) {
    state.prefinished = true;
    stream.emit("prefinish");
    // Backwards compat. Some streams assume 'finish' will be emitted
    // asynchronously relative to _final callback.
    state.pendingcb++;
    nextTick(finish, stream, state);
  }
};

const prefinish = (stream: Writable, state: WritableState): void => {
  if (state.prefinished || state.finalCalled) return;

  if (typeof stream._final === "function" && !state.destroyed) {
    state.finalCalled = true;
    state.sync = true;
    state.pendingcb++;

    try {
      stream._final((err?: Error | null) => onFinish(stream, state, err));
    } catch (err) {
      onFinish(stream, state, err as Error);
    }

    state.sync = false;
  } else {
    state.finalCalled = true;
    state.prefinished = true;
    stream.emit("prefinish");
  }
};

const finishMaybe = (stream: Writable, state: WritableState, sync?: boolean): void => {
  if (needFinish(state)) {
    prefinish(stream, state);
    if (state.pendingcb === 0) {
      if (sync) {
        state.pendingcb++;
        nextTick(
          (stream2: Writable, state2: WritableState) => {
            if (needFinish(state2)) {
              finish(stream2, state2);
            } else {
              state2.pendingcb--;
            }
          },
          stream,
          state,
        );
      } else if (needFinish(state)) {
        state.pendingcb++;
        finish(stream, state);
      }
    }
  }
};

const finish = (stream: Writable, state: WritableState): void => {
  state.pendingcb--;
  state.finished = true;

  callFinishedCallbacks(state, null);

  stream.emit("finish");

  if (state.autoDestroy) {
    // In case of duplex streams we need a way to detect
    // if the readable side is ready for autoDestroy as well.
    const rState = (stream as unknown as { _readableState?: ReadableState })._readableState;
    const autoDestroy =
      !rState ||
      (rState.autoDestroy &&
        // We don't expect the readable to ever 'end'
        // if readable is explicitly set to false.
        (rState.endEmitted || rState.readable === false));
    if (autoDestroy) {
      (stream as unknown as { destroy: () => unknown }).destroy();
    }
  }
};

const callFinishedCallbacks = (state: WritableState, err?: Error | null): void => {
  if (state.onFinished.length === 0) return;
  const callbacks = state.onFinished;
  state.onFinished = [];
  for (const cb of callbacks) cb(err);
};

// Writable getters — defined as own prototype properties so e.g.
// `Object.hasOwn(Writable.prototype, 'writableFinished')` holds like Node.
const writableGetters: PropertyDescriptorMap = {
  writable: {
    get(this: Writable) {
      const w = this._writableState;
      // writable=false disables the whole side; destroyed/closeEmitted flip it.
      return (
        w !== undefined &&
        w.writable !== false &&
        !w.destroyed &&
        !w.errored &&
        !w.errorEmitted &&
        !w.closeEmitted
      );
    },
    set(this: Writable, value: boolean) {
      // https://github.com/nodejs/node/pull/28655 — user-managed compat.
      if (this._writableState) this._writableState.writable = Boolean(value);
    },
  },
  writableEnded: {
    get(this: Writable) {
      return this._writableState ? this._writableState.ending && this._writableState.ended : false;
    },
  },
  writableFinished: {
    get(this: Writable) {
      return this._writableState ? this._writableState.finished : false;
    },
  },
  writableHighWaterMark: {
    get(this: Writable) {
      return this._writableState?.highWaterMark;
    },
  },
  writableLength: {
    get(this: Writable) {
      const w = this._writableState;
      return w !== undefined ? w.length : 0;
    },
  },
  writableObjectMode: {
    get(this: Writable) {
      return this._writableState ? this._writableState.objectMode : false;
    },
  },
  writableBuffer: {
    get(this: Writable) {
      const w = this._writableState;
      return w && w.buffered.slice(w.bufferedIndex);
    },
  },
  writableCorked: {
    get(this: Writable) {
      return this._writableState ? this._writableState.corked : 0;
    },
  },
  writableNeedDrain: {
    get(this: Writable) {
      const w = this._writableState;
      return w === undefined ? false : !w.destroyed && !w.ending && w.needDrain;
    },
  },
  writableAborted: {
    get(this: Writable) {
      const w = this._writableState;
      return (
        w !== undefined &&
        (w.destroyed || w.errored !== null) &&
        !w.finished &&
        !w.ending &&
        w.writable !== false
      );
    },
  },
  writableErrored: {
    get(this: Writable) {
      return this._writableState ? this._writableState.errored : null;
    },
  },
  destroyed: {
    get(this: Writable) {
      const w = this._writableState;
      return w === undefined ? false : w.destroyed;
    },
    set(this: Writable, value: boolean) {
      // Backwards compat — the user is explicitly managing destroyed.
      if (this._writableState) {
        this._writableState.destroyed = value;
      }
    },
  },
  closed: {
    get(this: Writable) {
      const w = this._writableState;
      return w === undefined ? false : w.closed;
    },
  },
  closeEmitted: {
    get(this: Writable) {
      const w = this._writableState;
      return w === undefined ? false : w.closeEmitted;
    },
  },
  errored: {
    get(this: Writable) {
      return this._writableState ? this._writableState.errored : null;
    },
  },
};
Object.defineProperties(Writable.prototype, writableGetters);

// ---------------------------------------------------------------------------
// Readable (lib/internal/streams/readable.js)
// ---------------------------------------------------------------------------

const newReadableState = (options: StreamOptions | undefined, isDuplex: boolean): ReadableState => {
  const defaultEncoding = options?.defaultEncoding;
  const state: ReadableState = {
    objectMode: Boolean(options?.objectMode) || Boolean(isDuplex && options?.readableObjectMode),
    highWaterMark: 0,
    buffer: [],
    bufferIndex: 0,
    length: 0,
    pipes: [],
    hasFlowing: false,
    flowing: false,
    hasPaused: false,
    paused: false,
    ended: false,
    endEmitted: false,
    reading: false,
    sync: true,
    needReadable: false,
    emittedReadable: false,
    readableListening: false,
    dataListening: false,
    resumeScheduled: false,
    awaitDrainWriters: null,
    multiAwaitDrain: false,
    readingMore: false,
    dataEmitted: false,
    decoder: null,
    encoding: null,
    destroyed: false,
    closed: false,
    closeEmitted: false,
    errored: null,
    errorEmitted: false,
    emitClose: options?.emitClose !== false,
    autoDestroy: options?.autoDestroy !== false,
    constructed: true,
    aborted: false,
    defaultEncoding: "utf8",
    readable: options?.readable !== false,
  };
  if (defaultEncoding == null || defaultEncoding === "utf8" || defaultEncoding === "utf-8") {
    state.defaultEncoding = "utf8";
  } else if (isValidEncoding(defaultEncoding)) {
    state.defaultEncoding = normalizeEncoding(defaultEncoding);
  } else {
    throw ERR.UNKNOWN_ENCODING(defaultEncoding);
  }
  state.highWaterMark = getHighWaterMark(
    { objectMode: state.objectMode },
    options,
    "readableHighWaterMark",
    isDuplex,
  );
  if (options?.encoding) {
    if (!isValidEncoding(options.encoding)) throw ERR.UNKNOWN_ENCODING(options.encoding);
    state.decoder = new StreamDecoder(options.encoding);
    state.encoding = normalizeEncoding(options.encoding);
  }
  return state;
};

export interface Readable extends Stream {
  _readableState: ReadableState;
  _read(size: number): void;
  _construct?(cb: (err?: Error | null) => void): void;
  _destroy(err: Error | null, cb: (err?: Error | null) => void): void;
  readable: boolean;
  readableObjectMode: boolean;
  readableEncoding: string | null;
  readableEnded: boolean;
  readableFlowing: boolean | null;
  readableHighWaterMark: number;
  readableLength: number;
  readableAborted: boolean;
  readableDidRead: boolean;
  closed: boolean;
  errored: Error | null;
  destroyed: boolean;
  paused: boolean;
  push(chunk: unknown, encoding?: string): boolean;
  unshift(chunk: unknown, encoding?: string): void;
  read(n?: number): unknown;
  setEncoding(encoding: string): this;
  isPaused(): boolean;
  pause(): this;
  resume(): this;
  unpipe(dest?: DestLike): this;
  wrap(stream: unknown): this;
  destroy(error?: Error | null): this;
  _undestroy(): void;
  compose<T>(
    stream: T | Iterable<T> | AsyncIterable<T>,
    options?: { signal?: AbortSignal },
  ): Readable;
  iterator(options?: { destroyOnReturn?: boolean }): AsyncIterableIterator<unknown>;
  [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
  map(
    fn: (data: unknown, options?: { signal?: AbortSignal }) => unknown,
    options?: { signal?: AbortSignal },
  ): Readable;
  filter(
    fn: (data: unknown, options?: { signal?: AbortSignal }) => unknown,
    options?: { signal?: AbortSignal },
  ): Readable;
  forEach(
    fn: (data: unknown, options?: { signal?: AbortSignal }) => unknown,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  toArray(options?: { signal?: AbortSignal }): Promise<unknown[]>;
  some(fn: (data: unknown) => unknown, options?: { signal?: AbortSignal }): Promise<boolean>;
  every(fn: (data: unknown) => unknown, options?: { signal?: AbortSignal }): Promise<boolean>;
  find(fn: (data: unknown) => unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  findIndex(fn: (data: unknown) => unknown, options?: { signal?: AbortSignal }): Promise<number>;
  reduce(
    fn: (acc: unknown, data: unknown) => unknown,
    initial?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  drop(limit: number, options?: { signal?: AbortSignal }): Readable;
  take(limit: number, options?: { signal?: AbortSignal }): Readable;
  asIndexedPairs(options?: { signal?: AbortSignal }): Readable;
  flatMap(
    fn: (data: unknown) => Iterable<unknown> | AsyncIterable<unknown>,
    options?: { signal?: AbortSignal },
  ): Readable;
}
export interface ReadableCtor {
  new (opts?: StreamOptions): Readable;
  (this: Readable, opts?: StreamOptions): void;
  prototype: Readable;
  from(iterable: unknown, options?: StreamOptions): Readable;
  fromWeb(readableStream: ReadableStream, options?: StreamOptions): Readable;
  toWeb(streamReadable: Readable): ReadableStream;
  isDisturbed(stream: unknown): boolean;
}

export const Readable = function Readable(this: Readable, options?: StreamOptions): void {
  if (!(this instanceof Readable)) {
    return new (Readable as unknown as { new (o?: StreamOptions): Readable })(options) as never;
  }

  this._readableState = newReadableState(options, false);

  if (options) {
    if (typeof options.read === "function") this._read = options.read;
    if (typeof options.destroy === "function") this._destroy = options.destroy;
    if (typeof options.construct === "function") this._construct = options.construct;
    if (options.signal) addAbortSignal(options.signal, this as unknown as AnyStream & EventEmitter);
  }

  Stream.call(this, options);

  if (this._construct != null) {
    destroyImpl.construct(this as unknown as AnyStream & EventEmitter, () => {
      const state = this._readableState;
      state.constructed = true;
      if (state.needReadable) maybeReadMore(this, state);
    });
  }
} as unknown as ReadableCtor;
Object.setPrototypeOf(Readable.prototype, Stream.prototype);
Object.setPrototypeOf(Readable, Stream);

Readable.prototype.destroy = destroyImpl.destroy as unknown as Readable["destroy"];
Readable.prototype._undestroy = destroyImpl.undestroy as unknown as Readable["_undestroy"];
Readable.prototype._destroy = function _destroyImpl(
  this: Readable,
  err: Error | null,
  cb: (err?: Error | null) => void,
): void {
  cb(err);
};

Readable.prototype.push = function push(
  this: Readable,
  chunk: unknown,
  encoding?: string,
): boolean {
  return readableAddChunk(this, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read().
Readable.prototype.unshift = function unshift(
  this: Readable,
  chunk: unknown,
  encoding?: string,
): void {
  readableAddChunk(this, chunk, encoding, true);
};

const readableAddChunk = (
  stream: Readable,
  chunk: unknown,
  encoding: string | undefined,
  addToFront: boolean,
): boolean => {
  const state = stream._readableState;

  let err: Error | null = null;
  if (!state.objectMode) {
    if (typeof chunk === "string") {
      encoding = encoding || state.defaultEncoding;
      if (state.encoding !== encoding) {
        if (addToFront && state.encoding) {
          // When unshifting, if state.encoding is set, we have to save
          // the string in the BufferList with the state encoding.
          chunk = Buffer.from(chunk as string, encoding as BufferEncoding).toString(
            state.encoding as BufferEncoding,
          );
        } else {
          chunk = Buffer.from(chunk as string, encoding as BufferEncoding);
          encoding = "";
        }
      }
    } else if (chunk == null || chunk === undefined) {
      // handled below (EOF / invalid)
    } else if (Buffer.isBuffer(chunk)) {
      encoding = "";
    } else if (isArrayBufferView(chunk)) {
      chunk = uint8ArrayToBuffer(chunk as Uint8Array);
      encoding = "";
    } else {
      err = ERR.INVALID_ARG_TYPE("chunk", ["string", "Buffer", "TypedArray", "DataView"], chunk);
    }
  } else if (chunk === undefined || chunk === null) {
    // EOF handled below.
  }

  if (err) {
    errorOrDestroy(stream as unknown as AnyStream & EventEmitter, err);
    return false;
  }

  if (chunk == null) {
    state.reading = false;
    onEofChunk(stream, state);
    return false;
  }

  if (state.ended) {
    errorOrDestroy(stream as unknown as AnyStream & EventEmitter, ERR.STREAM_PUSH_AFTER_EOF());
    return false;
  }
  if (state.destroyed || state.errored) return false;

  state.reading = false;
  if (state.decoder && !encoding) {
    chunk = state.decoder.write(chunk as Uint8Array);
    if ((chunk as string).length === 0) {
      maybeReadMore(stream, state);
      return canPushMore(state);
    }
  }

  if (!state.objectMode && (chunk as { length: number }).length <= 0) {
    if (process.env?.BOLO_DBG) console.log("DBG push empty chunk; reading=", state.reading, "needReadable=", state.needReadable);
    maybeReadMore(stream, state);
    return canPushMore(state);
  }

  addChunk(stream, state, chunk, addToFront);
  return canPushMore(state);
};

const canPushMore = (state: ReadableState): boolean =>
  !state.ended && (state.length < state.highWaterMark || state.length === 0);

const addChunk = (
  stream: Readable,
  state: ReadableState,
  chunk: unknown,
  addToFront: boolean,
): void => {
  if (state.flowing && !state.sync && state.dataListening && state.length === 0) {
    // Use the guard to avoid creating Set() repeatedly
    // when we have multiple pipes.
    if (state.multiAwaitDrain) {
      (state.awaitDrainWriters as Set<DestLike>).clear();
    } else {
      state.awaitDrainWriters = null;
    }

    state.dataEmitted = true;
    stream.emit("data", chunk);
  } else {
    // Update the buffer info.
    state.length += state.objectMode ? 1 : (chunk as { length: number }).length;
    if (addToFront) state.buffer.unshift(chunk);
    else state.buffer.push(chunk);
    if (state.needReadable) emitReadable(stream);
  }
  maybeReadMore(stream, state);
};

const onEofChunk = (stream: Readable, state: ReadableState): void => {
  if (state.ended) return;
  const decoder = state.decoder;
  if (decoder) {
    const chunk = decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  if (state.sync) {
    // If we are sync, wait until next tick to emit the data.
    emitReadable(stream);
  } else {
    // Emit 'readable' now to make sure it gets picked up.
    state.needReadable = false;
    state.emittedReadable = true;
    // Modules in the ecosystem rely on this event being sync.
    emitReadableNow(stream);
  }
};

const emitReadable = (stream: Readable): void => {
  const state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    state.emittedReadable = true;
    nextTick(emitReadableNow, stream);
  }
};

const emitReadableNow = (stream: Readable): void => {
  const state = stream._readableState;
  if (!state.destroyed && !state.errored && (state.length > 0 || state.ended)) {
    stream.emit("readable");
    state.emittedReadable = false;
  }

  // The stream needs another readable event if:
  // 1. It is not flowing.
  // 2. It is not ended.
  // 3. It is below the highWaterMark.
  state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
  flow(stream);
};

const maybeReadMore = (stream: Readable, state: ReadableState): void => {
  if (!state.readingMore && state.constructed) {
    state.readingMore = true;
    nextTick(maybeReadMoreNow, stream, state);
  }
};

const maybeReadMoreNow = (stream: Readable, state: ReadableState): void => {
  if (process.env?.BOLO_DBG) console.log("DBG maybeReadMoreNow len=", state.length, "reading=", state.reading, "ended=", state.ended, "hwm=", state.highWaterMark);
  let len = state.length;
  while (
    !state.reading &&
    !state.ended &&
    (state.length < state.highWaterMark || (state.flowing && state.length === 0))
  ) {
    len = state.length;
    stream.read(0);
    if (len === state.length) {
      // Didn't get any data, stop spinning.
      break;
    }
  }
  state.readingMore = false;
};

Readable.prototype.isPaused = function isPaused(this: Readable): boolean {
  const state = this._readableState;
  return state.paused || (state.hasFlowing && !state.flowing);
};

Readable.prototype.pause = function pause(this: Readable): Readable {
  const state = this._readableState;
  if (!state.hasFlowing || state.flowing) {
    state.hasFlowing = true;
    state.flowing = false;
    this.emit("pause");
  }
  state.hasPaused = true;
  state.paused = true;
  return this;
};

Readable.prototype.resume = function resume(this: Readable): Readable {
  const state = this._readableState;
  if (!state.flowing) {
    // We flow only if there is no one listening
    // for readable, but we still have to call
    // resume().
    state.hasFlowing = true;
    state.flowing = !state.readableListening;
    resumeImpl(this, state);
  }
  state.hasPaused = true;
  state.paused = false;
  return this;
};

const resumeImpl = (stream: Readable, state: ReadableState): void => {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    nextTick(resumeNow, stream, state);
  }
};

const resumeNow = (stream: Readable, state: ReadableState): void => {
  if (!state.reading) {
    stream.read(0);
  }

  state.resumeScheduled = false;
  stream.emit("resume");
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
};

const flow = (stream: Readable): void => {
  const state = stream._readableState;
  while (state.flowing && stream.read() !== null);
};

Readable.prototype.setEncoding = function setEncoding(this: Readable, enc: string): Readable {
  if (!isValidEncoding(enc)) throw ERR.UNKNOWN_ENCODING(enc);
  const decoder = new StreamDecoder(enc);
  this._readableState.decoder = decoder;
  this._readableState.encoding = this._readableState.decoder
    ? normalizeEncoding(enc)
    : normalizeEncoding(enc);

  // Iterate over current buffer to convert already stored Buffers:
  const state = this._readableState;
  if (state.length === 0) return this;

  const s = state.buffer
    .slice(state.bufferIndex)
    .map((c) => decoder.write(c as Uint8Array))
    .join("");
  state.buffer = state.buffer.slice(0, state.bufferIndex);
  state.bufferIndex = 0;
  state.buffer.push(s);
  state.length = s.length;
  return this;
};

const computeNewHighWaterMark = (n: number): number => {
  if (n >= 1024 * 1024 * 1024) {
    throw makeError("ERR_OUT_OF_RANGE", `The value of "n" is out of range. Received ${n}`);
  }
  n--;
  n |= n >>> 1;
  n |= n >>> 2;
  n |= n >>> 4;
  n |= n >>> 8;
  n |= n >>> 16;
  n++;
  return n;
};

// This function is designed to be inlinable, so please take care when making
// changes to the function body.
const howMuchToRead = (n: number, state: ReadableState): number => {
  if (n <= 0 || (state.length === 0 && state.ended)) return 0;
  if (state.objectMode) return 1;
  if (Number.isNaN(n)) {
    // Only flow one buffer at a time.
    if (state.flowing && state.length !== 0) {
      const first = state.buffer[state.bufferIndex];
      return (first as { length: number }).length;
    }
    return state.length;
  }
  if (n <= state.length) return n;
  return state.ended ? state.length : 0;
};

Readable.prototype.read = function read(this: Readable, n?: number): unknown {
  let size: number;
  if (n === undefined) {
    size = NaN;
  } else if (!Number.isInteger(n)) {
    size = Number.parseInt(n as unknown as string, 10);
  } else {
    size = n;
  }
  const state = this._readableState;
  const nOrig = size;

  // If we're asking for more than the current hwm, then raise the hwm.
  if (size > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(size);

  if (size !== 0) state.emittedReadable = false;

  // If we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (
    size === 0 &&
    state.needReadable &&
    ((state.highWaterMark !== 0 ? state.length >= state.highWaterMark : state.length > 0) ||
      state.ended)
  ) {
    if (state.length === 0 && state.ended) endReadable(this);
    else emitReadable(this);
    return null;
  }

  size = howMuchToRead(size, state);

  // If we've ended, and we're now clear, then finish it up.
  if (size === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }

  let doRead = state.needReadable;

  // If we currently have less than the highWaterMark, then also read some.
  if (state.length === 0 || state.length - size < state.highWaterMark) {
    doRead = true;
  }

  // However, if we've ended, then there's no point, if we're already
  // reading, then it's unnecessary, if we're constructing we have to wait,
  // and if we're destroyed or errored, then it's not allowed.
  if (state.reading || state.ended || state.destroyed || state.errored || !state.constructed) {
    doRead = false;
  } else if (doRead) {
    state.reading = true;
    state.sync = true;
    // If the length is currently zero, then we *need* a readable event.
    if (state.length === 0) state.needReadable = true;

    // Call internal read method
    try {
      this._read(state.highWaterMark);
    } catch (err) {
      errorOrDestroy(this as unknown as AnyStream & EventEmitter, err);
    }
    state.sync = false;

    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    if (!state.reading) size = howMuchToRead(nOrig, state);
  }

  let ret: unknown;
  if (size > 0) ret = fromList(size, state);
  else ret = null;

  if (ret === null) {
    if (state.length <= state.highWaterMark) state.needReadable = true;
    size = 0;
  } else {
    state.length -= size;
    if (state.multiAwaitDrain) {
      (state.awaitDrainWriters as Set<DestLike>).clear();
    } else {
      state.awaitDrainWriters = null;
    }
  }

  if (state.length === 0) {
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true;

    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== size && state.ended) endReadable(this);
  }

  if (ret !== null && !state.errorEmitted && !state.closeEmitted) {
    state.dataEmitted = true;
    this.emit("data", ret);
  }

  return ret;
};

function endReadable(stream: Readable): void {
  const state = stream._readableState;

  if (!state.endEmitted) {
    state.ended = true;
    nextTick(endReadableNT, state, stream);
  }
}

const endReadableNT = (state: ReadableState, stream: Readable): void => {
  // Check that we didn't get one last unshift.
  if (!state.errored && !state.closeEmitted && !state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.emit("end");

    const s = stream as unknown as AnyStream & {
      writable?: boolean;
      allowHalfOpen?: boolean;
      writableEnded?: boolean;
    };
    if (s.writable && s.allowHalfOpen === false) {
      nextTick(endWritableNT, stream);
    } else if (state.autoDestroy) {
      const wState = s._writableState;
      const autoDestroy =
        !wState || (wState.autoDestroy && (wState.finished || wState.writable === false));
      if (autoDestroy) {
        (stream as unknown as { destroy: () => unknown }).destroy();
      }
    }
  }
};

const endWritableNT = (stream: AnyStream & { end?: () => void }): void => {
  const writable = stream.writable && !stream.writableEnded && !stream.destroyed;
  if (writable) {
    stream.end!();
  } else {
    stream.destroy?.();
  }
};

// FromList — consume n units from the buffer.
const fromList = (n: number, state: ReadableState): unknown => {
  // nothing drained
  if (state.length === 0) return null;

  const buffer = state.buffer;
  let idx = state.bufferIndex;

  if (state.objectMode) {
    const ret = buffer[idx];
    buffer[idx] = null;
    state.bufferIndex++;
    if (state.bufferIndex === buffer.length) {
      state.buffer = [];
      state.bufferIndex = 0;
    }
    return ret;
  }

  if (n === 0) return null;

  let ret: unknown;
  if (n >= state.length || Number.isNaN(n)) {
    // Take it all.
    const items = buffer.slice(idx);
    state.buffer = [];
    state.bufferIndex = 0;
    ret = concatChunks(items, state);
  } else if (idx === 0 && n >= (buffer[0] as { length: number }).length) {
    // Fast path — consume whole elements until we've taken >= n, then slice.
    const items: unknown[] = [];
    let remaining = n;
    while (remaining > 0 && idx < buffer.length) {
      const el = buffer[idx] as { length: number };
      if (el.length <= remaining) {
        items.push(el);
        remaining -= el.length;
        idx++;
      } else break;
    }
    state.bufferIndex = idx;
    if (idx === buffer.length) {
      state.buffer = [];
      state.bufferIndex = 0;
    }
    ret = items.length === 1 ? items[0] : concatChunks(items, state);
  } else {
    // Partial consume across elements.
    const first = buffer[idx] as Buffer | string;
    const firstLen = (first as { length: number }).length;
    if (idx === buffer.length - 1 && n === firstLen) {
      ret = first;
      state.buffer = [];
      state.bufferIndex = 0;
    } else if (n < firstLen) {
      // Slice the first element.
      ret = typeof first === "string" ? first.slice(0, n) : (first as Buffer).subarray(0, n);
      buffer[idx] = typeof first === "string" ? first.slice(n) : (first as Buffer).subarray(n);
    } else {
      const items: unknown[] = [];
      let remaining = n;
      while (remaining > 0 && idx < buffer.length) {
        const el = buffer[idx] as { length: number };
        if (el.length <= remaining) {
          items.push(el);
          remaining -= el.length;
          idx++;
        } else {
          // Partial slice of the last element.
          const el2 = el as Buffer | string;
          items.push(
            typeof el2 === "string"
              ? el2.slice(0, remaining)
              : (el2 as Buffer).subarray(0, remaining),
          );
          buffer[idx] =
            typeof el2 === "string" ? el2.slice(remaining) : (el2 as Buffer).subarray(remaining);
          remaining = 0;
        }
      }
      state.bufferIndex = idx;
      if (idx === buffer.length) {
        state.buffer = [];
        state.bufferIndex = 0;
      }
      ret = items.length === 1 ? items[0] : concatChunks(items, state);
    }
  }

  return ret;
};

const concatChunks = (items: unknown[], state: ReadableState): unknown => {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  if (state.encoding) {
    return items.map((c) => String(c)).join("");
  }
  const buffers = items.map((c) => (Buffer.isBuffer(c) ? (c as Buffer) : Buffer.from(String(c))));
  return Buffer.concat(buffers as Buffer[]);
};

// Abstract method — to be overridden.
Readable.prototype._read = function _readImpl(this: Readable, _n: number): void {
  throw ERR.METHOD_NOT_IMPLEMENTED("_read()");
};

// Pipe — modern multi-dest implementation.
Readable.prototype.pipe = function pipe<T extends DestLike>(
  this: Readable,
  dest: T,
  pipeOpts?: { end?: boolean },
): T {
  const state = this._readableState;

  if (state.pipes.length === 1) {
    if (!state.multiAwaitDrain) {
      state.multiAwaitDrain = true;
      state.awaitDrainWriters = new Set<DestLike>(
        state.awaitDrainWriters ? [state.awaitDrainWriters as DestLike] : [],
      );
    }
  }

  state.pipes.push(dest);

  const proc = globalThis as { process?: { stdout?: unknown; stderr?: unknown } };
  const doEnd =
    (!pipeOpts || pipeOpts.end !== false) &&
    dest !== proc.process?.stdout &&
    dest !== proc.process?.stderr;

  let ondrain: (() => void) | undefined;
  let cleanedUp = false;

  const unpipe = (): void => {
    this.unpipe(dest);
  };

  const onend = (): void => {
    if (typeof dest.end === "function") dest.end();
  };

  const onclose = (): void => {
    dest.removeListener!("finish", onfinish as never);
    unpipe();
  };

  const onfinish = (): void => {
    dest.removeListener!("close", onclose as never);
    unpipe();
  };

  const pauseForDest = (): void => {
    if (!cleanedUp) {
      if (state.pipes.length === 1 && state.pipes[0] === dest) {
        state.awaitDrainWriters = dest;
        state.multiAwaitDrain = false;
      } else if (state.pipes.length > 1 && state.pipes.includes(dest)) {
        (state.awaitDrainWriters as Set<DestLike>).add(dest);
      }
      this.pause();
    }
    if (!ondrain) {
      ondrain = pipeOnDrain(this, dest);
      dest.on!("drain", ondrain);
    }
  };

  const ondata = (chunk: unknown): void => {
    const ret = dest.write!(chunk);
    if (ret === false) {
      pauseForDest();
    }
  };

  // If the dest has an error, then stop piping into it.
  // However, don't suppress the throwing behavior for this.
  const onerror = (er: unknown): void => {
    unpipe();
    dest.removeListener!("error", onerror as never);
    if (dest.listenerCount!("error") === 0) {
      const s = dest._writableState ?? (dest as unknown as AnyStream)._readableState;
      if (s && !s.errorEmitted) {
        // User incorrectly emitted 'error' directly on the stream.
        errorOrDestroy(dest as unknown as AnyStream & EventEmitter, er);
      } else {
        (dest as unknown as EventEmitter).emit("error", er);
      }
    }
  };

  const onunpipe = (readable: unknown, unpipeInfo?: { hasUnpiped?: boolean }): void => {
    if (readable === this) {
      if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        cleanup();
      }
    }
  };

  const cleanup = (): void => {
    dest.removeListener!("close", onclose as never);
    dest.removeListener!("finish", onfinish as never);
    if (ondrain) {
      dest.removeListener!("drain", ondrain as never);
    }
    dest.removeListener!("error", onerror as never);
    dest.removeListener!("unpipe", onunpipe as never);
    this.removeListener("end", onend as never);
    this.removeListener("end", unpipe as never);
    this.removeListener("data", ondata as never);

    cleanedUp = true;

    // If the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    if (
      ondrain &&
      state.awaitDrainWriters &&
      (!dest._writableState || dest._writableState.needDrain)
    ) {
      ondrain();
    }
  };

  const endFn = doEnd ? onend : unpipe;
  if (state.endEmitted) nextTick(endFn);
  else this.once("end", endFn as never);

  dest.on!("unpipe", onunpipe);

  this.on("data", ondata);

  // Make sure our error handler is attached before userland ones.
  prependListener(
    dest as unknown as EventEmitter & { _events?: Record<string, unknown> },
    "error",
    onerror as never,
  );

  // Both close and finish should trigger unpipe, but only once.
  dest.once!("close", onclose);
  dest.once!("finish", onfinish);

  // Tell the dest that it's being piped to.
  dest.emit!("pipe", this);

  // Start the flow if it hasn't been started already.
  if (dest.writableNeedDrain === true) {
    pauseForDest();
  } else if (!state.flowing) {
    this.resume();
  }

  return dest;
};

const pipeOnDrain = (src: Readable, dest: DestLike): (() => void) => {
  return () => {
    const state = src._readableState;

    if (state.awaitDrainWriters === dest) {
      state.awaitDrainWriters = null;
    } else if (state.multiAwaitDrain) {
      (state.awaitDrainWriters as Set<DestLike>).delete(dest);
    }

    if (
      (!state.awaitDrainWriters || (state.awaitDrainWriters as Set<DestLike>).size === 0) &&
      state.dataListening
    ) {
      src.resume();
    }
  };
};

Readable.prototype.unpipe = function unpipeFn(this: Readable, dest?: DestLike): Readable {
  const state = this._readableState;
  const unpipeInfo = { hasUnpiped: false };

  // If we're not piping anywhere, then do nothing.
  if (state.pipes.length === 0) return this;

  if (!dest) {
    const dests = state.pipes;
    state.pipes = [];
    this.pause();

    for (let i = 0; i < dests.length; i++) dests[i].emit!("unpipe", this, unpipeInfo);
    return this;
  }

  const index = state.pipes.indexOf(dest);
  if (index === -1) return this;

  state.pipes.splice(index, 1);
  if (state.pipes.length === 0) this.pause();

  dest.emit!("unpipe", this, unpipeInfo);

  return this;
};

// Set up data events if they are asked for; ensure readable listeners
// eventually get something.
Readable.prototype.on = function on(
  this: Readable,
  ev: string | symbol,
  fn: (...args: any[]) => void,
): Readable {
  // NB: call `addListener` (not `on`) — unenv's `on` delegates to
  // `this.addListener`, which aliases back here → infinite recursion.
  const res = EventEmitter.prototype.addListener.call(this, ev, fn);
  const state = this._readableState;

  if (ev === "data") {
    state.dataListening = true;

    // Update readableListening so that resume() may be a no-op
    // a few lines down. This is needed to support once('readable').
    state.readableListening = this.listenerCount("readable") > 0;

    // Try start flowing on next tick if stream isn't explicitly paused.
    if (!state.hasFlowing || state.flowing) {
      this.resume();
    }
  } else if (ev === "readable") {
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = true;
      state.needReadable = true;
      state.hasFlowing = true;
      state.flowing = false;
      state.emittedReadable = false;
      if (state.length) {
        emitReadable(this);
      } else if (!state.reading) {
        nextTick(nReadingNextTick, this);
      }
    }
  }

  return res as unknown as Readable;
};
Readable.prototype.addListener = Readable.prototype.on;

Readable.prototype.removeListener = function removeListener(
  this: Readable,
  ev: string | symbol,
  fn: (...args: any[]) => void,
): Readable {
  const state = this._readableState;
  const res = EventEmitter.prototype.removeListener.call(this, ev, fn);

  if (ev === "readable") {
    // We need to check if there is someone still listening to
    // readable and reset the state. However this needs to happen
    // after readable has been emitted but before I/O (nextTick) to
    // support once('readable', fn) cycles.
    nextTick(updateReadableListening, this);
  } else if (ev === "data" && this.listenerCount("data") === 0) {
    state.dataListening = false;
  }

  return res as unknown as Readable;
};
Readable.prototype.off = Readable.prototype.removeListener;

Readable.prototype.removeAllListeners = function removeAllListeners(
  this: Readable,
  ev?: string | symbol,
): Readable {
  // unenv's EventEmitter.removeAllListeners branches on `arguments.length`,
  // so passing an explicit `undefined` would only clear the listeners of the
  // event named "undefined" instead of every listener. Node treats
  // `removeAllListeners(undefined)` like the no-argument call.
  const res =
    ev === undefined
      ? EventEmitter.prototype.removeAllListeners.call(this)
      : EventEmitter.prototype.removeAllListeners.call(this, ev);

  if (ev === "readable" || ev === undefined) {
    nextTick(updateReadableListening, this);
  } else if (ev === "data" || ev === undefined) {
    this._readableState.dataListening = false;
  }

  return res as unknown as Readable;
};

const updateReadableListening = (self: Readable): void => {
  const state = self._readableState;

  state.readableListening = self.listenerCount("readable") > 0;

  if (state.hasPaused && !state.paused && state.resumeScheduled) {
    // Flowing needs to be set to true now, otherwise
    // the upcoming resume will not flow.
    state.hasFlowing = true;
    state.flowing = true;

    // Crude way to check if we should resume.
  } else if (state.dataListening) {
    self.resume();
  } else if (!state.readableListening) {
    state.hasFlowing = false;
    state.flowing = false;
  }
};

const nReadingNextTick = (self: Readable): void => {
  self.read(0);
};

// Wrap an old-style stream as the async data source.
Readable.prototype.wrap = function wrap(this: Readable, stream: unknown): Readable {
  const s = stream as {
    on?: (ev: string, fn: (...a: unknown[]) => void) => void;
    pause?: () => void;
    resume?: () => void;
  };
  let paused = false;

  s.on!("data", (chunk: unknown) => {
    if (!this.push(chunk) && s.pause) {
      paused = true;
      s.pause();
    }
  });

  s.on!("end", () => {
    this.push(null);
  });

  s.on!("error", (err: unknown) => {
    errorOrDestroy(this as unknown as AnyStream & EventEmitter, err);
  });

  s.on!("close", () => {
    (this as unknown as { destroy: () => unknown }).destroy();
  });

  this._read = () => {
    if (paused) {
      paused = false;
      s.resume?.();
    }
  };

  return this;
};

// Readable getters.
const readableGetters: PropertyDescriptorMap = {
  readable: {
    get(this: Readable) {
      const r = this._readableState;
      return (
        r !== undefined &&
        r.readable !== false &&
        !r.destroyed &&
        !r.errorEmitted &&
        !r.closeEmitted
      );
    },
    set(this: Readable, value: boolean) {
      if (this._readableState) {
        this._readableState.readable = Boolean(value);
      }
    },
  },
  readableDidRead: {
    get(this: Readable) {
      return this._readableState?.dataEmitted === true;
    },
  },
  readableAborted: {
    get(this: Readable) {
      const r = this._readableState;
      return (
        r !== undefined &&
        r.readable !== false &&
        (r.destroyed || r.errored !== null) &&
        !r.ended &&
        !r.endEmitted &&
        r.aborted
      );
    },
  },
  readableHighWaterMark: {
    get(this: Readable) {
      return this._readableState?.highWaterMark;
    },
  },
  readableBuffer: {
    get(this: Readable) {
      const state = this._readableState;
      return state && state.buffer.slice(state.bufferIndex);
    },
  },
  readableFlowing: {
    get(this: Readable) {
      const state = this._readableState;
      if (state === undefined) return null;
      if (!state.hasFlowing) return null;
      return state.flowing;
    },
    set(this: Readable, value: boolean | null) {
      const state = this._readableState;
      if (state) {
        state.hasFlowing = true;
        state.flowing = Boolean(value);
      }
    },
  },
  readableLength: {
    get(this: Readable) {
      const state = this._readableState;
      return state !== undefined ? state.length : 0;
    },
  },
  readableObjectMode: {
    get(this: Readable) {
      return this._readableState ? this._readableState.objectMode : false;
    },
  },
  readableEncoding: {
    get(this: Readable) {
      return this._readableState ? this._readableState.encoding : null;
    },
  },
  errored: {
    get(this: Readable) {
      return this._readableState ? this._readableState.errored : null;
    },
  },
  closed: {
    get(this: Readable) {
      return this._readableState ? this._readableState.closed : false;
    },
  },
  closeEmitted: {
    get(this: Readable) {
      return this._readableState ? this._readableState.closeEmitted : false;
    },
  },
  destroyed: {
    get(this: Readable) {
      return this._readableState ? this._readableState.destroyed : false;
    },
    set(this: Readable, value: boolean) {
      if (this._readableState) {
        this._readableState.destroyed = value;
      }
    },
  },
  readableEnded: {
    get(this: Readable) {
      return this._readableState ? this._readableState.endEmitted : false;
    },
    set(this: Readable, value: boolean) {
      const state = this._readableState;
      if (state) {
        state.ended = value;
        state.endEmitted = value;
      }
    },
  },
  paused: {
    get(this: Readable) {
      const state = this._readableState;
      return state !== undefined ? state.paused : false;
    },
    set(this: Readable, value: boolean) {
      const state = this._readableState;
      if (state) state.paused = value;
    },
  },
};
Object.defineProperties(Readable.prototype, readableGetters);

const asyncDisposeSymbol: symbol =
  (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose ??
  Symbol.for("Symbol.asyncDispose");

(Readable.prototype as unknown as Record<symbol, unknown>)[asyncDisposeSymbol] = function (
  this: Readable,
) {
  let error: Error | null = null;
  if (!this.destroyed) {
    error = this.readableEnded ? null : new AbortError();
    (this as unknown as { destroy: (e?: Error | null) => unknown }).destroy(error);
  }
  return new Promise((resolve, reject) =>
    finished(this, (err?: Error | null) => (err && err !== error ? reject(err) : resolve(null))),
  );
};

// ---------------------------------------------------------------------------
// Async iterator + operators
// ---------------------------------------------------------------------------

const streamToAsyncIterator = async function* (
  stream: Readable,
  options?: { destroyOnReturn?: boolean },
): AsyncIterableIterator<unknown> {
  const destroyOnReturn = options?.destroyOnReturn !== false;
  let error: Error | null = null;
  // The stream reached EOF through normal iteration — no early-exit destroy.
  let completed = false;
  try {
    while (true) {
      if (stream.destroyed) break;
      if (stream.errored || stream._readableState?.errored) {
        throw stream.errored ?? stream._readableState?.errored;
      }
      const chunk = stream.read();
      if (chunk !== null) {
        yield chunk;
        continue;
      }
      if (stream.readableEnded || stream._readableState?.ended) {
        // Drain any remaining buffered chunks first.
        const rest = stream.read();
        if (rest !== null) {
          yield rest;
          continue;
        }
        completed = true;
        break;
      }
      // Wait for data / end / error / close.
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          stream.removeListener("readable", onResolve as never);
          stream.removeListener("end", onResolve as never);
          stream.removeListener("close", onClose as never);
          stream.removeListener("error", onErr as never);
        };
        const onResolve = (): void => {
          cleanup();
          resolve();
        };
        const onClose = (): void => {
          cleanup();
          resolve();
        };
        const onErr = (err: Error): void => {
          cleanup();
          error = err;
          reject(err);
        };
        stream.on("readable", onResolve as never);
        stream.on("end", onResolve as never);
        stream.on("close", onClose as never);
        stream.on("error", onErr as never);
      });
    }
  } finally {
    if (destroyOnReturn && !completed && !stream._readableState?.endEmitted && !stream.destroyed) {
      const err = error ?? new AbortError();
      (stream as unknown as { destroy: (e?: Error) => unknown }).destroy(err);
    }
  }
};

Readable.prototype.iterator = function iterator(
  this: Readable,
  options?: { destroyOnReturn?: boolean },
): AsyncIterableIterator<unknown> {
  if (options !== undefined && typeof options !== "object") {
    throw ERR.INVALID_ARG_TYPE("options", "object", options);
  }
  return streamToAsyncIterator(this, options);
};

(Readable.prototype as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = function (
  this: Readable,
) {
  return streamToAsyncIterator(this);
};

// Operators (lib/internal/streams/operators.js) — each is an async-generator
// over the stream; stream-returning ones are wrapped via Readable.from.
const kAbort = (): AbortError => new AbortError();

const checkSignal = (options?: { signal?: AbortSignal }): void => {
  if (options?.signal?.aborted) throw kAbort();
};

Readable.prototype.map = function map(
  this: Readable,
  fn: (data: unknown, options?: { signal?: AbortSignal }) => unknown,
  options?: { signal?: AbortSignal },
): Readable {
  if (typeof fn !== "function") {
    throw ERR.INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
  }
  if (options?.signal !== undefined && typeof options.signal !== "object") {
    throw ERR.INVALID_ARG_TYPE("options.signal", "AbortSignal", options.signal);
  }
  const gen = async function* (self: Readable) {
    for await (const chunk of self) {
      checkSignal(options);
      yield await fn(chunk, { signal: options?.signal });
    }
  };
  return Readable.from(gen(this), { objectMode: true });
};

Readable.prototype.asIndexedPairs = function asIndexedPairs(
  this: Readable,
  options?: { signal?: AbortSignal },
): Readable {
  const gen = async function* (self: Readable) {
    let index = 0;
    for await (const chunk of self) {
      checkSignal(options);
      yield [index++, chunk];
    }
  };
  return Readable.from(gen(this), { objectMode: true });
};

Readable.prototype.drop = function drop(
  this: Readable,
  limit: number,
  options?: { signal?: AbortSignal },
): Readable {
  const gen = async function* (self: Readable) {
    for await (const chunk of self) {
      checkSignal(options);
      if (limit-- > 0) continue;
      yield chunk;
    }
  };
  return Readable.from(gen(this), { objectMode: true });
};

Readable.prototype.take = function take(
  this: Readable,
  limit: number,
  options?: { signal?: AbortSignal },
): Readable {
  const gen = async function* (self: Readable) {
    for await (const chunk of self) {
      checkSignal(options);
      if (limit-- > 0) yield chunk;
      else return;
    }
  };
  return Readable.from(gen(this), { objectMode: true });
};

Readable.prototype.flatMap = function flatMap(
  this: Readable,
  fn: (data: unknown) => Iterable<unknown> | AsyncIterable<unknown>,
  options?: { signal?: AbortSignal },
): Readable {
  const gen = async function* (self: Readable) {
    for await (const chunk of self) {
      checkSignal(options);
      const inner = fn(chunk);
      if (isAsyncIterable(inner)) {
        for await (const c of inner) yield c;
      } else {
        for (const c of inner) yield c;
      }
    }
  };
  return Readable.from(gen(this), { objectMode: true });
};

Readable.prototype.filter = function filter(
  this: Readable,
  fn: (data: unknown, options?: { signal?: AbortSignal }) => unknown,
  options?: { signal?: AbortSignal },
): Readable {
  if (typeof fn !== "function") {
    throw ERR.INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
  }
  const gen = async function* (self: Readable) {
    for await (const chunk of self) {
      checkSignal(options);
      if (await fn(chunk, { signal: options?.signal })) yield chunk;
    }
  };
  return Readable.from(gen(this), { objectMode: true });
};

const runAccumulatorOp = (
  self: Readable,
  fn: (data: unknown, options?: { signal?: AbortSignal }) => unknown,
  options: { signal?: AbortSignal } | undefined,
  step: (acc: { done: boolean; value: unknown }, chunk: unknown) => void,
  final: (acc: { done: boolean; value: unknown }) => unknown,
): Promise<unknown> => {
  return (async () => {
    const acc = { done: false, value: undefined as unknown };
    try {
      for await (const chunk of self) {
        checkSignal(options);
        step(acc, chunk);
        if (acc.done) break;
      }
      return final(acc);
    } catch (e) {
      if (e instanceof AbortError) return final(acc);
      throw e;
    }
  })();
};

Readable.prototype.forEach = function forEach(
  this: Readable,
  fn: (data: unknown, options?: { signal?: AbortSignal }) => unknown,
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (typeof fn !== "function") {
    throw ERR.INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
  }
  return runAccumulatorOp(
    this,
    fn,
    options,
    (acc, chunk) => {
      void fn(chunk, { signal: options?.signal });
    },
    () => undefined,
  ) as Promise<void>;
};

Readable.prototype.toArray = function toArray(
  this: Readable,
  options?: { signal?: AbortSignal },
): Promise<unknown[]> {
  return runAccumulatorOp(
    this,
    nop,
    options,
    (acc, chunk) => {
      if (acc.value === undefined) acc.value = [];
      (acc.value as unknown[]).push(chunk);
    },
    (acc) => (acc.value === undefined ? [] : acc.value),
  ) as Promise<unknown[]>;
};

Readable.prototype.some = function some(
  this: Readable,
  fn: (data: unknown) => unknown,
  options?: { signal?: AbortSignal },
): Promise<boolean> {
  return runAccumulatorOp(
    this,
    fn,
    options,
    (acc, chunk) => {
      if (fn(chunk)) {
        acc.done = true;
        acc.value = true;
      }
    },
    (acc) => acc.value === true,
  ) as Promise<boolean>;
};

Readable.prototype.every = function every(
  this: Readable,
  fn: (data: unknown) => unknown,
  options?: { signal?: AbortSignal },
): Promise<boolean> {
  return runAccumulatorOp(
    this,
    fn,
    options,
    (acc, chunk) => {
      if (!fn(chunk)) {
        acc.done = true;
        acc.value = false;
      }
    },
    (acc) => acc.value !== false,
  ) as Promise<boolean>;
};

Readable.prototype.find = function find(
  this: Readable,
  fn: (data: unknown) => unknown,
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  return runAccumulatorOp(
    this,
    fn,
    options,
    (acc, chunk) => {
      if (fn(chunk)) {
        acc.done = true;
        acc.value = chunk;
      }
    },
    (acc) => acc.value,
  );
};

Readable.prototype.findIndex = function findIndex(
  this: Readable,
  fn: (data: unknown) => unknown,
  options?: { signal?: AbortSignal },
): Promise<number> {
  let index = 0;
  return runAccumulatorOp(
    this,
    fn,
    options,
    (acc, chunk) => {
      if (fn(chunk)) {
        acc.done = true;
        acc.value = index;
      }
      index++;
    },
    (acc) => (acc.value === undefined ? -1 : acc.value),
  ) as Promise<number>;
};

Readable.prototype.reduce = function reduce(
  this: Readable,
  fn: (acc: unknown, data: unknown) => unknown,
  initial?: unknown,
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  let first = initial === undefined;
  return runAccumulatorOp(
    this,
    () => undefined,
    options,
    (acc, chunk) => {
      if (first) {
        first = false;
        acc.value = chunk;
      } else {
        acc.value = fn(acc.value, chunk);
      }
    },
    (acc) => {
      if (first) {
        throw makeError("ERR_INVALID_ARGS", "Reduce of empty stream with no initial value");
      }
      return acc.value;
    },
  );
};

// ---------------------------------------------------------------------------
// Duplex (lib/internal/streams/duplex.js)
// ---------------------------------------------------------------------------

export interface Duplex extends Readable {
  _writableState: WritableState;
  _write(chunk: unknown, encoding: string, cb: (err?: Error | null) => void): void;
  _writev?(
    chunks: Array<{ chunk: unknown; encoding: string }>,
    cb: (err?: Error | null) => void,
  ): void;
  _final?(cb: (err?: Error | null) => void): void;
  writable: boolean;
  writableEnded: boolean;
  writableFinished: boolean;
  writableHighWaterMark: number;
  writableLength: number;
  writableObjectMode: boolean;
  writableCorked: number;
  writableNeedDrain: boolean;
  writableAborted: boolean;
  writableBuffer: BufferedChunk[];
  writableErrored: Error | null;
  allowHalfOpen: boolean;
  write(chunk: unknown, cb?: (err?: Error | null) => void): boolean;
  write(chunk: unknown, encoding?: string, cb?: (err?: Error | null) => void): boolean;
  end(cb?: () => void): this;
  end(chunk: unknown, cb?: () => void): this;
  end(chunk: unknown, encoding?: string, cb?: () => void): this;
  cork(): void;
  uncork(): void;
  setDefaultEncoding(encoding: string): this;
}
export interface DuplexCtor {
  new (opts?: StreamOptions): Duplex;
  (this: Duplex, opts?: StreamOptions): void;
  prototype: Duplex;
  fromWeb(
    pair: { readable: ReadableStream; writable: WritableStream },
    options?: StreamOptions,
  ): Duplex;
  toWeb(duplex: Duplex): { readable: ReadableStream; writable: WritableStream };
  from(body: unknown): Duplex;
}

export const Duplex = function Duplex(this: Duplex, options?: StreamOptions): void {
  if (!(this instanceof Duplex)) {
    return new (Duplex as unknown as { new (o?: StreamOptions): Duplex })(options) as never;
  }

  this._readableState = newReadableState(options, true);
  this._writableState = newWritableState(options, true);

  if (options) {
    this.allowHalfOpen = options.allowHalfOpen !== false;

    if (options.readable === false) {
      this._readableState.readable = false;
      this._readableState.ended = true;
      this._readableState.endEmitted = true;
    }

    if (options.writable === false) {
      this._writableState.writable = false;
      this._writableState.ending = true;
      this._writableState.ended = true;
      this._writableState.finished = true;
    }

    if (typeof options.read === "function") this._read = options.read;
    if (typeof options.write === "function") this._write = options.write;
    if (typeof options.writev === "function") this._writev = options.writev;
    if (typeof options.destroy === "function") this._destroy = options.destroy;
    if (typeof options.final === "function") this._final = options.final;
    if (typeof options.construct === "function") this._construct = options.construct;
    if (options.signal) addAbortSignal(options.signal, this as unknown as AnyStream & EventEmitter);
  } else {
    this.allowHalfOpen = true;
  }

  Stream.call(this, options);

  if (this._construct != null) {
    destroyImpl.construct(this as unknown as AnyStream & EventEmitter, () => {
      const rs = this._readableState;
      rs.constructed = true;
      if (rs.needReadable) maybeReadMore(this as unknown as Readable, rs);
      const ws = this._writableState;
      ws.constructed = true;
      if (!ws.writing) clearBuffer(this as unknown as Writable, ws);
      if (ws.ending) finishMaybe(this as unknown as Writable, ws);
    });
  }
} as unknown as DuplexCtor;

Object.setPrototypeOf(Duplex.prototype, Readable.prototype);
Object.setPrototypeOf(Duplex, Readable);

{
  const keys = Object.keys(Writable.prototype) as Array<keyof Writable>;
  for (const method of keys) {
    const m = method as string;
    if (!(Duplex.prototype as unknown as Record<string, unknown>)[m]) {
      (Duplex.prototype as unknown as Record<string, unknown>)[m] = (
        Writable.prototype as unknown as Record<string, unknown>
      )[m];
    }
  }
}

Duplex.prototype.destroy = Writable.prototype.destroy as unknown as Duplex["destroy"];
Duplex.prototype._undestroy = Writable.prototype._undestroy as unknown as Duplex["_undestroy"];

{
  const keys = Object.keys(writableGetters);
  for (const method of keys) {
    // `destroyed` gets Duplex-specific semantics (both sides) below.
    if (method === "destroyed") continue;
    if (!Object.getOwnPropertyDescriptor(Duplex.prototype, method)) {
      Object.defineProperty(Duplex.prototype, method, {
        ...Object.getOwnPropertyDescriptor(Writable.prototype, method)!,
        // Keep it reconfigurable — PassThrough/Transform inherit and tests
        // occasionally redefine.
        configurable: true,
      });
    }
  }
}

Object.defineProperty(Duplex.prototype, "destroyed", {
  get(this: Duplex) {
    if (this._readableState === undefined || this._writableState === undefined) {
      return false;
    }
    return this._readableState.destroyed && this._writableState.destroyed;
  },
  set(this: Duplex, value: boolean) {
    if (this._readableState && this._writableState) {
      this._readableState.destroyed = value;
      this._writableState.destroyed = value;
    }
  },
});

// ---------------------------------------------------------------------------
// Transform (lib/internal/streams/transform.js)
// ---------------------------------------------------------------------------

const kCallback = Symbol("bolo.stream.kCallback");

export interface Transform extends Duplex {
  _transform(
    chunk: unknown,
    encoding: string,
    cb: (err?: Error | null, data?: unknown) => void,
  ): void;
  _flush?(cb: (err?: Error | null, data?: unknown) => void): void;
  _final(cb: (err?: Error | null) => void): void;
}
export interface TransformCtor {
  new (opts?: StreamOptions): Transform;
  (this: Transform, opts?: StreamOptions): void;
  prototype: Transform;
}

export const Transform = function Transform(this: Transform, options?: StreamOptions): void {
  if (!(this instanceof Transform)) {
    return new (Transform as unknown as { new (o?: StreamOptions): Transform })(options) as never;
  }

  const readableHighWaterMark = options
    ? getHighWaterMark(
        { objectMode: Boolean(options?.objectMode) || Boolean(options?.readableObjectMode) },
        options,
        "readableHighWaterMark",
        true,
      )
    : null;
  if (readableHighWaterMark === 0) {
    // A Duplex will buffer both on the writable and readable side while
    // a Transform just wants to buffer hwm number of elements.
    options = {
      ...options,
      highWaterMark: undefined,
      readableHighWaterMark,
      writableHighWaterMark: options?.writableHighWaterMark || 0,
    };
  }

  Duplex.call(this, options);

  // We have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  (this as unknown as Record<symbol, unknown>)[kCallback] = null;

  if (options) {
    if (typeof options.transform === "function") this._transform = options.transform;
    if (typeof options.flush === "function") this._flush = options.flush;
  }

  // When the writable side finishes, then flush out anything remaining.
  this.on("prefinish", prefinishTransform);
} as unknown as TransformCtor;
Object.setPrototypeOf(Transform.prototype, Duplex.prototype);
Object.setPrototypeOf(Transform, Duplex);

const transformFinal = function (this: Transform, cb?: (err?: Error | null) => void): void {
  if (typeof this._flush === "function" && !this.destroyed) {
    this._flush((er?: Error | null, data?: unknown) => {
      if (er) {
        if (cb) {
          cb(er);
        } else {
          this.destroy(er);
        }
        return;
      }

      if (data != null) {
        this.push(data);
      }
      this.push(null);
      if (cb) {
        cb();
      }
    });
  } else {
    this.push(null);
    if (cb) {
      cb();
    }
  }
};

const prefinishTransform = function (this: Transform): void {
  if (this._final !== transformFinal) {
    transformFinal.call(this);
  }
};

Transform.prototype._final = transformFinal;

Transform.prototype._transform = function _transformImpl(
  this: Transform,
  _chunk: unknown,
  _encoding: string,
  _callback: (err?: Error | null, data?: unknown) => void,
): void {
  throw ERR.METHOD_NOT_IMPLEMENTED("_transform()");
};

Transform.prototype._write = function _writeTransform(
  this: Transform,
  chunk: unknown,
  encoding: string,
  callback: (err?: Error | null) => void,
): void {
  const rState = this._readableState;
  const wState = this._writableState;
  const length = rState.length;

  this._transform(chunk, encoding, (err?: Error | null, val?: unknown) => {
    if (err) {
      callback(err);
      return;
    }

    if (val != null) {
      this.push(val);
    }

    if (rState.ended) {
      // If user has called this.push(null) we have to
      // delay the callback to properly propagate the new
      // state.
      nextTick(callback);
    } else if (
      wState.ended || // Backwards compat.
      length === rState.length || // Backwards compat.
      rState.length < rState.highWaterMark
    ) {
      callback();
    } else {
      (self as unknown as Record<symbol, unknown>)[kCallback] = callback;
    }
  });
};

Transform.prototype._read = function _readTransform(this: Transform): void {
  const cb = (this as unknown as Record<symbol, unknown>)[kCallback] as
    | ((err?: Error | null) => void)
    | null;
  if (cb) {
    (this as unknown as Record<symbol, unknown>)[kCallback] = null;
    cb();
  }
};

// ---------------------------------------------------------------------------
// PassThrough (lib/internal/streams/passthrough.js)
// ---------------------------------------------------------------------------

export interface PassThrough extends Transform {}
export interface PassThroughCtor {
  new (opts?: StreamOptions): PassThrough;
  (this: PassThrough, opts?: StreamOptions): void;
  prototype: PassThrough;
}

export const PassThrough = function PassThrough(this: PassThrough, options?: StreamOptions): void {
  if (!(this instanceof PassThrough)) {
    return new (PassThrough as unknown as { new (o?: StreamOptions): PassThrough })(
      options,
    ) as never;
  }
  Transform.call(this, options);
} as unknown as PassThroughCtor;
Object.setPrototypeOf(PassThrough.prototype, Transform.prototype);
Object.setPrototypeOf(PassThrough, Transform);

PassThrough.prototype._transform = function _transformPassThrough(
  this: PassThrough,
  chunk: unknown,
  _encoding: string,
  cb: (err?: Error | null, data?: unknown) => void,
): void {
  cb(null, chunk);
};

// ---------------------------------------------------------------------------
// finished / end-of-stream (lib/internal/streams/end-of-stream.js)
// ---------------------------------------------------------------------------

export interface FinishedOptions {
  error?: boolean;
  readable?: boolean;
  writable?: boolean;
  signal?: AbortSignal;
}

const onceFn = <A extends unknown[]>(fn: (...args: A) => void): ((...args: A) => void) => {
  let called = false;
  return (...args: A) => {
    if (called) return;
    called = true;
    fn(...args);
  };
};

const isClosed = (stream: AnyStream): boolean => stream.closed === true;

const isReadableErrored = (stream: AnyStream): Error | boolean => {
  if (!isReadableNodeStream(stream)) return false;
  return (stream.errored ?? stream._readableState?.errored ?? false) as Error | boolean;
};

const isWritableErrored = (stream: AnyStream): Error | boolean => {
  if (!isWritableNodeStream(stream)) return false;
  return (stream.errored ?? stream._writableState?.errored ?? false) as Error | boolean;
};

const isRequest = (stream: AnyStream): boolean =>
  typeof stream.setHeader === "function" && typeof stream.abort === "function";

export const finished = (
  stream: unknown,
  options: FinishedOptions | ((err?: Error | null) => void),
  callback?: (err?: Error | null) => void,
): (() => void) => {
  let opts: FinishedOptions;
  let cb: ((err?: Error | null) => void) | undefined;
  if (typeof options === "function") {
    cb = options;
    opts = {};
  } else {
    opts = options ?? {};
    cb = callback;
  }
  if (cb === undefined || typeof cb !== "function") {
    throw ERR.INVALID_ARG_TYPE("callback", "Function", cb);
  }

  let callbackRef = onceFn(cb as (err?: Error | null) => void);

  if (isReadableStreamLike(stream) || isWritableStreamLike(stream)) {
    return eosWeb(stream as ReadableStream, opts, callbackRef);
  }

  if (!isNodeStream(stream)) {
    throw ERR.INVALID_ARG_TYPE("stream", ["ReadableStream", "WritableStream", "Stream"], stream);
  }

  const s = stream as AnyStream & EventEmitter;
  const readable = opts.readable ?? isReadableNodeStream(s);
  const writable = opts.writable ?? isWritableNodeStream(s);
  const wState = s._writableState;
  const rState = s._readableState;

  const onlegacyfinish = (): void => {
    if (!s.writable) {
      onfinish();
    }
  };

  let willEmitCloseNow =
    willEmitClose(s) &&
    isReadableNodeStream(s) === readable &&
    isWritableNodeStream(s) === writable;

  let writableFinishedNow = isWritableFinished(s, false);
  const onfinish = (): void => {
    writableFinishedNow = true;
    // Stream should not be destroyed here. If it is that
    // means that user space is doing something differently and
    // we cannot trust willEmitClose.
    if (s.destroyed) {
      willEmitCloseNow = false;
    }

    if (willEmitCloseNow && (!s.writable || readable)) {
      return;
    }

    if (!writable || readableFinishedNow) {
      callbackRef.call(s);
    }
  };

  let readableFinishedNow = isReadableFinished(s, false);
  const onend = (): void => {
    readableFinishedNow = true;
    if (s.destroyed) {
      willEmitCloseNow = false;
    }

    if (willEmitCloseNow && (!s.readable || writable)) {
      return;
    }

    if (!readable || writableFinishedNow) {
      callbackRef.call(s);
    }
  };

  const onerror = (err: unknown): void => {
    callbackRef.call(s, err as Error);
  };

  let closed = isClosed(s);

  const onclose = (): void => {
    closed = true;

    const errored = isWritableErrored(s) || isReadableErrored(s);

    if (errored && typeof errored !== "boolean") {
      return callbackRef.call(s, errored as Error);
    }

    if (readable && !readableFinishedNow && isReadableNodeStream(s, true)) {
      if (!isReadableFinished(s, false)) return callbackRef.call(s, ERR.STREAM_PREMATURE_CLOSE());
    }
    if (writable && !writableFinishedNow) {
      if (!isWritableFinished(s, false)) return callbackRef.call(s, ERR.STREAM_PREMATURE_CLOSE());
    }

    return callbackRef.call(s);
  };

  const onclosed = (): void => {
    closed = true;

    const errored = isWritableErrored(s) || isReadableErrored(s);

    if (errored && typeof errored !== "boolean") {
      return callbackRef.call(s, errored as Error);
    }

    callbackRef.call(s);
  };

  const onrequest = (): void => {
    s.req!.on("finish", onfinish as never);
  };

  if (isRequest(s)) {
    s.on("complete", onfinish as never);
    if (!willEmitCloseNow) {
      s.on("abort", onclose as never);
    }
    if (s.req) {
      onrequest();
    } else {
      s.on("request", onrequest as never);
    }
  } else if (writable && !wState) {
    // Legacy streams.
    s.on("end", onlegacyfinish as never);
    s.on("close", onlegacyfinish as never);
  }

  // Not all streams will emit 'close' after 'aborted'.
  if (!willEmitCloseNow && typeof s.aborted === "boolean") {
    s.on("aborted", onclose as never);
  }

  s.on("end", onend as never);
  s.on("finish", onfinish as never);
  if (opts.error !== false) {
    s.on("error", onerror as never);
  }
  s.on("close", onclose as never);

  if (closed) {
    nextTick(onclose);
  } else if (wState?.errorEmitted || rState?.errorEmitted) {
    if (!willEmitCloseNow) {
      nextTick(onclosed);
    }
  } else if (
    !readable &&
    (!willEmitCloseNow || Boolean(isReadable(s))) &&
    (Boolean(writableFinishedNow) || isWritable(s) === false)
  ) {
    nextTick(onclosed);
  } else if (
    !writable &&
    (!willEmitCloseNow || Boolean(isWritable(s))) &&
    (Boolean(readableFinishedNow) || isReadable(s) === false)
  ) {
    nextTick(onclosed);
  } else if (rState && s.req && s.aborted) {
    nextTick(onclosed);
  }

  const cleanup = (): void => {
    callbackRef = nop;
    s.removeListener("aborted", onclose as never);
    s.removeListener("complete", onfinish as never);
    s.removeListener("abort", onclose as never);
    s.removeListener("request", onrequest as never);
    if (s.req) s.req.removeListener("finish", onfinish as never);
    s.removeListener("end", onlegacyfinish as never);
    s.removeListener("close", onlegacyfinish as never);
    s.removeListener("finish", onfinish as never);
    s.removeListener("end", onend as never);
    s.removeListener("error", onerror as never);
    s.removeListener("close", onclose as never);
  };

  if (opts.signal && !closed) {
    const abort = (): void => {
      // Keep it because cleanup removes it.
      const endCallback = callbackRef;
      cleanup();
      endCallback.call(s, new AbortError());
    };
    if (opts.signal.aborted) {
      nextTick(abort);
    } else {
      const originalCallback = callbackRef;
      callbackRef = onceFn((...args: unknown[]) => {
        opts.signal!.removeEventListener("abort", abort);
        originalCallback.apply(s, args as [err?: Error | null]);
      });
      addAbortListener(opts.signal, abort);
    }
  }

  return cleanup;
};

const eosWeb = (
  stream: ReadableStream | WritableStream,
  opts: FinishedOptions,
  callback: (err?: Error | null) => void,
): (() => void) => {
  let isAborted = false;
  let cb = callback;
  if (opts.signal) {
    const abort = (): void => {
      isAborted = true;
      cb.call(stream, new AbortError());
    };
    if (opts.signal.aborted) {
      nextTick(abort);
    } else {
      const originalCallback = cb;
      cb = onceFn((...args: unknown[]) => {
        opts.signal!.removeEventListener("abort", abort);
        originalCallback.apply(stream, args as [err?: Error | null]);
      });
      addAbortListener(opts.signal, abort);
    }
  }
  let wait: Promise<unknown>;
  if (isReadableStreamLike(stream)) {
    wait = (stream as ReadableStream).getReader().closed;
  } else {
    wait = (stream as WritableStream).getWriter().closed;
  }
  const resolverFn = (...args: unknown[]): void => {
    if (!isAborted) {
      nextTick((a: unknown[]) => cb.apply(stream, a as [err?: Error | null]), args);
    }
  };
  wait.then(resolverFn, resolverFn);
  return nop;
};

// ---------------------------------------------------------------------------
// pipeline (lib/internal/streams/pipeline.js)
// ---------------------------------------------------------------------------

type PipelineCallback = (err?: Error | null, value?: unknown) => void;

const isDuckStream = (x: unknown): x is AnyStream & EventEmitter =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as { pipe?: unknown }).pipe === "function" &&
  typeof (x as { on?: unknown }).on === "function";

const isTransformStreamLike = (x: unknown): boolean =>
  typeof x === "object" &&
  x !== null &&
  isReadableStreamLike((x as { readable?: unknown }).readable) &&
  isWritableStreamLike((x as { writable?: unknown }).writable);

const makeAsyncIterable = (val: unknown): AsyncIterable<unknown> => {
  if (isAsyncIterable(val)) {
    return val;
  } else if (isReadableNodeStream(val)) {
    // Legacy streams are not Iterable.
    return fromReadable(val as Readable);
  }
  throw ERR.INVALID_ARG_TYPE("val", ["Readable", "Iterable", "AsyncIterable"], val);
};

async function* fromReadable(val: Readable): AsyncIterableIterator<unknown> {
  yield* streamToAsyncIterator(val);
}

const pumpToNode = async (
  iterable: AsyncIterable<unknown> | ReadableStream,
  writable: Writable,
  finish: (err?: Error | null) => void,
  opts: { end?: boolean },
): Promise<void> => {
  let error: Error | null = null;
  let onresolve: (() => void) | null = null;

  const resume = (err?: Error | null): void => {
    if (err) error = err;
    if (onresolve) {
      const callback = onresolve;
      onresolve = null;
      callback();
    }
  };

  const wait = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (error) {
        reject(error);
      } else {
        onresolve = () => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
      }
    });

  writable.on("drain", resume as never);
  const cleanup = finished(writable, { readable: false }, resume);

  try {
    if (writable.writableNeedDrain) {
      await wait();
    }

    if (isReadableStreamLike(iterable)) {
      const reader = iterable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!writable.write(value)) {
            await wait();
          }
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      for await (const chunk of iterable) {
        if (!writable.write(chunk)) {
          await wait();
        }
      }
    }

    if (opts.end !== false) {
      writable.end();
      await wait();
    }

    finish();
  } catch (err) {
    finish(error && error !== err ? (aggregateTwoErrors(error, err) as Error) : (err as Error));
  } finally {
    cleanup();
    writable.off("drain", resume as never);
  }
};

const pumpToWeb = async (
  readable: AsyncIterable<unknown>,
  writable: WritableStream,
  finish: (err?: Error | null) => void,
  opts: { end?: boolean },
): Promise<void> => {
  const w = isTransformStreamLike(writable)
    ? (writable as unknown as { writable: WritableStream }).writable
    : writable;
  const writer = w.getWriter();
  try {
    for await (const chunk of readable) {
      await writer.ready;
      writer.write(chunk as Uint8Array).catch(nop);
    }
    await writer.ready;
    if (opts.end !== false) {
      await writer.close();
    }
    finish();
  } catch (err) {
    try {
      await writer.abort(err);
      finish(err as Error);
    } catch (e) {
      finish(e as Error);
    }
  }
};

const destroyer = (
  stream: AnyStream & EventEmitter,
  reading: boolean,
  writing: boolean,
): { destroy: (err?: Error | null) => void; cleanup: () => void } => {
  let finishedFlag = false;
  stream.on("close", () => {
    finishedFlag = true;
  });

  const cleanup = finished(
    stream,
    { readable: reading, writable: writing },
    (err?: Error | null) => {
      finishedFlag = !err;
    },
  );

  return {
    destroy: (err?: Error | null) => {
      if (finishedFlag) return;
      finishedFlag = true;
      (stream as { destroy?: (e?: Error | null) => unknown }).destroy?.(
        err || ERR.STREAM_DESTROYED("pipe"),
      );
    },
    cleanup,
  };
};

interface PipelineOptions {
  signal?: AbortSignal;
  end?: boolean;
}

const pipelineImpl = (
  streams: unknown[],
  callback: PipelineCallback,
  opts?: PipelineOptions,
): unknown => {
  if (streams.length === 1 && Array.isArray(streams[0])) {
    streams = streams[0] as unknown[];
  }

  if (streams.length < 2) {
    throw ERR.MISSING_ARGS("streams");
  }

  const ac = new AbortController();
  const signal = ac.signal;
  const outerSignal = opts?.signal;

  // Need to cleanup event listeners if last stream is readable.
  const lastStreamCleanup: Array<() => void> = [];

  if (outerSignal !== undefined && typeof outerSignal !== "object") {
    throw ERR.INVALID_ARG_TYPE("options.signal", "AbortSignal", outerSignal);
  }

  const abort = (): void => {
    finishImpl(new AbortError());
  };

  if (outerSignal) {
    addAbortListener(outerSignal, abort);
  }

  let error: Error | null = null;
  let value: unknown;
  const destroys: Array<(err?: Error | null) => void> = [];

  let finishCount = 0;

  const finish = (err?: Error | null): void => {
    finishImpl(err ?? null, --finishCount === 0);
  };

  const finishImpl = (err: unknown, final?: boolean): void => {
    if (err && (!error || (error as { code?: string }).code === "ERR_STREAM_PREMATURE_CLOSE")) {
      error = err as Error;
    }

    if (!error && !final) {
      return;
    }

    while (destroys.length) {
      destroys.shift()!(error);
    }

    if (outerSignal) {
      outerSignal.removeEventListener("abort", abort);
    }
    ac.abort();

    if (final) {
      if (!error) {
        lastStreamCleanup.forEach((fn) => fn());
      }
      nextTick(callback, error, value);
    }
  };

  let ret: unknown;
  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    const reading = i < streams.length - 1;
    const writing = i > 0;
    const end = reading || opts?.end !== false;
    const isLastStream = i === streams.length - 1;

    if (isNodeStream(stream)) {
      const ns = stream as AnyStream & EventEmitter;
      if (end) {
        const { destroy, cleanup } = destroyer(ns, reading, writing);
        destroys.push(destroy);

        if (isReadable(stream) && isLastStream) {
          lastStreamCleanup.push(cleanup);
        }
      }

      // Catch stream errors that occur after pipe/pump has completed.
      const onError = (err: unknown): void => {
        if (
          err &&
          (err as Error).name !== "AbortError" &&
          (err as ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE"
        ) {
          finish(err as Error);
        }
      };
      ns.on("error", onError as never);
      if (isReadable(stream) && isLastStream) {
        lastStreamCleanup.push(() => {
          ns.removeListener("error", onError as never);
        });
      }
    }

    if (i === 0) {
      if (typeof stream === "function") {
        ret = (stream as (o: { signal: AbortSignal }) => unknown)({ signal });
        if (!isIterable(ret) && !isAsyncIterable(ret)) {
          throw makeError(
            "ERR_INVALID_RETURN_VALUE",
            `Expected Iterable, AsyncIterable or Stream to be returned from "source"`,
          );
        }
      } else if (
        isIterable(stream) ||
        isAsyncIterable(stream) ||
        isReadableNodeStream(stream) ||
        isTransformStreamLike(stream)
      ) {
        ret = stream;
      } else if (isReadableStreamLike(stream)) {
        ret = stream;
      } else {
        ret = Duplex.from(stream);
      }
    } else if (typeof stream === "function") {
      if (isTransformStreamLike(ret)) {
        ret = makeAsyncIterable((ret as { readable: ReadableStream }).readable);
      } else {
        ret = makeAsyncIterable(ret);
      }
      ret = (stream as (src: unknown, o: { signal: AbortSignal }) => unknown)(ret, {
        signal,
      });

      if (reading) {
        if (!isAsyncIterable(ret)) {
          throw makeError(
            "ERR_INVALID_RETURN_VALUE",
            `Expected AsyncIterable to be returned from "transform[${i - 1}]"`,
          );
        }
      } else {
        // If the last argument to pipeline is not a stream
        // we must create a proxy stream so that pipeline(...)
        // always returns a stream which can be further
        // composed through `.pipe(stream)`.

        const pt = new PassThrough({ objectMode: true });

        // Handle Promises/A+ spec, `then` could be a getter that throws on
        // second use.
        const then = (ret as { then?: unknown } | null)?.then;
        if (typeof then === "function") {
          finishCount++;
          (then as Function).call(
            ret,
            (val: unknown) => {
              value = val;
              if (val != null) {
                pt.write(val);
              }
              if (end) {
                pt.end();
              }
              nextTick(finish);
            },
            (err: unknown) => {
              pt.destroy(err as Error);
              nextTick(finish, err);
            },
          );
        } else if (isAsyncIterable(ret)) {
          finishCount++;
          void pumpToNode(ret as AsyncIterable<unknown>, pt, finish, { end });
        } else if (isReadableStreamLike(ret) || isTransformStreamLike(ret)) {
          const toRead = (ret as { readable?: ReadableStream }).readable ?? ret;
          finishCount++;
          void pumpToNode(toRead as ReadableStream, pt, finish, { end });
        } else {
          throw makeError(
            "ERR_INVALID_RETURN_VALUE",
            `Expected AsyncIterable or Promise to be returned from "destination"`,
          );
        }

        ret = pt;

        const { destroy, cleanup } = destroyer(
          ret as unknown as AnyStream & EventEmitter,
          false,
          true,
        );
        destroys.push(destroy);
        if (isLastStream) {
          lastStreamCleanup.push(cleanup);
        }
      }
    } else if (isNodeStream(stream)) {
      const dst = stream as unknown as Writable;
      if (isReadableNodeStream(ret)) {
        finishCount += 2;
        const cleanup = pipelinePipe(ret as unknown as Readable, dst, finish, { end });
        if (isReadable(stream) && isLastStream) {
          lastStreamCleanup.push(cleanup);
        }
      } else if (isTransformStreamLike(ret) || isReadableStreamLike(ret)) {
        const toRead = (ret as { readable?: ReadableStream }).readable ?? ret;
        finishCount++;
        void pumpToNode(toRead as ReadableStream, dst, finish, { end });
      } else if (isAsyncIterable(ret) || isIterable(ret)) {
        finishCount++;
        void pumpToNode(makeAsyncIterable(ret), dst, finish, { end });
      } else {
        throw ERR.INVALID_ARG_TYPE(
          "val",
          ["Readable", "Iterable", "AsyncIterable", "ReadableStream", "TransformStream"],
          ret,
        );
      }
      ret = stream;
    } else if (isWebStream(stream)) {
      const dst = stream as WritableStream;
      if (isReadableNodeStream(ret)) {
        finishCount++;
        void pumpToWeb(makeAsyncIterable(ret), dst, finish, { end });
      } else if (isReadableStreamLike(ret) || isAsyncIterable(ret) || isIterable(ret)) {
        finishCount++;
        void pumpToWeb(ret as AsyncIterable<unknown>, dst, finish, { end });
      } else if (isTransformStreamLike(ret)) {
        finishCount++;
        void pumpToWeb(
          (ret as { readable: ReadableStream }).readable as unknown as AsyncIterable<unknown>,
          dst,
          finish,
          { end },
        );
      } else {
        throw ERR.INVALID_ARG_TYPE(
          "val",
          ["Readable", "Iterable", "AsyncIterable", "ReadableStream", "TransformStream"],
          ret,
        );
      }
      ret = stream;
    } else {
      ret = Duplex.from(stream);
    }
  }

  if (signal?.aborted || outerSignal?.aborted) {
    nextTick(abort);
  }

  return ret;
};

const pipelinePipe = (
  src: Readable,
  dst: Writable,
  finish: (err?: Error | null) => void,
  opts: { end?: boolean },
): (() => void) => {
  let ended = false;
  dst.on("close", () => {
    if (!ended) {
      // Finish if the destination closes before the source has completed.
      finish(ERR.STREAM_PREMATURE_CLOSE());
    }
  });

  src.pipe(dst as unknown as DestLike, { end: false }); // If end is true we already will have a listener to end dst.

  const end = opts.end !== false;
  if (end) {
    const endFn = (): void => {
      ended = true;
      dst.end();
    };

    if (isReadableFinished(src as unknown as AnyStream)) {
      // End the destination if the source has already ended.
      nextTick(endFn);
    } else {
      src.once("end", endFn as never);
    }
  } else {
    finish();
  }

  finished(src, { readable: true, writable: false }, (err?: Error | null) => {
    const rState = src._readableState;
    if (
      err &&
      (err as { code?: string }).code === "ERR_STREAM_PREMATURE_CLOSE" &&
      rState &&
      rState.ended &&
      !rState.errored &&
      !rState.errorEmitted
    ) {
      // Some readable streams will emit 'close' before 'end'. Since this is
      // on the readable side 'end' should still be emitted if the stream has
      // been ended and no error emitted.
      src.once("end", finish as never).once("error", finish as never);
    } else {
      finish(err);
    }
  });
  return finished(
    dst as unknown as AnyStream & EventEmitter,
    { readable: false, writable: true },
    finish,
  );
};

export const pipeline = (...streams: unknown[]): unknown => {
  const callback = streams[streams.length - 1];
  if (typeof callback !== "function") {
    throw ERR.INVALID_ARG_TYPE("streams[stream.length - 1]", "Function", callback);
  }
  return pipelineImpl(
    streams.slice(0, -1),
    onceFn(callback as (a: unknown) => void) as PipelineCallback,
  );
};

// ---------------------------------------------------------------------------
// compose (lib/internal/streams/compose.js — simplified)
// ---------------------------------------------------------------------------

export const compose = (...streams: unknown[]): Duplex => {
  if (streams.length === 1 && (isIterable(streams[0]) || Array.isArray(streams[0]))) {
    streams = [...(streams[0] as Iterable<unknown>)];
  }
  if (streams.length === 0) {
    throw ERR.MISSING_ARGS("streams");
  }

  const pipelineStreams: Duplex[] = [];
  for (const s of streams) {
    if (!isNodeStream(s) && !isDuckStream(s) && !isWebStream(s)) {
      if (isIterable(s) || isAsyncIterable(s)) {
        pipelineStreams.push(
          Readable.from(s as Iterable<unknown>, { objectMode: true }) as unknown as Duplex,
        );
        continue;
      }
      throw ERR.INVALID_ARG_TYPE("stream", ["Duplex", "Iterable", "AsyncIterable"], s);
    }
    if (isReadableStreamLike(s)) {
      pipelineStreams.push(
        Readable.fromWeb(s as ReadableStream, { objectMode: true }) as unknown as Duplex,
      );
      continue;
    }
    const n = s as Duplex;
    if (
      typeof n.write !== "function" ||
      typeof n.push !== "function" ||
      (n._readableState === undefined && n._writableState === undefined)
    ) {
      // Readable-only / writable-only stages are allowed in Node's compose
      // (they're wrapped), but require duplexify plumbing we don't vendor —
      // wrap into PassThrough bridges.
      if (typeof (n as unknown as Readable).push === "function") {
        const pt = new PassThrough({ objectMode: true });
        (n as unknown as Readable).pipe(pt as unknown as DestLike);
        pipelineStreams.push(pt);
        continue;
      }
      if (typeof (n as unknown as Writable).write === "function") {
        const pt = new PassThrough({ objectMode: true });
        pt.pipe(n as unknown as DestLike);
        pipelineStreams.push(pt);
        continue;
      }
    }
    pipelineStreams.push(n);
  }

  const head = pipelineStreams[0];
  const tail = pipelineStreams[pipelineStreams.length - 1];

  // Wire the middle.
  for (let i = 0; i + 1 < pipelineStreams.length; i++) {
    (pipelineStreams[i] as unknown as Readable).pipe(pipelineStreams[i + 1] as unknown as DestLike);
  }

  const waitForDrain = (dst: Writable, cb: (err?: Error | null) => void): void => {
    dst.once("drain", () => cb());
  };

  const d = new Duplex({
    objectMode: true,
    write(chunk, _enc, cb) {
      if ((head as unknown as Writable).write(chunk)) cb();
      else waitForDrain(head as unknown as Writable, cb);
    },
    final(cb) {
      (head as unknown as Writable).end(() => cb());
    },
    read() {
      (tail as unknown as Readable).resume?.();
    },
    destroy(err, cb) {
      let pending = pipelineStreams.length;
      let firstErr = err;
      for (const s of pipelineStreams) {
        (
          s as unknown as { destroy: (e?: Error | null, c?: (e?: Error | null) => void) => void }
        ).destroy(err, (e?: Error | null) => {
          if (e && !firstErr) firstErr = e;
          if (--pending === 0) cb(firstErr);
        });
      }
      if (pending === 0) cb(err);
    },
  });

  tail.on("data", (c: unknown) => {
    if (!d.push(c)) (tail as unknown as Readable).pause();
  });
  tail.on("end", () => d.push(null));
  tail.on("error", (e: unknown) => d.destroy(e as Error));
  head.on("error", (e: unknown) => d.destroy(e as Error));

  return d;
};

Readable.prototype.compose = function composeMethod(
  this: Readable,
  stream: unknown,
  options?: { signal?: AbortSignal },
): Readable {
  void options;
  if (isIterable(stream) || isAsyncIterable(stream)) {
    const args = [this, ...(stream as Iterable<unknown>)];
    return compose(...args) as unknown as Readable;
  }
  return compose(this, stream) as unknown as Readable;
};

// ---------------------------------------------------------------------------
// duplexPair (lib/internal/streams/duplexpair.js — simplified)
// ---------------------------------------------------------------------------

export const duplexPair = (options?: StreamOptions): [Duplex, Duplex] => {
  const objectMode = true; // Node's duplexPair is always object mode.
  void options;
  const waitersA: Array<() => void> = [];
  const waitersB: Array<() => void> = [];

  const drainWaiters = (waiters: Array<() => void>): void => {
    while (waiters.length > 0) {
      waiters.shift()!();
    }
  };

  const a: Duplex = new Duplex({
    objectMode,
    read() {
      // Consumption on `a`'s readable side releases writers into `a`.
      drainWaiters(waitersB);
    },
    write(chunk, _enc, cb) {
      if ((b as unknown as Readable).push(chunk)) {
        cb();
      } else {
        waitersA.push(cb);
      }
    },
    final(cb) {
      (b as unknown as Readable).push(null);
      cb();
    },
  });

  const b: Duplex = new Duplex({
    objectMode,
    read() {
      drainWaiters(waitersA);
    },
    write(chunk, _enc, cb) {
      if ((a as unknown as Readable).push(chunk)) {
        cb();
      } else {
        waitersB.push(cb);
      }
    },
    final(cb) {
      (a as unknown as Readable).push(null);
      cb();
    },
  });

  return [a, b];
};

// ---------------------------------------------------------------------------
// Readable.from (lib/internal/streams/from.js — simplified)
// ---------------------------------------------------------------------------

const fromImpl = (iterable: unknown, opts?: StreamOptions): Readable => {
  const options = { ...opts, objectMode: true };
  let iterator: Iterator<unknown> | AsyncIterator<unknown> | null = null;
  let reading = false;

  const source = iterable as {
    readable?: boolean;
    pipe?: unknown;
    [Symbol.iterator]?: () => Iterator<unknown>;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };

  // If the source is already a node Readable-ish stream, wrap passthrough.
  if (
    source !== null &&
    typeof source === "object" &&
    typeof source.pipe === "function" &&
    (source as { _readableState?: unknown })._readableState !== undefined
  ) {
    const src = source as unknown as Readable;
    const r = new Readable({
      ...options,
      read() {
        src.resume?.();
      },
      destroy(err, cb) {
        (
          src as unknown as { destroy: (e?: Error | null, c?: (e?: Error | null) => void) => void }
        ).destroy(err, cb);
      },
    });
    src.on("data", (c: unknown) => {
      if (!r.push(c)) src.pause?.();
    });
    src.on("end", () => r.push(null));
    src.on("error", (e: unknown) => r.destroy(e as Error));
    return r;
  }

  const getIterator = (): Iterator<unknown> | AsyncIterator<unknown> => {
    if (isAsyncIterable(source)) return source[Symbol.asyncIterator]!();
    if (isIterable(source)) return source[Symbol.iterator]!();
    throw ERR.INVALID_ARG_TYPE("iterable", ["Iterable", "AsyncIterable"], source);
  };

  const r = new Readable({
    ...options,
    read() {
      if (reading) return;
      if (iterator === null) {
        try {
          iterator = getIterator();
        } catch (err) {
          errorOrDestroy(this as unknown as AnyStream & EventEmitter, err);
          return;
        }
      }
      reading = true;
      const pump = (): void => {
        Promise.resolve(iterator!.next()).then(
          ({ done, value }) => {
            reading = false;
            if (done) {
              r.push(null);
            } else {
              if (r.push(value)) {
                // push() returning true does NOT mean the buffer is empty —
                // Node's from() keeps pumping only on subsequent _read calls.
                return;
              }
            }
          },
          (err) => {
            reading = false;
            r.destroy(err as Error);
          },
        );
      };
      pump();
    },
    destroy(err, cb) {
      const it = iterator;
      iterator = null;
      const ret = it ? (it as AsyncIterator<unknown>).return : undefined;
      if (typeof ret === "function") {
        Promise.resolve(ret.call(it, undefined)).then(
          () => cb(err),
          (e) => cb((e as Error) ?? err),
        );
      } else {
        cb(err);
      }
    },
  });

  return r;
};

Readable.from = fromImpl;
Readable.isDisturbed = isDisturbed;

// ---------------------------------------------------------------------------
// Web stream interop (internal/webstreams/adapters.js — simplified)
// ---------------------------------------------------------------------------

const toUint8 = (chunk: unknown): Uint8Array | unknown => {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (Buffer.isBuffer(chunk))
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (isArrayBufferView(chunk))
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return chunk;
};

const newReadableStreamFromReadable = (readable: Readable): ReadableStream => {
  let reader: ReadableStreamDefaultController | null = null;
  let closed = false;
  return new ReadableStream({
    start(controller) {
      reader = controller as unknown as ReadableStreamDefaultController;
    },
    async pull() {
      if (closed || readable.destroyed) {
        try {
          (reader as unknown as { close: () => void }).close();
        } catch {}
        closed = true;
        return;
      }
      while (true) {
        const chunk = readable.read();
        if (chunk !== null) {
          (reader as unknown as { enqueue: (c: unknown) => void }).enqueue(toUint8(chunk));
          return;
        }
        if (readable.readableEnded || readable.destroyed || readable._readableState?.ended) {
          closed = true;
          try {
            (reader as unknown as { close: () => void }).close();
          } catch {}
          return;
        }
        await new Promise<void>((resolve) => {
          const cleanup = (): void => {
            readable.removeListener("readable", on as never);
            readable.removeListener("end", on as never);
            readable.removeListener("close", on as never);
            readable.removeListener("error", on as never);
          };
          const on = (): void => {
            cleanup();
            resolve();
          };
          readable.on("readable", on as never);
          readable.on("end", on as never);
          readable.on("close", on as never);
          readable.on("error", on as never);
        });
      }
    },
    cancel(reason?: unknown) {
      closed = true;
      readable.destroy(reason instanceof Error ? reason : undefined);
      return new Promise<void>((resolve) => {
        finished(readable, () => resolve());
      });
    },
  });
};

const newReadableFromReadableStream = (
  readableStream: ReadableStream,
  options?: StreamOptions,
): Readable => {
  const reader = (readableStream as ReadableStream).getReader();
  let closed = false;
  let r: Readable;
  r = new Readable({
    ...options,
    read() {
      if (closed) return;
      reader.read().then(
        ({ done, value }) => {
          if (done) {
            closed = true;
            r.push(null);
          } else {
            r.push(value);
          }
        },
        (err) => {
          closed = true;
          r.destroy(err as Error);
        },
      );
    },
    destroy(err, cb) {
      closed = true;
      Promise.resolve(reader.cancel()).then(
        () => cb(err),
        () => cb(err),
      );
    },
  });
  return r;
};

const newWritableStreamFromWritable = (writable: Writable): WritableStream => {
  return new WritableStream({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        try {
          writable.write(chunk, (err?: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        } catch (err) {
          reject(err);
        }
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        writable.end(() => {
          if (writable.errored) reject(writable.errored);
          else resolve();
        });
      });
    },
    abort(reason?: unknown) {
      writable.destroy(reason instanceof Error ? reason : new AbortError());
    },
  });
};

const newWritableFromWritableStream = (
  writableStream: WritableStream,
  options?: StreamOptions,
): Writable => {
  const writer = (writableStream as WritableStream).getWriter();
  let closing = false;
  return new Writable({
    ...options,
    write(chunk, _enc, cb) {
      Promise.resolve(writer.write(chunk as Uint8Array)).then(
        () => cb(),
        (e) => cb(e as Error),
      );
    },
    final(cb) {
      if (closing) {
        cb();
        return;
      }
      closing = true;
      Promise.resolve(writer.close()).then(
        () => cb(),
        (e) => cb(e as Error),
      );
    },
    destroy(err, cb) {
      Promise.resolve(writer.abort(err instanceof Error ? err : undefined)).then(
        () => cb(err),
        () => cb(err),
      );
    },
  });
};

const newDuplexFromReadableWritablePair = (
  pair: { readable: ReadableStream; writable: WritableStream },
  options?: StreamOptions,
): Duplex => {
  const reader = pair.readable.getReader();
  const writer = pair.writable.getWriter();
  let closed = false;
  let r: Duplex;
  r = new Duplex({
    ...options,
    read() {
      if (closed) return;
      reader.read().then(
        ({ done, value }) => {
          if (done) {
            closed = true;
            r.push(null);
          } else {
            r.push(value);
          }
        },
        (err) => {
          closed = true;
          r.destroy(err as Error);
        },
      );
    },
    write(chunk, _enc, cb) {
      Promise.resolve(writer.write(chunk as Uint8Array)).then(
        () => cb(),
        (e) => cb(e as Error),
      );
    },
    final(cb) {
      Promise.resolve(writer.close()).then(
        () => cb(),
        (e) => cb(e as Error),
      );
    },
    destroy(err, cb) {
      Promise.allSettled([
        reader.cancel(),
        writer.abort(err instanceof Error ? err : undefined),
      ]).then(() => cb(err));
    },
  });
  return r;
};

const newReadableWritablePairFromDuplex = (
  duplex: Duplex,
): { readable: ReadableStream; writable: WritableStream } => {
  return {
    readable: newReadableStreamFromReadable(duplex as unknown as Readable),
    writable: newWritableStreamFromWritable(duplex as unknown as Writable),
  };
};

Readable.fromWeb = newReadableFromReadableStream;
Readable.toWeb = newReadableStreamFromReadable;
Writable.fromWeb = newWritableFromWritableStream;
Writable.toWeb = newWritableStreamFromWritable;
(Duplex as unknown as Record<string, unknown>).fromWeb = newDuplexFromReadableWritablePair;
(Duplex as unknown as Record<string, unknown>).toWeb = newReadableWritablePairFromDuplex;
(Duplex as unknown as Record<string, unknown>).from = (body: unknown): Duplex => {
  if (isNodeStream(body)) return body as unknown as Duplex;
  if (isIterable(body) || isAsyncIterable(body)) {
    const r = Readable.from(body as Iterable<unknown>, { objectMode: true });
    return r as unknown as Duplex;
  }
  if (typeof body === "function") {
    const r = Readable.from((body as () => Iterable<unknown>)(), { objectMode: true });
    return r as unknown as Duplex;
  }
  return new Duplex({ objectMode: true });
};

// ---------------------------------------------------------------------------
// stream/consumers (lib/stream/consumers.js)
// ---------------------------------------------------------------------------

const streamToIterable = async function* (stream: unknown): AsyncIterableIterator<unknown> {
  if (isAsyncIterable(stream) || isNodeStream(stream)) {
    for await (const chunk of stream as AsyncIterable<unknown>) {
      yield chunk;
    }
    return;
  }
  if (isIterable(stream)) {
    for (const chunk of stream as Iterable<unknown>) yield chunk;
    return;
  }
  if (isReadableStreamLike(stream)) {
    const reader = (stream as ReadableStream).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  const maybeBlob = stream as { stream?: () => ReadableStream } | null;
  if (maybeBlob && typeof maybeBlob.stream === "function") {
    yield* streamToIterable(maybeBlob.stream());
    return;
  }
  throw ERR.INVALID_ARG_TYPE("stream", ["ReadableStream", "stream.Readable", "Blob"], stream);
};

const collect = async (stream: unknown): Promise<unknown[]> => {
  const chunks: unknown[] = [];
  for await (const chunk of streamToIterable(stream)) {
    chunks.push(chunk);
  }
  return chunks;
};

const concatBuffers = (chunks: unknown[]): Buffer => {
  const buffers = chunks.map((c) =>
    Buffer.isBuffer(c)
      ? (c as Buffer)
      : typeof c === "string"
        ? Buffer.from(c)
        : Buffer.from(c as Uint8Array),
  );
  return Buffer.concat(buffers as Buffer[]);
};

export const consumers = {
  async buffer(stream: unknown): Promise<Buffer> {
    const chunks = await collect(stream);
    return concatBuffers(chunks);
  },
  async bytes(stream: unknown): Promise<Uint8Array> {
    const b = await consumers.buffer(stream);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  },
  async text(stream: unknown): Promise<string> {
    const chunks = await collect(stream);
    return chunks
      .map((c) => (typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8")))
      .join("");
  },
  async json(stream: unknown): Promise<unknown> {
    const text = await consumers.text(stream);
    return JSON.parse(text);
  },
  async arrayBuffer(stream: unknown): Promise<ArrayBuffer> {
    const b = await consumers.buffer(stream);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  },
  async blob(stream: unknown): Promise<Blob> {
    const chunks = await collect(stream);
    return new Blob(
      chunks.map((c) => (typeof c === "string" ? c : (toUint8(c) as BlobPart))) as BlobPart[],
    );
  },
};

// ---------------------------------------------------------------------------
// promises facade (node:stream/promises)
// ---------------------------------------------------------------------------

const pipelinePromise = (...streams: unknown[]): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const args = [...streams];
    let options: { signal?: AbortSignal; end?: boolean } = {};
    const lastArg = args[args.length - 1];
    if (
      lastArg !== undefined &&
      typeof lastArg === "object" &&
      lastArg !== null &&
      !isNodeStream(lastArg) &&
      !isWebStream(lastArg) &&
      !isIterable(lastArg) &&
      !isAsyncIterable(lastArg)
    ) {
      options = args.pop() as { signal?: AbortSignal; end?: boolean };
    }
    pipelineImpl(
      args,
      (err?: Error | null, value?: unknown) => {
        if (err) reject(err);
        else resolve(value);
      },
      options,
    );
  });

const finishedPromise = (stream: unknown, options?: FinishedOptions): Promise<void> =>
  new Promise((resolve, reject) => {
    finished(stream, options ?? {}, (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });

export const promises = {
  pipeline: pipelinePromise,
  finished: finishedPromise,
};

// ---------------------------------------------------------------------------
// misc stream functions
// ---------------------------------------------------------------------------

export const destroy = (stream: unknown, err?: Error): unknown => {
  const s = stream as { destroy?: (e?: Error) => unknown } | null;
  if (s && typeof s.destroy === "function") s.destroy(err);
  return stream;
};

export const _isUint8Array = isUint8Array;
export const _uint8ArrayToBuffer = uint8ArrayToBuffer;
export const _isArrayBufferView = isArrayBufferView;

// ---------------------------------------------------------------------------
// Shim assembly
// ---------------------------------------------------------------------------

const eventStatics = {
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  Stream,
  pipeline,
  finished,
  addAbortSignal,
  compose,
  destroy,
  promises,
  consumers,
  isDisturbed,
  isReadable,
  isWritable,
  isErrored,
  isDestroyed,
  getErrored,
  duplexPair,
  getDefaultHighWaterMark,
  setDefaultHighWaterMark,
  _isUint8Array,
  _uint8ArrayToBuffer,
  _isArrayBufferView,
};

// Like the events shim, the module object must stay a callable constructor
// (`require('stream')` returns `Stream` itself) with every module-level name
// as an *enumerable* own property — `shimModuleSource` re-exports
// `Object.keys(shim)`.
const streamShim = Object.assign(Stream, eventStatics) as unknown as StreamCtor &
  typeof eventStatics;

// `stream.web` subobject for `getBuiltinModule('stream/web')`/`shims.stream.web`
// lookups — the actual `node:stream/web` module is src/stream/web.ts.
const streamWeb = {
  ReadableStream: (globalThis as { ReadableStream?: unknown }).ReadableStream,
  ReadableStreamDefaultReader: (globalThis as { ReadableStreamDefaultReader?: unknown })
    .ReadableStreamDefaultReader,
  ReadableStreamBYOBReader: (globalThis as { ReadableStreamBYOBReader?: unknown })
    .ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest: (globalThis as { ReadableStreamBYOBRequest?: unknown })
    .ReadableStreamBYOBRequest,
  ReadableByteStreamController: (globalThis as { ReadableByteStreamController?: unknown })
    .ReadableByteStreamController,
  ReadableStreamDefaultController: (globalThis as { ReadableStreamDefaultController?: unknown })
    .ReadableStreamDefaultController,
  TransformStream: (globalThis as { TransformStream?: unknown }).TransformStream,
  TransformStreamDefaultController: (globalThis as { TransformStreamDefaultController?: unknown })
    .TransformStreamDefaultController,
  WritableStream: (globalThis as { WritableStream?: unknown }).WritableStream,
  WritableStreamDefaultWriter: (globalThis as { WritableStreamDefaultWriter?: unknown })
    .WritableStreamDefaultWriter,
  WritableStreamDefaultController: (globalThis as { WritableStreamDefaultController?: unknown })
    .WritableStreamDefaultController,
  ByteLengthQueuingStrategy: (globalThis as { ByteLengthQueuingStrategy?: unknown })
    .ByteLengthQueuingStrategy,
  CountQueuingStrategy: (globalThis as { CountQueuingStrategy?: unknown }).CountQueuingStrategy,
  TextEncoderStream: (globalThis as { TextEncoderStream?: unknown }).TextEncoderStream,
  TextDecoderStream: (globalThis as { TextDecoderStream?: unknown }).TextDecoderStream,
  CompressionStream: (globalThis as { CompressionStream?: unknown }).CompressionStream,
  DecompressionStream: (globalThis as { DecompressionStream?: unknown }).DecompressionStream,
};
Object.defineProperty(streamShim, "web", { value: streamWeb, enumerable: true });
Object.defineProperty(streamShim, "Stream", {
  value: Stream,
  enumerable: true,
  configurable: true,
  writable: true,
});

export const createStreamShim = (): typeof streamShim => {
  return streamShim;
};

// `Stream` is already a named export (declared `export const` above); the
// remaining module names are exported inline alongside their declarations.

export default createStreamShim();
