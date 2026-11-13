// node:dgram shim — single-process, behaviorally honest skeleton.
//
// Socket lifecycle (create/bind/close/abort-signal, event ordering, error
// codes) mirrors Node's lib/dgram.js. Actually sending or receiving UDP is
// impossible in the browser, so send() reports ERR_BOL_UNSUPPORTED_DGRAM_BACKEND
// through the callback (Node's async callback-error contract) instead of
// throwing synchronously, and every socket-tuning method throws the same
// coded error naming the missing dgramBackend seam.

import { EventEmitter } from "./events.js";
import { unsupportedError } from "./coded-error.js";

interface NodeError extends Error {
  code: string;
}

const nodeError = (code: string, message: string): NodeError =>
  Object.assign(new Error(message), { code });

const notImplemented = (what: string): NodeError =>
  unsupportedError(
    "DGRAM_BACKEND",
    `${what} requires a UDP backend: datagrams have no Web API equivalent. ` +
      `Register one via createLiveShimRegistry({ dgramBackend })`,
  ) as NodeError;

export type SocketType = "udp4" | "udp6";
export type SocketFamily = "IPv4" | "IPv6";

export interface SocketOptions {
  type?: SocketType;
  signal?: AbortSignal;
  reuseAddr?: boolean;
  ipv6Only?: boolean;
  recvBufferSize?: number;
  sendBufferSize?: number;
  [key: string]: unknown;
}

export interface RemoteInfo {
  address: string;
  family: SocketFamily;
  port: number;
  size: number;
}

export interface AddressInfo {
  address: string;
  family: SocketFamily;
  port: number;
}

export type MessageListener = (msg: Uint8Array, rinfo: RemoteInfo) => void;

const BAD_TYPE_MESSAGE = "Bad socket type specified. Valid types are: udp4, udp6";

const defaultAddress = (type: SocketType): string => (type === "udp4" ? "0.0.0.0" : "::");

export class Socket extends EventEmitter {
  #type: SocketType;
  #bound = false;
  #closed = false;
  #info: AddressInfo | undefined;
  #abortSignal: AbortSignal | undefined;
  #onAborted: (() => void) | undefined;

  constructor(type: SocketType, options?: SocketOptions) {
    super();
    this.#type = type;
    const signal = options?.signal;
    if (signal) {
      this.#abortSignal = signal;
      this.#onAborted = () => {
        // Abort after close must be a no-op, not an ERR_SOCKET_DGRAM_NOT_RUNNING
        // throw (test-dgram-abort-closed.js).
        if (!this.#closed) this.close();
      };
      if (signal.aborted) {
        this.#onAborted();
      } else {
        signal.addEventListener("abort", this.#onAborted, { once: true });
      }
    }
  }

  get type(): SocketType {
    return this.#type;
  }

  bind(port?: number | (() => void), address?: string | (() => void), callback?: () => void): this {
    if (typeof port === "function") {
      callback = port;
      port = undefined;
    }
    if (typeof address === "function") {
      callback = address;
      address = undefined;
    }
    if (callback) this.once("listening", callback);

    if (this.#bound) {
      throw nodeError("ERR_SOCKET_ALREADY_BOUND", "Socket is already bound");
    }

    const port_ = port ?? 0;
    if (!Number.isInteger(port_) || port_ < 0 || port_ > 65535) {
      throw nodeError("ERR_SOCKET_BAD_PORT", `Port should be >= 0 and < 65536. Received ${port_}`);
    }

    this.#bound = true;
    this.#closed = false;
    this.#info = {
      address: address ?? defaultAddress(this.#type),
      family: this.#type === "udp4" ? "IPv4" : "IPv6",
      port: port_,
    };

    queueMicrotask(() => {
      this.emit("listening");
    });

    return this;
  }

  close(callback?: () => void): this {
    if (callback) this.once("close", callback);
    // Node's handle exists from construction, so closing a never-bound socket
    // succeeds; only a second close throws (test-dgram-abort-closed.js closes
    // an unbound socket and then aborts the signal).
    if (this.#closed) {
      throw nodeError("ERR_SOCKET_DGRAM_NOT_RUNNING", "Not running");
    }
    this.#bound = false;
    this.#closed = true;
    if (this.#abortSignal && this.#onAborted) {
      this.#abortSignal.removeEventListener("abort", this.#onAborted);
    }
    queueMicrotask(() => {
      this.emit("close");
    });
    return this;
  }

  address(): AddressInfo {
    if (!this.#bound || !this.#info) {
      throw nodeError("ERR_SOCKET_DGRAM_NOT_CONNECTED", "Not connected");
    }
    return { ...this.#info };
  }

  /**
   * send(msg[, port[, address]][, callback]) — real UDP is impossible, so the
   * callback receives an ERR_BOL_UNSUPPORTED_DGRAM_BACKEND error asynchronously, matching
   * Node's contract of reporting send failures through the callback. Without
   * a callback the error is emitted as 'error'.
   */
  send(
    msg: unknown,
    port?: number | (() => void) | ((error: Error | null) => void),
    address?: string | ((error: Error | null) => void),
    callback?: (error: Error | null) => void,
  ): void {
    if (typeof port === "function") {
      callback = port as (error: Error | null) => void;
      port = undefined;
    }
    if (typeof address === "function") {
      callback = address;
      address = undefined;
    }

    const validMsg = typeof msg === "string" || msg instanceof Uint8Array || Array.isArray(msg);
    if (!validMsg) {
      throw nodeError(
        "ERR_INVALID_ARG_TYPE",
        'The "msg" argument must be a string, Buffer, or Uint8Array',
      );
    }

    const port_ = port ?? 0;
    if (!Number.isInteger(port_) || port_ < 0 || port_ > 65535) {
      throw nodeError("ERR_SOCKET_BAD_PORT", `Port should be >= 0 and < 65536. Received ${port_}`);
    }
    if (address !== undefined && typeof address !== "string") {
      throw nodeError("ERR_INVALID_ARG_TYPE", 'The "address" argument must be a string');
    }

    const error = notImplemented("dgram.Socket.send()");
    queueMicrotask(() => {
      if (callback) {
        callback(error);
      } else {
        this.emit("error", error);
      }
    });
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  setBroadcast = (): never => {
    throw notImplemented("dgram.Socket#setBroadcast()");
  };
  setTTL = (): never => {
    throw notImplemented("dgram.Socket#setTTL()");
  };
  setMulticastTTL = (): never => {
    throw notImplemented("dgram.Socket#setMulticastTTL()");
  };
  setMulticastLoopback = (): never => {
    throw notImplemented("dgram.Socket#setMulticastLoopback()");
  };
  setMulticastInterface = (): never => {
    throw notImplemented("dgram.Socket#setMulticastInterface()");
  };
  addMembership = (): never => {
    throw notImplemented("dgram.Socket#addMembership()");
  };
  dropMembership = (): never => {
    throw notImplemented("dgram.Socket#dropMembership()");
  };
  addSourceSpecificMembership = (): never => {
    throw notImplemented("dgram.Socket#addSourceSpecificMembership()");
  };
  dropSourceSpecificMembership = (): never => {
    throw notImplemented("dgram.Socket#dropSourceSpecificMembership()");
  };
  setRecvBufferSize = (): never => {
    throw notImplemented("dgram.Socket#setRecvBufferSize()");
  };
  setSendBufferSize = (): never => {
    throw notImplemented("dgram.Socket#setSendBufferSize()");
  };
  getRecvBufferSize = (): never => {
    throw notImplemented("dgram.Socket#getRecvBufferSize()");
  };
  getSendBufferSize = (): never => {
    throw notImplemented("dgram.Socket#getSendBufferSize()");
  };
  getSendQueueSize = (): never => {
    throw notImplemented("dgram.Socket#getSendQueueSize()");
  };
  getSendQueueCount = (): never => {
    throw notImplemented("dgram.Socket#getSendQueueCount()");
  };
}

export const createSocket = (
  typeOrOptions: SocketType | SocketOptions,
  listener?: MessageListener,
): Socket => {
  let type: SocketType | undefined;
  let options: SocketOptions | undefined;

  if (typeof typeOrOptions === "string") {
    type = typeOrOptions;
  } else if (typeOrOptions !== null && typeof typeOrOptions === "object") {
    options = typeOrOptions;
    type = options.type;
  }

  if (type !== "udp4" && type !== "udp6") {
    throw nodeError("ERR_SOCKET_BAD_TYPE", BAD_TYPE_MESSAGE);
  }

  const socket = new Socket(type, options);
  if (listener) socket.on("message", listener);
  return socket;
};

export const _createSocketHandle = (): void => {
  throw notImplemented("dgram._createSocketHandle()");
};

const dgram = {
  Socket,
  _createSocketHandle,
  createSocket,
};

export const createDgramShim = (): typeof dgram => dgram;

export default createDgramShim();
