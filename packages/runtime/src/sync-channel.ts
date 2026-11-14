import type { SWSandbox } from "@bolojs/sandbox";
import { getLogger } from "@bolojs/log/browser";

const logger = getLogger(["bolo", "runtime", "sync-channel"]);

/**
 * Synchronous request/response channel between a process worker and the main
 * thread. The worker side blocks (`Atomics.wait` or sync XHR); the main side
 * is always async.
 *
 * Transports:
 * - SAB fast path (`crossOriginIsolated`): the request is delivered by
 *   postMessage, the response is written into a SharedArrayBuffer and the
 *   worker is woken with `Atomics.notify`. If the response does not fit the
 *   buffer the worker transparently retries over XHR.
 * - Sync XHR fallback (no SAB): the worker issues a synchronous POST to
 *   `<swScope>__bolo_sync/<pid>`; the ServiceWorker relays it to the main
 *   thread and the response unblocks the worker. Works everywhere but has
 *   worse tail latency in Firefox/WebKit (R0 spike b) — callers should batch.
 *
 * Wire format is opaque bytes both ways. The response envelope is
 * `0x01 || result` on success and `0x00 || utf8(message)` on error; the RPC
 * layer above (RemoteVfsBus et al.) frames its own payloads.
 */

// ── Envelope ──────────────────────────────────────────────────────────

const STATUS_OK = 1;
const STATUS_ERR = 0;

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export const encodeResult = (payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(payload.length + 1);
  out[0] = STATUS_OK;
  out.set(payload, 1);
  return out;
};

export const encodeError = (message: string): Uint8Array => {
  const body = utf8.encode(message);
  const out = new Uint8Array(body.length + 1);
  out[0] = STATUS_ERR;
  out.set(body, 1);
  return out;
};

export class SyncCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncCallError";
  }
}

export const decodeResponse = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length === 0) throw new SyncCallError("empty sync-channel response");
  if (bytes[0] === STATUS_ERR) throw new SyncCallError(utf8d.decode(bytes.subarray(1)));
  return bytes.subarray(1);
};

// ── SAB layout ────────────────────────────────────────────────────────
// Int32 slots: [0] ready-seq, [1] response status, [2] response byte length.
// Data region starts at byte 64.

const IDX_STATE = 0;
const IDX_STATUS = 1;
const IDX_LEN = 2;
const HEADER_BYTES = 64;

const SAB_READY = 1;
const SAB_TOO_BIG = 2;

export const DEFAULT_SAB_BYTES = 8 * 1024 * 1024;

export const createSyncBuffer = (bytes = DEFAULT_SAB_BYTES): SharedArrayBuffer =>
  new SharedArrayBuffer(HEADER_BYTES + bytes);

// ── Worker side ───────────────────────────────────────────────────────

export interface SyncCaller {
  /** Blocking call: sends `payload`, returns the result bytes. Throws
   * SyncCallError on a remote error or transport failure. */
  call(payload: Uint8Array): Uint8Array;
}

interface SabCallerOptions {
  sab: SharedArrayBuffer;
  /** Delivers `{ seq, payload }` to the main thread (worker postMessage). */
  postRequest: (seq: number, payload: Uint8Array) => void;
  /** Max ms to block waiting for a response. Default {@link DEFAULT_SYNC_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Default ceiling for one synchronous cross-realm call.
 *
 * A sync call can legitimately take minutes: `child_process.spawnSync` of a
 * node script runs on the main thread and re-bundles the child each time, so
 * a script that spawns a dozen children serially spends tens of seconds
 * parked in a single call. The old 30s ceiling killed those callers with a
 * bare SyncCallError (no stderr), which reads exactly like a hang.
 */
const DEFAULT_SYNC_TIMEOUT_MS = 10 * 60_000;

const createSabCaller = (opts: SabCallerOptions): SyncCaller & { seq: number } => {
  const i32 = new Int32Array(opts.sab);
  const u8 = new Uint8Array(opts.sab);
  const timeout = opts.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const state = {
    seq: 0,
    call(payload: Uint8Array): Uint8Array {
      const seq = ++state.seq;
      Atomics.store(i32, IDX_STATE, 0);
      opts.postRequest(seq, payload);
      // Re-check after posting: the main thread may have answered between the
      // store and the post.
      while (Atomics.load(i32, IDX_STATE) === 0) {
        const result = Atomics.wait(i32, IDX_STATE, 0, timeout);
        if (result === "timed-out") {
          throw new SyncCallError(`sync-channel request ${seq} timed out after ${timeout}ms`);
        }
      }
      const status = Atomics.load(i32, IDX_STATUS);
      const len = Atomics.load(i32, IDX_LEN);
      if (status === SAB_TOO_BIG) {
        throw new ResponseTooBigError(len);
      }
      return u8.slice(HEADER_BYTES, HEADER_BYTES + len);
    },
  };
  return state;
};

class ResponseTooBigError extends Error {
  readonly responseLength: number;
  constructor(responseLength: number) {
    super("response exceeds sync buffer");
    this.name = "ResponseTooBigError";
    this.responseLength = responseLength;
  }
}

const createXhrCaller = (url: string): SyncCaller => ({
  call(payload: Uint8Array): Uint8Array {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, false);
    xhr.responseType = "arraybuffer";
    xhr.send(payload.slice().buffer);
    if (xhr.status !== 200) {
      throw new SyncCallError(`sync-channel XHR failed: HTTP ${xhr.status}`);
    }
    return new Uint8Array(xhr.response as ArrayBuffer);
  },
});

export interface WorkerSyncOptions {
  pid: string;
  /** Absolute URL path for the XHR endpoint, e.g. `/__bolo_sync/<pid>` or
   * `/demo/__bolo_sync/<pid>` under a sub-path SW scope. */
  xhrUrl: string;
  sab?: SharedArrayBuffer;
  postMessage?: (msg: unknown, transfer?: Transferable[]) => void;
  timeoutMs?: number;
}

/** Worker-side entry point. Prefers SAB; falls back to sync XHR when SAB is
 * absent or a response exceeds the buffer. */
export const createSyncCaller = (opts: WorkerSyncOptions): SyncCaller => {
  const xhr = createXhrCaller(opts.xhrUrl);
  if (!opts.sab || !opts.postMessage) return xhr;

  const sab = createSabCaller({
    sab: opts.sab,
    timeoutMs: opts.timeoutMs,
    postRequest: (seq, payload) =>
      opts.postMessage!({ type: "BOLO_SYNC_REQ", pid: opts.pid, seq, payload }, [
        payload.buffer as ArrayBuffer,
      ]),
  });

  return {
    call(payload: Uint8Array): Uint8Array {
      try {
        return sab.call(payload);
      } catch (err) {
        if (err instanceof ResponseTooBigError) return xhr.call(payload);
        throw err;
      }
    },
  };
};

// ── Main side ─────────────────────────────────────────────────────────

export type SyncRequestHandler = (payload: Uint8Array) => Promise<Uint8Array> | Uint8Array;

interface SyncProcess {
  handler: SyncRequestHandler;
  sab?: SharedArrayBuffer;
  /** Called when a request arrives — proof the worker is alive and parked. */
  onActivity?: () => void;
}

export interface SyncServer {
  /** Register a process's handler. Call before the worker issues requests. */
  attach(
    pid: string,
    handler: SyncRequestHandler,
    opts?: { sab?: SharedArrayBuffer; onActivity?: () => void },
  ): void;
  detach(pid: string): void;
  /** Route a `BOLO_SYNC_REQ` message from a process worker. Returns true if
   * the message was consumed (for use inside the worker's onmessage switch). */
  handleWorkerMessage(pid: string, data: unknown): boolean;
}

const SYNC_URL_RE = /\/__bolo_sync\/([^/?#]+)/;

/**
 * Main-side sync server: dispatches per-pid handlers for both the SAB path
 * (worker `BOLO_SYNC_REQ` postMessages) and the XHR path (SW `SYNC_REQUEST`s
 * arriving through the SWSandbox port).
 */
export const createSyncServer = (deps: { sandbox?: SWSandbox }): SyncServer => {
  const processes = new Map<string, SyncProcess>();

  const respond = (proc: SyncProcess, seq: number, raw: Uint8Array) => {
    const { sab } = proc;
    if (!sab) return;
    const i32 = new Int32Array(sab);
    const capacity = sab.byteLength - HEADER_BYTES;
    if (raw.length > capacity) {
      Atomics.store(i32, IDX_STATUS, SAB_TOO_BIG);
      Atomics.store(i32, IDX_LEN, raw.length);
    } else {
      new Uint8Array(sab, HEADER_BYTES, raw.length).set(raw);
      Atomics.store(i32, IDX_LEN, raw.length);
      Atomics.store(i32, IDX_STATUS, SAB_READY);
    }
    Atomics.store(i32, IDX_STATE, seq);
    Atomics.notify(i32, IDX_STATE);
  };

  const dispatch = async (proc: SyncProcess, payload: Uint8Array): Promise<Uint8Array> => {
    try {
      return encodeResult(await proc.handler(payload));
    } catch (err) {
      return encodeError(err instanceof Error ? err.message : String(err));
    }
  };

  const server: SyncServer = {
    attach(pid, handler, opts) {
      processes.set(pid, { handler, sab: opts?.sab, onActivity: opts?.onActivity });
    },
    detach(pid) {
      processes.delete(pid);
    },
    handleWorkerMessage(pid, data) {
      const msg = data as { type?: string; pid?: string; seq?: number; payload?: Uint8Array };
      if (msg?.type !== "BOLO_SYNC_REQ" || msg.pid !== pid || typeof msg.seq !== "number") {
        return false;
      }
      const proc = processes.get(pid);
      if (!proc?.sab || !(msg.payload instanceof Uint8Array)) {
        if (!proc) logger.warn("sync request for unknown pid", { pid });
        return true;
      }
      proc.onActivity?.();
      const payload = msg.payload;
      void dispatch(proc, payload).then((raw) => respond(proc, msg.seq!, raw));
      return true;
    },
  };

  if (typeof deps.sandbox?.onSyncRequest === "function") {
    deps.sandbox.onSyncRequest(async (req) => {
      const pid = new URL(req.url).pathname.match(SYNC_URL_RE)?.[1];
      const proc = pid ? processes.get(pid) : undefined;
      if (!pid || !proc) return undefined;
      proc.onActivity?.();
      const payload = req.body ? new Uint8Array(req.body) : new Uint8Array(0);
      const raw = await dispatch(proc, payload);
      return { status: 200, body: raw.slice().buffer };
    });
  }

  return server;
};
