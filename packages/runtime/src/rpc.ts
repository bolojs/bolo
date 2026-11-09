/**
 * Bidirectional asynchronous RPC between the main thread and a process
 * worker over postMessage, plus the value marshalling shared with the
 * synchronous channel.
 *
 * Wire messages (all carry `kind` so a mux can route them):
 * - `rpc-req`  { id, op, args }      invoke a served op
 * - `rpc-res`  { id, ok, result|error }
 * - `rpc-cb`   { id, cbId, args }    invoke a remote-exported callback
 * - `rpc-cb-res` { id, ok, error? }  callback return value
 *
 * Marshalling: functions become `{ $cb: cbId }`, Uint8Array becomes
 * `{ $u8: base64 }`, Date becomes `{ $date: iso }`. Errors marshal as
 * `{ message, name, code? }`.
 */

export type RpcSend = (msg: unknown, transfer?: Transferable[]) => void;

const CB_KEY = "$cb";
const U8_KEY = "$u8";
const DATE_KEY = "$date";

const b64encode = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

const b64decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && (v as object).constructor === Object;

export interface Marshaller {
  marshal(v: unknown): unknown;
  unmarshal(v: unknown): unknown;
}

/**
 * Value marshaller shared by the async RPC and the sync channel.
 * `registerCb` turns a function into a `{ $cb: id }` placeholder;
 * `makeRemoteCb` turns a placeholder back into a callable. Transports that
 * cannot carry callbacks (sync channel) pass throwing versions.
 */
export const createMarshaller = (opts: {
  registerCb: (fn: (...args: unknown[]) => unknown) => number;
  makeRemoteCb: (cbId: number) => (...args: unknown[]) => unknown;
}): Marshaller => {
  const marshal = (v: unknown): unknown => {
    if (typeof v === "function") return { [CB_KEY]: opts.registerCb(v as never) };
    if (v instanceof Uint8Array) return { [U8_KEY]: b64encode(v) };
    if (v instanceof Date) return { [DATE_KEY]: v.toISOString() };
    if (Array.isArray(v)) return v.map(marshal);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = marshal(val);
      return out;
    }
    return v;
  };

  const unmarshal = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(unmarshal);
    if (isPlainObject(v)) {
      if (CB_KEY in v && typeof v[CB_KEY] === "number") return opts.makeRemoteCb(v[CB_KEY]);
      if (U8_KEY in v && typeof v[U8_KEY] === "string") return b64decode(v[U8_KEY]);
      if (DATE_KEY in v && typeof v[DATE_KEY] === "string") return new Date(v[DATE_KEY]);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = unmarshal(val);
      return out;
    }
    return v;
  };

  return { marshal, unmarshal };
};

const noSyncCallbacks = {
  registerCb: () => {
    throw new Error("callbacks cannot cross the synchronous channel");
  },
  makeRemoteCb: () => () => {
    throw new Error("callback arrived over the synchronous channel");
  },
};

/** Marshaller for the sync channel: bytes/dates work, functions throw. */
export const syncMarshaller: Marshaller = createMarshaller(noSyncCallbacks);

export const marshalError = (err: unknown): unknown =>
  err instanceof Error
    ? {
        message: err.message,
        name: err.name,
        ...((err as Error & { code?: unknown }).code !== undefined
          ? { code: (err as Error & { code?: unknown }).code }
          : {}),
      }
    : { message: String(err), name: "Error" };

export const unmarshalError = (raw: unknown): Error => {
  if (isPlainObject(raw)) {
    const err = new Error(String(raw.message ?? "remote error"));
    err.name = String(raw.name ?? "Error");
    if (raw.code !== undefined) (err as Error & { code: unknown }).code = raw.code;
    return err;
  }
  return new Error(String(raw));
};

export interface RpcPeer {
  /** Feed a received postMessage payload. Returns true if consumed. */
  handle(data: unknown): boolean;
  /** Call a remote op. Functions in args become remote callbacks. */
  call<T = unknown>(op: string, ...args: unknown[]): Promise<T>;
  /** Serve an op name. Returning a promise is allowed. */
  serve(op: string, handler: (...args: unknown[]) => unknown): void;
  /** Fallback handler for ops with no named `serve` registration. */
  serveAny: ((op: string, args: unknown[]) => unknown) | undefined;
  /** Drop all pending calls (e.g. worker died). */
  reset(reason: Error): void;
}

export const createRpcPeer = (send: RpcSend): RpcPeer => {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const cbPending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const callbacks = new Map<number, (...args: unknown[]) => unknown>();
  let nextCbId = 1;

  const callRemoteCallback = async (cbId: number, args: unknown[]): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      cbPending.set(id, { resolve, reject });
      send({ kind: "rpc-cb", id, cbId, args: marshal(args) });
    });
  };

  const { marshal, unmarshal } = createMarshaller({
    registerCb: (fn) => {
      const cbId = nextCbId++;
      callbacks.set(cbId, fn);
      return cbId;
    },
    makeRemoteCb:
      (cbId) =>
      (...args: unknown[]) =>
        callRemoteCallback(cbId, args),
  });

  const peer: RpcPeer = {
    serveAny: undefined,

    call<T>(op: string, ...args: unknown[]): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        send({ kind: "rpc-req", id, op, args: marshal(args) });
      });
    },

    serve(op, handler) {
      handlers.set(op, handler);
    },

    reset(reason: Error) {
      for (const p of pending.values()) p.reject(reason);
      pending.clear();
      for (const p of cbPending.values()) p.reject(reason);
      cbPending.clear();
      callbacks.clear();
    },

    handle(data: unknown): boolean {
      const msg = data as {
        kind?: string;
        id?: number;
        op?: string;
        args?: unknown[];
        cbId?: number;
        ok?: boolean;
        result?: unknown;
        error?: unknown;
      };
      if (!msg || typeof msg.kind !== "string" || !msg.kind.startsWith("rpc-")) return false;
      switch (msg.kind) {
        case "rpc-req": {
          const named = msg.op !== undefined ? handlers.get(msg.op) : undefined;
          const id = msg.id!;
          const args = (msg.args ?? []).map(unmarshal);
          const invoke = named
            ? () => named(...args)
            : peer.serveAny
              ? () => peer.serveAny!(msg.op!, args)
              : undefined;
          if (!invoke) {
            send({ kind: "rpc-res", id, ok: false, error: { message: `unknown op ${msg.op}` } });
            return true;
          }
          void Promise.resolve()
            .then(invoke)
            .then(
              (result) => send({ kind: "rpc-res", id, ok: true, result: marshal(result) }),
              (err) => send({ kind: "rpc-res", id, ok: false, error: marshalError(err) }),
            );
          return true;
        }
        case "rpc-res": {
          const p = pending.get(msg.id!);
          if (!p) return true;
          pending.delete(msg.id!);
          if (msg.ok) p.resolve(unmarshal(msg.result));
          else p.reject(unmarshalError(msg.error));
          return true;
        }
        case "rpc-cb": {
          const cb = msg.cbId !== undefined ? callbacks.get(msg.cbId) : undefined;
          const id = msg.id!;
          if (!cb) {
            send({
              kind: "rpc-cb-res",
              id,
              ok: false,
              error: { message: `unknown callback ${msg.cbId}` },
            });
            return true;
          }
          const args = (msg.args ?? []).map(unmarshal);
          void Promise.resolve()
            .then(() => cb(...args))
            .then(
              (result) => send({ kind: "rpc-cb-res", id, ok: true, result: marshal(result) }),
              (err) => send({ kind: "rpc-cb-res", id, ok: false, error: marshalError(err) }),
            );
          return true;
        }
        case "rpc-cb-res": {
          const p = cbPending.get(msg.id!);
          if (!p) return true;
          cbPending.delete(msg.id!);
          if (msg.ok) p.resolve(unmarshal(msg.result));
          else p.reject(unmarshalError(msg.error));
          return true;
        }
      }
      return false;
    },
  };

  return peer;
};

// ── Sync-channel op framing ───────────────────────────────────────────
// The sync channel carries opaque bytes; the op layer frames JSON
// `{op, args}` and returns `{ok, result|error}` — the same shape as
// rpc-res — so one dispatcher serves both transports. Args and results
// use the shared marshaller (bytes, dates); callbacks are not supported.

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export const encodeOpCall = (op: string, args: unknown[]): Uint8Array =>
  utf8.encode(JSON.stringify({ op, args: args.map(syncMarshaller.marshal) }));

export const decodeOpCall = (bytes: Uint8Array): { op: string; args: unknown[] } => {
  const msg = JSON.parse(utf8d.decode(bytes)) as { op: string; args: unknown[] };
  return { op: msg.op, args: (msg.args ?? []).map(syncMarshaller.unmarshal) };
};

export const encodeOpResult = (ok: boolean, value: unknown): Uint8Array =>
  utf8.encode(
    JSON.stringify(ok ? { ok, result: syncMarshaller.marshal(value) } : { ok, error: value }),
  );

export const decodeOpResult = (bytes: Uint8Array): unknown => {
  const msg = JSON.parse(utf8d.decode(bytes)) as { ok: boolean; result?: unknown; error?: unknown };
  if (msg.ok) return syncMarshaller.unmarshal(msg.result);
  throw unmarshalError(msg.error);
};
