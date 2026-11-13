import { createEventsShim } from "./events.js";
import { unsupportedError } from "./coded-error.js";

const { EventEmitter } = createEventsShim();

/**
 * node:worker_threads shim.
 *
 * The default configuration runs on the "main thread" of its realm and can
 * spawn real browser Workers for `eval` code and absolute-URL scripts through
 * an inline bootstrap (see `WORKER_BOOTSTRAP`). Hosts that can give a spawned
 * worker the full node shim surface (bolo's worker-per-process model: one
 * bundled `node-process-worker` per thread) inject `spawnWorker`; hosts that
 * ARE a spawned worker inject `context` ({ workerData, parentPort, threadId })
 * — `createWorkerThreadsShim` then reports `isMainThread === false` and
 * exposes the bridge `parentPort`.
 *
 * Protocol between a `Worker` object and its spawned realm is deliberately
 * thin: `postMessage` payloads cross verbatim (host envelopes are the
 * spawner's business), `setOnExit` reports the exit code, `setOnError`
 * reports a startup/uncaught failure. Structured-clone fidelity (MessagePort
 * transfer, SharedArrayBuffer) is whatever the underlying transport supports.
 */

// ── Spawn seam ──────────────────────────────────────────────────────

export interface WorkerThreadSpawnSpec {
  /** Path/URL the user passed to `new Worker()` (absent for `eval`). */
  readonly filename?: string;
  /** Source to run when `new Worker(code, { eval: true })`. */
  readonly code?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly workerData?: unknown;
  /** Parent-assigned id — the spawned realm reports it as its `threadId`. */
  readonly threadId?: number;
}

export interface WorkerThreadHandle {
  postMessage(value: unknown, transfer?: readonly Transferable[]): void;
  terminate(): void;
  setOnMessage(cb: ((value: unknown) => void) | null): void;
  setOnError(cb: ((error: unknown) => void) | null): void;
  setOnExit(cb: ((code: number) => void) | null): void;
}

export type WorkerThreadSpawner = (spec: WorkerThreadSpawnSpec) => WorkerThreadHandle | undefined;

/** Present when this realm is itself a spawned worker thread. */
export interface WorkerThreadContext {
  readonly workerData?: unknown;
  /** Port-like bridge to the parent (`postMessage`/`on`/`close`). */
  readonly parentPort?: unknown;
  readonly threadId?: number;
}

export interface WorkerThreadsShimOptions {
  readonly spawnWorker?: WorkerThreadSpawner;
  readonly context?: WorkerThreadContext;
}

// ── Shim surface types ──────────────────────────────────────────────

/**
 * `Worker` object shape exposed by {@link WorkerThreadsShim}. Deliberately a
 * named interface (not the local class) so the factory's return type stays
 * free of private members.
 */
export interface WorkerThreadInstance {
  readonly threadId: number;
  readonly resourceLimits: Required<Record<string, number>>;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;
  emit(event: string | symbol, ...args: any[]): boolean;
  postMessage(value: unknown, transferList?: readonly unknown[]): void;
  terminate(): Promise<number>;
  ref(): this;
  unref(): this;
  hasRef(): boolean;
  getHeapSnapshot(): Promise<never>;
}

export interface WorkerThreadConstructor {
  new (filename: string | URL, opts?: Record<string, unknown>): WorkerThreadInstance;
}

/**
 * Minimal `BroadcastChannel` contract — satisfied by the native class when
 * present and by the EventTarget fallback otherwise.
 */
export interface BroadcastChannelLike extends EventTarget {
  postMessage(message: unknown): void;
  close(): void;
}

export interface BroadcastChannelConstructor {
  new (name?: string): BroadcastChannelLike;
}

/** The `node:worker_threads` surface `createWorkerThreadsShim` returns. */
export interface WorkerThreadsShim {
  readonly Worker: WorkerThreadConstructor;
  readonly isMainThread: boolean;
  /** `ShimMessagePort` or a host-provided bridge; `null` on the main thread. */
  readonly parentPort: unknown;
  readonly workerData: unknown;
  readonly threadId: number;
  readonly resourceLimits: Required<Record<string, number>>;
  readonly MessageChannel: typeof ShimMessageChannel;
  readonly MessagePort: typeof ShimMessagePort;
  readonly BroadcastChannel: BroadcastChannelConstructor;
  readonly SHARE_ENV: symbol;
  readonly receiveMessageOnPort: (port: unknown) => unknown;
  readonly moveMessagePortToContext: (port: unknown, contextifiedSandbox?: unknown) => unknown;
  readonly markAsUntransferable: typeof markAsUntransferable;
  readonly markAsUncloneable: typeof markAsUncloneable;
  readonly isMarkedAsUntransferable: typeof isMarkedAsUntransferable;
  readonly setEnvironmentData: (key: unknown, value: unknown) => void;
  readonly getEnvironmentData: (key: unknown) => unknown;
  readonly postMessageToThread: (
    targetThreadId: number,
    value: unknown,
    transferList?: readonly unknown[],
    timeout?: number,
  ) => Promise<unknown>;
}

// ── Clone / transfer guards ─────────────────────────────────────────

const uncloneable = new WeakSet<object>();
const untransferable = new WeakSet<object>();

export const markAsUncloneable = (value: unknown): void => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError('The "value" argument must be an object');
  }
  uncloneable.add(value as object);
};

export const markAsUntransferable = (value: unknown): void => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError('The "value" argument must be an object');
  }
  untransferable.add(value as object);
};

export const isMarkedAsUntransferable = (value: unknown): boolean =>
  typeof value === "object" && value !== null && untransferable.has(value as object);

const assertCloneable = (value: unknown, seen = new Set<unknown>()): void => {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  if (uncloneable.has(value)) {
    const err = new Error("Object could not be cloned.") as Error & { code: string };
    err.code = "ERR_INVALID_ARG_VALUE";
    throw err;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertCloneable(item, seen);
    return;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Date) return;
  if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    for (const item of Object.values(value)) assertCloneable(item, seen);
  }
};

// ── MessagePort ─────────────────────────────────────────────────────

/** Transport behind a `ShimMessagePort`: native MessagePort, a same-realm
 * linked peer, or a host-provided bridge (process-worker threads). */
interface PortBackend {
  post(value: unknown, transfer?: readonly Transferable[]): void;
  close(): void;
  start?(): void;
  /** Deliver an inbound value; set exactly once. */
  setOnMessage(cb: ((value: unknown) => void) | null): void;
  /** Transferable representing this port when it crosses a real boundary. */
  readonly transferable?: Transferable;
}

const unwrapTransferable = (value: unknown): Transferable => {
  if (value instanceof ShimMessagePort) {
    const t = value.backend.transferable;
    if (!t) {
      throw new Error(
        "MessagePort cannot be transferred: this port is not backed by a transferable " +
          "channel endpoint (same-realm linked port or host bridge)",
      );
    }
    return t;
  }
  if (isMarkedAsUntransferable(value)) {
    throw new Error("Value marked as untransferable cannot be transferred");
  }
  return value as Transferable;
};

/**
 * Node's `MessagePort` cannot be constructed by user code
 * (`ERR_CONSTRUCT_CALL_INVALID`) — instances only come from a
 * `MessageChannel`. The shim keeps the class for `instanceof` and prototype
 * fidelity; internal code mints ports through `createShimMessagePort`.
 */
const PORT_CONSTRUCTOR = Symbol("bolo.MessagePort.constructor");

type EventEmitterInstance = {
  on(event: string | symbol, listener: (...args: any[]) => void): unknown;
  once(event: string | symbol, listener: (...args: any[]) => void): unknown;
  emit(event: string | symbol, ...args: unknown[]): boolean;
  listenerCount(event: string | symbol): number;
};

export interface ShimMessagePort extends EventEmitterInstance {
  readonly backend: PortBackend;
  postMessage(value: unknown, transferList?: readonly unknown[]): void;
  dequeue(): unknown;
  start(): void;
  close(): void;
  ref(): this;
  unref(): this;
  hasRef(): boolean;
}

type EventEmitterClass = new () => EventEmitterInstance;

class ShimMessagePortImpl extends (EventEmitter as unknown as EventEmitterClass) {
  /** Inbound values buffered while no 'message' listener is attached —
   * the queue `receiveMessageOnPort` drains. */
  private readonly queue: unknown[] = [];
  private closed = false;
  /** @internal */
  readonly backend: PortBackend;

  /** @internal */
  constructor(backend: PortBackend, token?: symbol) {
    super();
    if (token !== PORT_CONSTRUCTOR) {
      throw Object.assign(
        new TypeError(
          "MessagePort cannot be constructed directly. Use MessageChannel() to create a port pair.",
        ),
        { code: "ERR_CONSTRUCT_CALL_INVALID" },
      );
    }
    this.backend = backend;
    backend.setOnMessage((value) => this.deliver(value));
  }

  private deliver(value: unknown): void {
    if (this.closed) return;
    // Node semantics: with 'message' listeners the port flows; without them
    // values queue for `receiveMessageOnPort`/`start()`.
    if (this.listenerCount("message") > 0) this.emit("message", value);
    else this.queue.push(value);
  }

  private drain(): void {
    while (this.queue.length > 0 && this.listenerCount("message") > 0) {
      this.emit("message", this.queue.shift());
    }
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "message") queueMicrotask(() => this.drain());
    return this;
  }

  postMessage(value: unknown, transferList?: readonly unknown[]): void {
    if (this.closed) {
      const err = new Error("MessagePort is closed") as Error & { code: string };
      err.code = "ERR_CLOSED_MESSAGE_PORT";
      throw err;
    }
    assertCloneable(value);
    const transfer = (transferList ?? []).map(unwrapTransferable);
    this.backend.post(value, transfer);
  }

  /** Dequeue one buffered message — `receiveMessageOnPort` backend. */
  dequeue(): unknown {
    return this.queue.length > 0 ? { message: this.queue.shift() } : undefined;
  }

  start(): void {
    this.backend.start?.();
    this.drain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.backend.close();
    this.emit("close");
  }

  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  hasRef(): boolean {
    return true;
  }
}

/**
 * `MessagePort` — Node's is not constructible by user code: both
 * `MessagePort()` and `new MessagePort()` throw
 * `ERR_CONSTRUCT_CALL_INVALID`. A native class would raise a plain TypeError
 * for the call form, so the exported constructor is function-style and
 * raises Node's exact error in both cases.
 */
export const ShimMessagePort = function MessagePort(
  this: ShimMessagePort,
  backend?: PortBackend,
  token?: symbol,
): ShimMessagePort | void {
  throw Object.assign(
    new TypeError(
      "MessagePort cannot be constructed directly. Use MessageChannel() to create a port pair.",
    ),
    { code: "ERR_CONSTRUCT_CALL_INVALID" },
  );
} as unknown as {
  new (backend?: PortBackend, token?: symbol): ShimMessagePort;
  (backend?: PortBackend, token?: symbol): ShimMessagePort;
  prototype: ShimMessagePort;
};

Object.defineProperty(ShimMessagePort, "prototype", {
  value: ShimMessagePortImpl.prototype,
  writable: false,
  configurable: false,
});
// `port.constructor === MessagePort` — Node's ports report the exported
// constructor, not an internal implementation class.
Object.defineProperty(ShimMessagePortImpl.prototype, "constructor", {
  value: ShimMessagePort,
  writable: true,
  configurable: true,
});

const createShimMessagePort = (backend: PortBackend): ShimMessagePort =>
  new (ShimMessagePortImpl as unknown as {
    new (b: PortBackend, t: symbol): ShimMessagePort;
  })(backend, PORT_CONSTRUCTOR);

const wrapNativePort = (native: MessagePort): ShimMessagePort =>
  createShimMessagePort({
    transferable: native,
    post: (value, transfer) => native.postMessage(value, { transfer: [...(transfer ?? [])] }),
    close: () => native.close(),
    start: () => native.start(),
    setOnMessage: (cb) => {
      native.onmessage = cb ? (ev: MessageEvent) => cb(ev.data) : null;
    },
  });

const createLinkedPair = (): [ShimMessagePort, ShimMessagePort] => {
  let a: ((v: unknown) => void) | null = null;
  let b: ((v: unknown) => void) | null = null;
  const port1 = createShimMessagePort({
    post: (v) => queueMicrotask(() => b?.(v)),
    close: () => {},
    setOnMessage: (cb) => {
      a = cb;
    },
  });
  const port2 = createShimMessagePort({
    post: (v) => queueMicrotask(() => a?.(v)),
    close: () => {},
    setOnMessage: (cb) => {
      b = cb;
    },
  });
  return [port1, port2];
};

const NativeMessageChannel = (globalThis as { MessageChannel?: typeof globalThis.MessageChannel })
  .MessageChannel;

/**
 * `MessageChannel` — Node's is a class: calling it without `new` throws
 * `ERR_CONSTRUCT_CALL_REQUIRED`. Function-style construction lets the shim
 * raise that exact code (a native class would throw a plain TypeError).
 */
interface ShimMessageChannel {
  readonly port1: ShimMessagePort;
  readonly port2: ShimMessagePort;
}

interface ShimMessageChannelCtor {
  new (): ShimMessageChannel;
  (): ShimMessageChannel;
  prototype: ShimMessageChannel;
}

export const ShimMessageChannel = function MessageChannel(
  this: ShimMessageChannel,
): ShimMessageChannel | void {
  if (!(this instanceof ShimMessageChannel)) {
    throw Object.assign(
      new TypeError("Class constructor MessageChannel cannot be invoked without 'new'"),
      { code: "ERR_CONSTRUCT_CALL_REQUIRED" },
    );
  }
  if (NativeMessageChannel) {
    const channel = new NativeMessageChannel();
    (this as { port1: ShimMessagePort }).port1 = wrapNativePort(channel.port1);
    (this as { port2: ShimMessagePort }).port2 = wrapNativePort(channel.port2);
  } else {
    const [port1, port2] = createLinkedPair();
    (this as { port1: ShimMessagePort }).port1 = port1;
    (this as { port2: ShimMessagePort }).port2 = port2;
  }
} as unknown as ShimMessageChannelCtor;

/**
 * Host-bridge port: `post` ships parentPort.postMessage payloads to the parent
 * realm; call `deliver` with each inbound value. Used by the process-worker
 * host to build a thread's `parentPort`.
 */
export const createHostPort = (post: (value: unknown) => void) => {
  let deliverCb: ((v: unknown) => void) | null = null;
  const port = createShimMessagePort({
    post: (value) => post(value),
    close: () => {},
    setOnMessage: (cb) => {
      deliverCb = cb;
    },
  });
  return {
    port,
    deliver: (value: unknown) => deliverCb?.(value),
  };
};

// ── Default browser-Worker spawner ─────────────────────────────────

const CTRL = "__bolo_wt__";

/**
 * Inline worker bootstrap: waits for the tagged init message (workerData +
 * code/URL), publishes `__boloWorkerThread` for any shim instance created in
 * that realm, exposes a minimal global `parentPort`, then runs the user code.
 * Plain (untagged) messages are forwarded to `parentPort` listeners.
 */
const WORKER_BOOTSTRAP = `
const CTRL = ${JSON.stringify(CTRL)};
const pending = [];
let inbound = null;
globalThis.parentPort = {
  postMessage: (v, t) => self.postMessage(v, t && t.length ? { transfer: t } : undefined),
  on: (_e, f) => { inbound = f; for (const m of pending.splice(0)) queueMicrotask(() => f(m)); },
  once: (_e, f) => { inbound = f; for (const m of pending.splice(0)) queueMicrotask(() => f(m)); },
  close: () => self.close(),
  start: () => {},
  ref: () => globalThis.parentPort,
  unref: () => globalThis.parentPort,
};
const run = (d) => {
  globalThis.__boloWorkerThread = { workerData: d.workerData, port: globalThis.parentPort };
  const report = (err) => self.postMessage({ [CTRL]: "error", message: String((err && err.stack) || err) });
  try {
    if (d.eval) { (0, eval)(d.code); self.postMessage({ [CTRL]: "exit", code: 0 }); }
    else { import(d.url).then(() => self.postMessage({ [CTRL]: "exit", code: 0 }), report); }
  } catch (err) { report(err); }
};
self.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d[CTRL] === "init") { run(d); return; }
  if (inbound) inbound(d); else pending.push(d);
});
`;

declare global {
  // eslint-disable-next-line no-var
  var __boloWorkerThread: { workerData?: unknown; port?: unknown } | undefined;
}

const browserWorkerSpawner: WorkerThreadSpawner | undefined =
  typeof globalThis.Worker === "function" && typeof Blob === "function" && typeof URL === "function"
    ? (spec) => {
        const blob = new Blob([WORKER_BOOTSTRAP], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        let worker: InstanceType<typeof globalThis.Worker>;
        try {
          worker = new globalThis.Worker(url);
        } catch {
          URL.revokeObjectURL(url);
          return undefined;
        }
        let onMessage: ((v: unknown) => void) | null = null;
        let onError: ((e: unknown) => void) | null = null;
        let onExit: ((c: number) => void) | null = null;
        worker.onmessage = (ev: MessageEvent) => {
          const d = ev.data as Record<string, unknown> | null;
          if (d === null) return void onMessage?.(d);
          const ctrl = d[CTRL];
          if (ctrl === "exit") return void onExit?.(typeof d.code === "number" ? d.code : 0);
          if (ctrl === "error") return void onError?.(new Error(String(d.message)));
          onMessage?.(d);
        };
        worker.onerror = (ev: ErrorEvent) => {
          ev.preventDefault();
          onError?.(ev.error ?? new Error(ev.message));
        };
        worker.postMessage({
          [CTRL]: "init",
          workerData: spec.workerData,
          eval: spec.code !== undefined,
          code: spec.code,
          url: spec.filename,
        });
        return {
          postMessage: (v, transfer) =>
            worker.postMessage(v, transfer ? { transfer: [...transfer] } : undefined),
          terminate: () => {
            worker.terminate();
            URL.revokeObjectURL(url);
          },
          setOnMessage: (cb) => {
            onMessage = cb;
          },
          setOnError: (cb) => {
            onError = cb;
          },
          setOnExit: (cb) => {
            onExit = cb;
          },
        };
      }
    : undefined;

// ── Shim factory ────────────────────────────────────────────────────

let nextThreadId = 1;

export const createWorkerThreadsShim = (
  options: WorkerThreadsShimOptions = {},
): WorkerThreadsShim => {
  const autoContext =
    options.context ??
    (globalThis.__boloWorkerThread
      ? {
          workerData: globalThis.__boloWorkerThread.workerData,
          parentPort: globalThis.__boloWorkerThread.port,
        }
      : undefined);
  const isMainThread = autoContext === undefined;
  const threadId = isMainThread ? 0 : (autoContext.threadId ?? -1);

  const spawner = options.spawnWorker ?? browserWorkerSpawner;

  const liveWorkers = new Map<
    number,
    { postMessage(value: unknown, transferList?: readonly unknown[]): void }
  >();

  const envData = new Map<unknown, unknown>();

  const workerData = isMainThread ? undefined : autoContext.workerData;

  const parentPort = isMainThread
    ? null
    : autoContext.parentPort instanceof ShimMessagePort
      ? autoContext.parentPort
      : (autoContext.parentPort ?? null);

  class Worker extends EventEmitter {
    readonly threadId: number;
    readonly resourceLimits: Required<Record<string, number>>;
    private handle: WorkerThreadHandle | undefined;
    private exitCode: number | null = null;
    private refed = true;

    constructor(filename: string | URL, opts: Record<string, unknown> = {}) {
      super();
      this.threadId = nextThreadId++;
      this.resourceLimits = {
        maxYoungGenerationSizeMb: 48,
        maxOldGenerationSizeMb: 2048,
        codeRangeSizeMb: 0,
        stackSizeMb: 4,
        ...(opts.resourceLimits as Record<string, number> | undefined),
      };

      const evalMode = opts.eval === true;
      if (!evalMode && typeof filename !== "string" && !(filename instanceof URL)) {
        throw new TypeError('The "filename" argument must be of type string or URL');
      }
      const spec: WorkerThreadSpawnSpec = {
        filename: evalMode ? undefined : String(filename),
        code: evalMode ? String(filename) : undefined,
        args: Array.isArray(opts.argv) ? (opts.argv as string[]) : undefined,
        env:
          opts.env === SHARE_ENV || opts.env === undefined
            ? undefined
            : (opts.env as Record<string, string>),
        workerData: opts.workerData,
        threadId: this.threadId,
      };

      const handle = spawner?.(spec);
      this.handle = handle;
      if (!handle) {
        queueMicrotask(() => {
          this.emit(
            "error",
            unsupportedError(
              "SPAWN_WORKER",
              "worker_threads.Worker cannot spawn a thread in this realm: no spawnWorker " +
                "backend was registered and no browser Worker is available",
            ),
          );
          this.finish(1);
        });
        return;
      }
      liveWorkers.set(this.threadId, this);
      handle.setOnMessage((value) => this.emit("message", value));
      handle.setOnError((err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        this.finish(1);
      });
      handle.setOnExit((code) => this.finish(code));
      queueMicrotask(() => this.emit("online"));
    }

    private finish(code: number): void {
      if (this.exitCode !== null) return;
      this.exitCode = code;
      liveWorkers.delete(this.threadId);
      this.handle?.setOnError(null);
      this.handle?.setOnExit(null);
      // Leave onMessage attached: values already queued on the transport must
      // still deliver (Node delivers messages posted before exit). 'exit'
      // fires two microtask hops out so a value queued ahead of it delivers
      // first AND the continuation that awaits it gets a chance to attach its
      // 'exit' listener.
      queueMicrotask(() => queueMicrotask(() => this.emit("exit", code)));
    }

    postMessage(value: unknown, transferList?: readonly unknown[]): void {
      assertCloneable(value);
      const transfer = (transferList ?? []).map(unwrapTransferable);
      this.handle?.postMessage(value, transfer);
    }

    terminate(): Promise<number> {
      if (this.exitCode === null) {
        this.handle?.terminate();
        this.finish(1);
      }
      return Promise.resolve(this.exitCode ?? 1);
    }

    ref(): this {
      this.refed = true;
      return this;
    }
    unref(): this {
      this.refed = false;
      return this;
    }
    hasRef(): boolean {
      return this.refed;
    }

    getHeapSnapshot(): Promise<never> {
      return Promise.reject(
        new Error("worker.getHeapSnapshot is not supported: no V8 heap access in this realm"),
      );
    }
  }

  const receiveMessageOnPort = (port: unknown): unknown =>
    port instanceof ShimMessagePort ? port.dequeue() : undefined;

  const moveMessagePortToContext = (port: unknown, _contextifiedSandbox?: unknown): unknown => {
    // Realms here share one V8 heap (workers are separate globals bridged by
    // postMessage, not vm contexts), so the port object is already usable —
    // Node's context hop is a no-op for us.
    if (!(port instanceof ShimMessagePort)) {
      throw new TypeError('The "port" argument must be a MessagePort');
    }
    return port;
  };

  const setEnvironmentData = (key: unknown, value: unknown): void => {
    envData.set(key, value);
  };
  const getEnvironmentData = (key: unknown): unknown => envData.get(key);

  const postMessageToThread = (
    targetThreadId: number,
    value: unknown,
    transferList?: readonly unknown[],
    _timeout?: number,
  ): Promise<unknown> => {
    const target = liveWorkers.get(targetThreadId);
    if (!target) {
      const err = new Error(`No worker thread with threadId ${targetThreadId}`) as Error & {
        code: string;
      };
      err.code = "ERR_WORKER_MESSAGING_FAILED";
      return Promise.reject(err);
    }
    assertCloneable(value);
    target.postMessage(value, transferList);
    return Promise.resolve(undefined);
  };

  const NativeBroadcastChannel = (globalThis as { BroadcastChannel?: BroadcastChannelConstructor })
    .BroadcastChannel;
  const BroadcastChannelCtor: BroadcastChannelConstructor =
    NativeBroadcastChannel ??
    class BroadcastChannelShim extends EventTarget {
      constructor(_name?: string) {
        super();
      }
      postMessage(): void {}
      close(): void {}
    };

  return {
    Worker,
    isMainThread,
    parentPort,
    workerData,
    threadId,
    resourceLimits: {
      maxYoungGenerationSizeMb: 48,
      maxOldGenerationSizeMb: 2048,
      codeRangeSizeMb: 0,
      stackSizeMb: 4,
    },
    MessageChannel: ShimMessageChannel,
    MessagePort: ShimMessagePort,
    BroadcastChannel: BroadcastChannelCtor,
    SHARE_ENV,
    receiveMessageOnPort,
    moveMessagePortToContext,
    markAsUntransferable,
    markAsUncloneable,
    isMarkedAsUntransferable,
    setEnvironmentData,
    getEnvironmentData,
    postMessageToThread,
  };
};

/** Node's `worker_threads.SHARE_ENV` — env-share sentinel for `new Worker`. */
export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");

// Named top-level exports bound to this realm's default shim — the
// vite-plugin aliases `node:worker_threads` straight to this module, so
// `import { Worker } from "node:worker_threads"` must find them here. In a
// spawned browser worker the bootstrap has already set `__boloWorkerThread`,
// so the default instance reports the worker context correctly.
const defaultShim = createWorkerThreadsShim();

export const Worker = defaultShim.Worker;
export const isMainThread = defaultShim.isMainThread;
export const parentPort = defaultShim.parentPort;
export const workerData = defaultShim.workerData;
export const threadId = defaultShim.threadId;
export const resourceLimits = defaultShim.resourceLimits;
export const MessageChannel = defaultShim.MessageChannel;
export const MessagePort = defaultShim.MessagePort;
export const BroadcastChannel = defaultShim.BroadcastChannel;
export const receiveMessageOnPort = defaultShim.receiveMessageOnPort;
export const moveMessagePortToContext = defaultShim.moveMessagePortToContext;
export const setEnvironmentData = defaultShim.setEnvironmentData;
export const getEnvironmentData = defaultShim.getEnvironmentData;
export const postMessageToThread = defaultShim.postMessageToThread;
export const getHeapSnapshot = (): Promise<never> =>
  Promise.reject(new Error("getHeapSnapshot is not supported: no V8 heap access in this realm"));

export default defaultShim;
