import { createEventsShim } from "./events.js";
import type { WorkerThreadInstance } from "./worker_threads.js";

const { EventEmitter } = createEventsShim();

/**
 * node:cluster shim — cluster workers mapped onto the worker_threads
 * worker-per-process backend.
 *
 * `cluster.fork()` spawns a real `worker_threads.Worker` on the realm's own
 * entry script (`process.argv[1]`), stamping `workerData.__boloClusterWorkerId`
 * so the spawned realm's cluster shim comes up in worker mode (`isWorker`,
 * `cluster.worker`). IPC rides the same channel `process.send` uses — the
 * `{type:'IPC_MESSAGE'|'IPC_DISCONNECT'}` envelopes the process worker
 * already understands — plus a `{type:'__bolo_cluster_msg', act:'listening'}`
 * report posted when a server inside the worker emits 'listening' (installed
 * by patching `net.Server`/`http.Server` `listen`, the seam Node's real
 * cluster uses via `cluster._getServer`).
 *
 * Realm state is detected lazily: the shim object is materialized by
 * `createLiveShimRegistry` before `globalThis.__browserContainers` exists,
 * so `isWorker`/`worker`/`isPrimary` are own enumerable getters evaluated
 * when the bundled `node:cluster` module binds the live shim. Outside a
 * container (unit tests, standalone realms) `fork()` degrades to the
 * previous single-process contract: the event/state sequence still fires
 * but no separate realm runs.
 */

declare global {
  // Set by the container host before a bundled app evaluates; the bundle's
  // `node:cluster` virtual module reads this realm's shim off it.
  // eslint-disable-next-line no-var
  var __browserContainers:
    | { shims?: Record<string, unknown> }
    | undefined;
}

export const SCHED_NONE = 1;
export const SCHED_RR = 2;
export const schedulingPolicy = SCHED_RR;

export const settings: Record<string, unknown> = {};
export const workers: Record<number, Worker> = {};

// workerData key the primary stamps on a cluster-forked realm.
const CLUSTER_MARK = "__boloClusterWorkerId";
// Internal control envelope: worker→primary "a server is listening".
const CLUSTER_MSG = "__bolo_cluster_msg";
// Marker on a patched Server.prototype so http+https (same object) patch once.
const PATCHED = Symbol("bolo.cluster.listenPatched");

interface ParentPortLike {
  postMessage(value: unknown): void;
  on?(event: string, listener: (value: unknown) => void): unknown;
}

interface WorkerThreadsLike {
  readonly isMainThread?: boolean;
  readonly workerData?: unknown;
  readonly parentPort?: ParentPortLike | null;
  readonly Worker?: new (
    filename: string,
    opts?: Record<string, unknown>,
  ) => WorkerThreadInstance;
}

interface ProcessLike {
  readonly argv?: string[];
  readonly env?: Record<string, string>;
  exit?(code?: number): never;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  emit?(event: string, ...args: unknown[]): boolean;
}

const shims = (): Record<string, unknown> | undefined =>
  (globalThis as { __browserContainers?: { shims?: Record<string, unknown> } })
    .__browserContainers?.shims;

const workerThreads = (): WorkerThreadsLike | undefined =>
  shims()?.worker_threads as WorkerThreadsLike | undefined;

const proc = (): ProcessLike | undefined => shims()?.process as ProcessLike | undefined;

interface ClusterControlMessage {
  cmd?: string;
  ack?: number;
}

const isInvalidControlMessage = (message: unknown): boolean => {
  const msg = message as ClusterControlMessage | null;
  return (
    typeof msg === "object" &&
    msg !== null &&
    msg.cmd === "NODE_CLUSTER" &&
    typeof msg.ack === "number" &&
    msg.ack < 0
  );
};

/** Cluster-worker id the primary stamped on this realm's workerData. */
const spawnedWorkerId = (): number | undefined => {
  const wt = workerThreads();
  if (!wt || wt.isMainThread !== false) return undefined;
  const data = wt.workerData as Record<string, unknown> | null;
  const id = data?.[CLUSTER_MARK];
  return typeof id === "number" ? id : undefined;
};

/**
 * The address object a real cluster primary hands to 'listening' — exactly
 * `{addressType, address, port, fd}` (`fd` present but undefined, per Node's
 * internal message shape; test-cluster-basic asserts the four-key form).
 */
const clusterAddressOf = (address: unknown): Record<string, unknown> => {
  if (address && typeof address === "object") {
    const a = address as { address?: string; port?: number; family?: string };
    const addressType = a.family === "IPv6" ? 6 : a.family === "IPv4" ? 4 : -1;
    return { addressType, address: a.address, port: a.port, fd: undefined };
  }
  return {
    addressType: -1,
    address: typeof address === "string" ? address : undefined,
    port: undefined,
    fd: undefined,
  };
};

/**
 * Patches a `Server.prototype.listen` (net or http shim) so a realm in
 * cluster-worker mode reports each 'listening' event to the primary — the
 * `cluster._getServer` seam from Node's own net.Server.listen.
 */
const patchServerForCluster = (mod: unknown, report: (address: unknown) => void): void => {
  const proto = (mod as { Server?: { prototype?: Record<string | symbol, unknown> } })?.Server
    ?.prototype;
  if (!proto || typeof proto.listen !== "function" || proto[PATCHED]) return;
  const orig = proto.listen as (this: unknown, ...args: unknown[]) => unknown;
  proto[PATCHED] = true;
  proto.listen = function (this: unknown, ...args: unknown[]) {
    const ret = orig.apply(this, args);
    const self = this as {
      once?: (e: string, f: () => void) => unknown;
      address?: () => unknown;
    };
    if (typeof self.once === "function") {
      self.once("listening", () => report(self.address?.()));
    }
    return ret;
  };
};

export class Worker extends EventEmitter {
  readonly id: number;
  state: "none" | "online" | "listening" | "dead" = "none";
  exitedAfterDisconnect = false;

  /** Primary → spawned realm (worker_threads transport). */
  #thread?: WorkerThreadInstance;
  /** Worker realm → parent (the realm's own parentPort). */
  #port?: ParentPortLike | null;
  /** Worker realm's own process (for 'message'/'disconnect'/exit). */
  #proc?: ProcessLike;

  #connected = true;
  #exited = false;
  #sawDisconnect = false;
  #exitCode: number | null = null;
  #signalCode: string | null = null;
  #killSignal: string | null = null;

  constructor(id: number) {
    super();
    this.id = id;
  }

  /**
   * Minimal stand-in for the ChildProcess of a real cluster worker: the exit
   * fields the 'exit' event contract needs, plus `kill`.
   */
  get process(): {
    exitCode: number | null;
    signalCode: string | null;
    connected: boolean;
    kill: (signal?: string) => void;
  } {
    const self = this;
    return {
      get exitCode() {
        return self.#exitCode;
      },
      get signalCode() {
        return self.#signalCode;
      },
      get connected() {
        return self.#connected;
      },
      kill: (signal?: string) => self.kill(signal),
    };
  }

  isConnected(): boolean {
    return this.#connected;
  }

  isDead(): boolean {
    return this.#exited;
  }

  /**
   * Primary side: bind the spawned realm's worker_threads handle. 'fork' is
   * emitted by the caller; 'online' arrives on the thread's own spawn tick,
   * preserving the fork → online → listening → exit event order.
   */
  attachThread(thread: WorkerThreadInstance | undefined): void {
    if (!thread) {
      this.#connected = false;
      return;
    }
    this.#thread = thread;
    thread.on("online", () => {
      if (this.#exited) return;
      this.state = "online";
      cluster.emit("online", this);
      this.emit("online");
    });
    thread.on("message", (value: unknown) => this.#inbound(value));
    thread.on("exit", (code: number) => {
      // A killed worker reports (null, signal) like a signalled process.
      this.#exit(this.#killSignal !== null ? null : code, this.#killSignal);
    });
    thread.on("error", (err: unknown) => {
      // An unhandled 'error' emit would crash the realm; only surface it to
      // listeners (Node surfaces it the same way).
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
  }

  /** Worker-realm side: bind this realm's own parentPort + process surface. */
  attachSelf(port: ParentPortLike | null | undefined, procLike: ProcessLike | undefined): void {
    this.#port = port;
    this.#proc = procLike;
    this.state = "online";
    // process.send messages (primary worker.send → IPC_MESSAGE envelope) and
    // the malformed-control-message contract a real worker honours.
    procLike?.on?.("message", (message: unknown) => {
      if (isInvalidControlMessage(message)) {
        procLike.exit?.(0);
        return;
      }
      this.emit("message", message);
    });
    // Primary-initiated disconnect: the channel is already closing — mark
    // self disconnected without echoing another IPC_DISCONNECT upstream.
    procLike?.on?.("disconnect", () => {
      if (!this.#connected) return;
      this.#connected = false;
      this.#sawDisconnect = true;
      this.emit("disconnect");
      cluster.emit("disconnect", this);
    });
    port?.on?.("message", (value: unknown) => this.emit("message", value));
  }

  /** Inbound value on the primary's thread channel. */
  #inbound(value: unknown): void {
    const msg = value as {
      type?: string;
      act?: string;
      address?: unknown;
      data?: unknown;
    } | null;
    if (msg !== null && typeof msg === "object") {
      if (msg.type === CLUSTER_MSG && msg.act === "listening") {
        this.state = "listening";
        this.emit("listening", msg.address);
        cluster.emit("listening", this, msg.address);
        return;
      }
      if (msg.type === "IPC_DISCONNECT") {
        this.#markDisconnected();
        return;
      }
      if (msg.type === "IPC_MESSAGE") {
        this.emit("message", msg.data);
        return;
      }
    }
    this.emit("message", value);
  }

  #markDisconnected(): void {
    if (!this.#connected || this.#exited) return;
    this.#connected = false;
    this.#sawDisconnect = true;
    this.emit("disconnect");
    cluster.emit("disconnect", this);
  }

  /**
   * `send(message[, sendHandle[, options]][, callback])` — primary→worker
   * user messages ride the `IPC_MESSAGE` envelope the spawned realm routes
   * to `process.emit('message')`; worker→primary posts the same envelope
   * over parentPort. The callback fires asynchronously with null.
   */
  send(
    message: unknown,
    sendHandle?: unknown,
    options?: unknown,
    callback?: (error: Error | null) => void,
  ): boolean {
    const cb =
      typeof sendHandle === "function"
        ? (sendHandle as (error: Error | null) => void)
        : typeof options === "function"
          ? (options as (error: Error | null) => void)
          : callback;
    if (this.#port) {
      try {
        this.#port.postMessage({ type: "IPC_MESSAGE", data: message });
      } catch {
        /* channel already gone */
      }
      queueMicrotask(() => cb?.(null));
      return true;
    }
    if (this.#thread) {
      this.#thread.postMessage({ type: "IPC_MESSAGE", data: message });
      queueMicrotask(() => cb?.(null));
      return true;
    }
    // Single-process fallback: a malformed NODE_CLUSTER control message
    // makes the worker exit with code 0 (test-cluster-invalid-message).
    queueMicrotask(() => {
      cb?.(null);
      if (isInvalidControlMessage(message)) this.#exit(0, null);
    });
    return true;
  }

  /**
   * In the worker realm: posts `IPC_DISCONNECT` up to the primary (Node's
   * channel-close) and marks self disconnected. On the primary: asks the
   * worker to close its IPC end; the 'disconnect' event follows on the next
   * microtask, like a real channel close.
   */
  disconnect(): this {
    if (!this.#connected) return this;
    if (this.#port) {
      this.#connected = false;
      this.#sawDisconnect = true;
      try {
        this.#port.postMessage({ type: "IPC_DISCONNECT" });
      } catch {
        /* channel already gone */
      }
      this.emit("disconnect");
      cluster.emit("disconnect", this);
      return this;
    }
    this.#thread?.postMessage({ type: "IPC_DISCONNECT" });
    queueMicrotask(() => this.#markDisconnected());
    return this;
  }

  kill(signal?: string): void {
    if (this.#thread) {
      this.#killSignal = typeof signal === "string" ? signal : "SIGTERM";
      void this.#thread.terminate();
      return;
    }
    if (this.#port) {
      this.#proc?.exit?.(0);
      return;
    }
    this.#exit(this.#exitCode ?? 0, signal ?? null);
  }

  destroy(signal?: string): void {
    this.kill(signal);
  }

  #exit(code: number | null, signal: string | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#connected = false;
    this.#exitCode = code;
    this.#signalCode = signal;
    this.exitedAfterDisconnect = this.#sawDisconnect;
    this.state = "dead";
    delete workers[this.id];
    this.emit("exit", code, signal);
    cluster.emit("exit", this, code, signal);
  }
}

let nextWorkerId = 1;

class Cluster extends EventEmitter {
  Worker = Worker;
  schedulingPolicy = schedulingPolicy;
  SCHED_NONE = SCHED_NONE;
  SCHED_RR = SCHED_RR;
  settings = settings;
  workers = workers;

  /**
   * 'unknown' until the container surface is readable: the shim instance is
   * built before `__browserContainers` exists, so detection runs on first
   * access (the bundled `node:cluster` module evaluates these getters) and
   * only ever locks in once detection is possible.
   */
  #realm: "unknown" | "primary" | "worker" = "unknown";
  #workerSelf?: Worker;

  constructor() {
    super();
    // Own enumerable getters so the bundler's Object.keys shim materializes
    // them — and so the values reflect the realm the bundle actually runs in.
    const clusterObj = this;
    Object.defineProperty(this, "isWorker", {
      enumerable: true,
      get: () => {
        clusterObj.#detect();
        return clusterObj.#realm === "worker";
      },
    });
    Object.defineProperty(this, "isPrimary", {
      enumerable: true,
      get: () => {
        clusterObj.#detect();
        return clusterObj.#realm !== "worker";
      },
    });
    Object.defineProperty(this, "isMaster", {
      enumerable: true,
      get: () => {
        clusterObj.#detect();
        return clusterObj.#realm !== "worker";
      },
    });
    Object.defineProperty(this, "worker", {
      enumerable: true,
      get: () => {
        clusterObj.#detect();
        return clusterObj.#workerSelf;
      },
    });
  }

  #detect(): void {
    if (this.#realm !== "unknown") return;
    const id = spawnedWorkerId();
    if (id === undefined) {
      // Only settle on 'primary' once the container surface exists — without
      // it the workerData marker cannot be ruled out yet.
      if (shims() !== undefined) this.#realm = "primary";
      return;
    }
    this.#realm = "worker";
    this.#workerSelf = new Worker(id);
    this.#workerSelf.attachSelf(workerThreads()?.parentPort, proc());
    const report = (address: unknown) =>
      workerThreads()?.parentPort?.postMessage({
        type: CLUSTER_MSG,
        act: "listening",
        address: clusterAddressOf(address),
      });
    const s = shims();
    patchServerForCluster(s?.http, report);
    patchServerForCluster(s?.https, report);
    patchServerForCluster(s?.net, report);
  }

  setupPrimary(newSettings?: Record<string, unknown>): void {
    Object.assign(settings, newSettings);
  }

  setupMaster(newSettings?: Record<string, unknown>): void {
    Object.assign(settings, newSettings);
  }

  fork(env?: Record<string, string>): Worker {
    this.#detect();
    const newWorker = new Worker(nextWorkerId++);
    workers[newWorker.id] = newWorker;

    const wt = workerThreads();
    const entry = proc()?.argv?.[1];
    if (wt?.Worker && typeof entry === "string" && entry.length > 0) {
      // Real path: spawn a process worker on this realm's own entry script,
      // stamped as a cluster worker via workerData.
      let thread: WorkerThreadInstance | undefined;
      try {
        const inheritedEnv = proc()?.env ? { ...proc()!.env } : undefined;
        thread = new wt.Worker(entry, {
          workerData: { [CLUSTER_MARK]: newWorker.id },
          argv: proc()?.argv?.slice(2),
          env: env ? { ...inheritedEnv, ...env } : inheritedEnv,
        });
      } catch {
        thread = undefined;
      }
      newWorker.attachThread(thread);
      // 'fork' is synchronous — it must precede the spawned thread's queued
      // 'online' and see state 'none' (Node emits it inside fork()).
      this.emit("fork", newWorker);
      return newWorker;
    }

    // Single-process fallback (no container worker backend): the previous
    // contract — 'fork' then 'online' on the next microtask, state
    // transitions, but no separate realm executes.
    queueMicrotask(() => {
      if (newWorker.isDead()) return;
      this.emit("fork", newWorker);
      newWorker.state = "online";
      this.emit("online", newWorker);
      newWorker.emit("online");
    });
    return newWorker;
  }

  disconnect(callback?: () => void): void {
    for (const id of Object.keys(workers)) {
      workers[Number(id)]?.disconnect();
    }
    queueMicrotask(() => callback?.());
  }
}

const cluster = new Cluster();

// Named exports bound at module-eval — realm detection is lazy and lives on
// the cluster object's getters, so these reflect the non-container default
// (primary) for direct consumers of this module.
export const isMaster = true;
export const isPrimary = true;
export const isWorker = false;
export const worker = undefined;

export const fork = (env?: Record<string, string>): Worker => cluster.fork(env);
export const disconnect = (callback?: () => void): void => cluster.disconnect(callback);
export const setupPrimary = (newSettings?: Record<string, unknown>): void =>
  cluster.setupPrimary(newSettings);
export const setupMaster = (newSettings?: Record<string, unknown>): void =>
  cluster.setupMaster(newSettings);

export const createClusterShim = (): Cluster => cluster;

export default cluster;
