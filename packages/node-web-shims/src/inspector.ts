import { createEventsShim } from "./events.js";
import { unsupportedError } from "./coded-error.js";

const { EventEmitter } = createEventsShim();

/**
 * node:inspector shim — honest stub.
 *
 * No V8 debug port can listen in a browser, so `open()` validates its
 * arguments exactly like node and then throws `ERR_BOL_UNSUPPORTED_INSPECTOR_BACKEND`
 * rather than pretending to listen. The activation state machine is real: an
 * activated inspector (which only a host embedding a real backend could
 * produce, e.g. a future `--inspect` equivalent) makes the next `open()`
 * throw `ERR_INSPECTOR_ALREADY_ACTIVATED` and gives `url()` a value;
 * `close()` deactivates.
 */

/**
 * Whether an inspector backend is active. Nothing in this shim can set it
 * to true — kept so the open/close/url contract stays truthful if a host
 * ever wires a real backend.
 */
let activated = false;
let activatedUrl: string | undefined;

const notImplemented = (what: string): Error =>
  unsupportedError(
    "INSPECTOR_BACKEND",
    `${what} requires an inspector backend: the DevTools protocol session cannot be bridged to a browser debug port`,
  );

/**
 * node:inspector `open(port?, host?, wait?)`. Port validation matches node
 * 22 exactly (ERR_OUT_OF_RANGE); after validation the call fails honestly
 * because no debug port can listen here.
 */
export const open = (port = 9229, _host?: string, _wait?: boolean): never => {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw Object.assign(
      new RangeError(
        `The value of "port" is out of range. It must be >= 0 && <= 65535. Received ${port}`,
      ),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
  if (activated) {
    throw Object.assign(new Error("Inspector is already activated"), {
      code: "ERR_INSPECTOR_ALREADY_ACTIVATED",
    });
  }
  throw notImplemented("inspector.open");
};

/** Deactivates the inspector; a no-op when nothing is active. */
export const close = (): void => {
  activated = false;
  activatedUrl = undefined;
};

/** The WebSocket URL of the active inspector, or `undefined` when inactive. */
export const url = (): string | undefined => (activated ? activatedUrl : undefined);

/**
 * node blocks here until a debugger frontend attaches. With no backend that
 * could ever resume, this is an honest no-op rather than a hang.
 */
export const waitForDebugger = (): void => {};

const noop = (): void => {};

/** node:inspector `console` — a side channel to the devtools console. */
export const console = {
  debug: noop,
  error: noop,
  info: noop,
  log: noop,
  warn: noop,
  dir: noop,
  dirxml: noop,
  table: noop,
  trace: noop,
  group: noop,
  groupCollapsed: noop,
  groupEnd: noop,
  clear: noop,
  count: noop,
  countReset: noop,
  assert: noop,
  profile: noop,
  profileEnd: noop,
  time: noop,
  timeLog: noop,
  timeStamp: noop,
};

/** node:inspector `Network` event-stream helpers — no backend to subscribe to. */
export const Network = {
  loadingFailed: () => {
    throw notImplemented("inspector.Network.loadingFailed");
  },
  loadingFinished: () => {
    throw notImplemented("inspector.Network.loadingFinished");
  },
  requestWillBeSent: () => {
    throw notImplemented("inspector.Network.requestWillBeSent");
  },
  responseReceived: () => {
    throw notImplemented("inspector.Network.responseReceived");
  },
};

export class Session extends EventEmitter {
  #connected = false;

  /** Marks the session connected. A second connect throws, like node. */
  connect(): void {
    if (this.#connected) {
      throw Object.assign(new Error("Session is already connected"), {
        code: "ERR_INSPECTOR_ALREADY_CONNECTED",
      });
    }
    this.#connected = true;
  }

  /** Emits 'disconnect'; safe to call when not connected. */
  disconnect(): void {
    this.#connected = false;
    this.emit("disconnect");
  }

  /**
   * `post(method, params?, callback?)`. Method validation is synchronous
   * (ERR_INVALID_ARG_TYPE, node 22 message shape); the callback then fires
   * asynchronously with ERR_BOL_UNSUPPORTED_INSPECTOR_BACKEND — there is no inspector to reach.
   */
  post(
    method: string,
    params?: Record<string, unknown> | ((error: Error | null) => void),
    callback?: (error: Error | null) => void,
  ): void {
    if (typeof method !== "string") {
      const received = `type ${typeof method} (${String(method)})`;
      throw Object.assign(
        new TypeError(`The "method" argument must be of type string. Received ${received}`),
        { code: "ERR_INVALID_ARG_TYPE" },
      );
    }
    const cb = typeof params === "function" ? params : callback;
    const error = notImplemented(`inspector.Session.post(${method})`);
    queueMicrotask(() => cb?.(error));
  }
}

export const createInspectorShim = () => ({
  open,
  close,
  url,
  waitForDebugger,
  Session,
  console,
  Network,
});

export default createInspectorShim();
