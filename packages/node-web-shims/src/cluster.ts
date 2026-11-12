import { createEventsShim } from "./events.js";

const { EventEmitter } = createEventsShim();

/**
 * node:cluster shim — single-process primary only.
 *
 * In a browser there is no child process, so the primary/Worker model is
 * reduced to what is honest: this realm is always the primary
 * (`isPrimary === true`, `isWorker === false`). `fork()` returns an
 * in-process Worker stub that follows Node's event/state contract (fork →
 * online → exit, disconnect, send) but does NOT execute separate code —
 * there is no child realm to run it. Consequently a 'listening' event is
 * never emitted and no server address is ever reported; tests that assert
 * real forked-worker behavior (e.g. node's test-cluster-basic listening
 * checks) stay failing by design.
 */

export const SCHED_NONE = 1;
export const SCHED_RR = 2;

export const isMaster = true;
export const isPrimary = true;
export const isWorker = false;
export const worker = undefined;
export const schedulingPolicy = SCHED_RR;

export const settings: Record<string, unknown> = {};
export const workers: Record<number, Worker> = {};

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

export class Worker extends EventEmitter {
  readonly id: number;
  state: "none" | "online" | "listening" | "dead" = "none";
  exitedAfterDisconnect = false;

  #connected = true;
  #exited = false;
  #sawDisconnect = false;
  #exitCode: number | null = null;
  #signalCode: string | null = null;

  constructor(id: number) {
    super();
    this.id = id;
  }

  /**
   * Minimal stand-in for the ChildProcess of a real cluster worker. Only the
   * exit fields the 'exit' event contract needs are exposed.
   */
  get process(): { exitCode: number | null; signalCode: string | null } {
    return { exitCode: this.#exitCode, signalCode: this.#signalCode };
  }

  isConnected(): boolean {
    return this.#connected;
  }

  isDead(): boolean {
    return this.#exited;
  }

  /**
   * Mirrors the primary→worker `send` signature: `send(message[,
   * sendHandle[, options]][, callback])`. The callback form is supported;
   * the callback fires asynchronously with `null` (no error). A malformed
   * `NODE_CLUSTER` control message (negative ack) makes the worker exit with
   * code 0, matching node's test-cluster-invalid-message.
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
    queueMicrotask(() => {
      cb?.(null);
      if (isInvalidControlMessage(message)) {
        this.#exit(0, null);
      }
    });
    return true;
  }

  kill(signal?: string): void {
    this.#exit(this.#exitCode ?? 0, signal ?? null);
  }

  destroy(signal?: string): void {
    this.#exit(this.#exitCode ?? 0, signal ?? null);
  }

  disconnect(): this {
    if (!this.#connected) return this;
    this.#connected = false;
    this.#sawDisconnect = true;
    cluster.emit("disconnect", this);
    this.emit("disconnect");
    return this;
  }

  #exit(code: number, signal: string | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#connected = false;
    this.#exitCode = code;
    this.#signalCode = signal;
    this.exitedAfterDisconnect = this.#sawDisconnect;
    this.state = "dead";
    delete workers[this.id];
    cluster.emit("exit", this, code, signal);
    this.emit("exit", code, signal);
  }
}

let nextWorkerId = 1;

class Cluster extends EventEmitter {
  Worker = Worker;
  isMaster = isMaster;
  isPrimary = isPrimary;
  isWorker = isWorker;
  worker = worker;
  schedulingPolicy = schedulingPolicy;
  SCHED_NONE = SCHED_NONE;
  SCHED_RR = SCHED_RR;
  settings = settings;
  workers = workers;

  setupPrimary(newSettings?: Record<string, unknown>): void {
    Object.assign(settings, newSettings);
  }

  setupMaster(newSettings?: Record<string, unknown>): void {
    Object.assign(settings, newSettings);
  }

  fork(_env?: Record<string, string>): Worker {
    const newWorker = new Worker(nextWorkerId++);
    workers[newWorker.id] = newWorker;
    // Asynchronous, like a real fork: 'fork' then 'online' on the cluster,
    // 'online' on the worker, state transitions none → online.
    queueMicrotask(() => {
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

export const fork = (env?: Record<string, string>): Worker => cluster.fork(env);
export const disconnect = (callback?: () => void): void => cluster.disconnect(callback);
export const setupPrimary = (newSettings?: Record<string, unknown>): void =>
  cluster.setupPrimary(newSettings);
export const setupMaster = (newSettings?: Record<string, unknown>): void =>
  cluster.setupMaster(newSettings);

export const createClusterShim = (): Cluster => cluster;

export default cluster;
