export * from "unenv/node/diagnostics_channel";

const argTypeError = (name: string, expected: string, value: unknown): TypeError =>
  Object.assign(
    new TypeError(
      `The "${name}" argument must be of type ${expected}. Received ${
        value === null
          ? "null"
          : typeof value === "object" && value !== undefined
            ? `an instance of ${(value as { constructor?: { name?: string } }).constructor?.name ?? "Object"}`
            : `type ${typeof value} (${String(value)})`
      }`,
    ),
    { code: "ERR_INVALID_ARG_TYPE" },
  );

const validateFunction = (value: unknown, name: string): void => {
  if (typeof value !== "function") throw argTypeError(name, "function", value);
};

/**
 * A diagnostics channel. `channel(name)` returns the cached instance for
 * `name`, so subscribers and publishers rendezvous without further lookups.
 * Matches Node 22's pub/sub semantics: `publish` invokes every subscriber
 * with `(message, name)`, `unsubscribe` returns whether the subscriber was
 * found, and `subscribe` rejects non-functions with `ERR_INVALID_ARG_TYPE`.
 */
export class Channel {
  readonly name: string | symbol;
  #subscribers: ((message: unknown, name: string | symbol) => void)[] = [];

  constructor(name: string | symbol) {
    if (typeof name !== "string" && typeof name !== "symbol") {
      throw argTypeError("name", "string, symbol, or number", name);
    }
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return this.#subscribers.length > 0;
  }

  subscribe(onMessage: (message: unknown, name: string | symbol) => void): void {
    validateFunction(onMessage, "onMessage");
    this.#subscribers.push(onMessage);
  }

  unsubscribe(onMessage: (message: unknown, name: string | symbol) => void): boolean {
    validateFunction(onMessage, "onMessage");
    const index = this.#subscribers.indexOf(onMessage);
    if (index === -1) return false;
    this.#subscribers.splice(index, 1);
    return true;
  }

  publish(message: unknown): void {
    if (this.#subscribers.length === 0) return;
    // Copy: a subscriber that (un)subscribes mid-publish must not affect the
    // current delivery, matching Node's ArrayPrototypeSlice snapshot.
    for (const subscriber of this.#subscribers.slice()) {
      subscriber(message, this.name);
    }
  }

  get [Symbol.toStringTag](): string {
    return "Channel";
  }
}

const channels = new Map<string | symbol, Channel>();

/** Returns the channel for `name`, creating and caching it on first use. */
export const channel = (name: string | symbol): Channel => {
  if (typeof name !== "string" && typeof name !== "number" && typeof name !== "symbol") {
    throw argTypeError("name", "string, symbol, or number", name);
  }
  const key = typeof name === "number" ? String(name) : name;
  const existing = channels.get(key);
  if (existing) return existing;
  const created = new Channel(key);
  channels.set(key, created);
  return created;
};

/** True when the named channel exists and has at least one subscriber. */
export const hasSubscribers = (name: string | symbol): boolean => {
  return channels.get(name)?.hasSubscribers ?? false;
};

/** Subscribes `onMessage` to the named channel. */
export const subscribe = (
  name: string | symbol,
  onMessage: (message: unknown, name: string | symbol) => void,
): void => {
  channel(name).subscribe(onMessage);
};

/** Unsubscribes `onMessage` from the named channel; true when it was found. */
export const unsubscribe = (
  name: string | symbol,
  onMessage: (message: unknown, name: string | symbol) => void,
): boolean => {
  return channel(name).unsubscribe(onMessage);
};

/**
 * TracingChannel groups start/end/asyncStart/asyncEnd sub-channels for
 * tracing an operation. Only the publish surface is implemented (unenv's
 * store-based API is not); sub-channels are real named channels so
 * subscribers see ordinary `Channel` traffic.
 */
export class TracingChannel {
  readonly name: string | symbol;
  readonly start: Channel;
  readonly end: Channel;
  readonly asyncStart: Channel;
  readonly asyncEnd: Channel;

  constructor(name: string | symbol) {
    if (typeof name !== "string" && typeof name !== "number" && typeof name !== "symbol") {
      throw argTypeError("name", "string, symbol, or number", name);
    }
    const key = typeof name === "number" ? String(name) : name;
    this.name = key;
    this.start = channel(`${String(key)}:start`);
    this.end = channel(`${String(key)}:end`);
    this.asyncStart = channel(`${String(key)}:asyncStart`);
    this.asyncEnd = channel(`${String(key)}:asyncEnd`);
  }

  get hasSubscribers(): boolean {
    return (
      this.start.hasSubscribers ||
      this.end.hasSubscribers ||
      this.asyncStart.hasSubscribers ||
      this.asyncEnd.hasSubscribers
    );
  }

  subscribe(subscribers: {
    start?: (message: unknown, name: string | symbol) => void;
    end?: (message: unknown, name: string | symbol) => void;
    asyncStart?: (message: unknown, name: string | symbol) => void;
    asyncEnd?: (message: unknown, name: string | symbol) => void;
  }): void {
    if (subscribers?.start) this.start.subscribe(subscribers.start);
    if (subscribers?.end) this.end.subscribe(subscribers.end);
    if (subscribers?.asyncStart) this.asyncStart.subscribe(subscribers.asyncStart);
    if (subscribers?.asyncEnd) this.asyncEnd.subscribe(subscribers.asyncEnd);
  }

  unsubscribe(subscribers: {
    start?: (message: unknown, name: string | symbol) => void;
    end?: (message: unknown, name: string | symbol) => void;
    asyncStart?: (message: unknown, name: string | symbol) => void;
    asyncEnd?: (message: unknown, name: string | symbol) => void;
  }): void {
    if (subscribers?.start) this.start.unsubscribe(subscribers.start);
    if (subscribers?.end) this.end.unsubscribe(subscribers.end);
    if (subscribers?.asyncStart) this.asyncStart.unsubscribe(subscribers.asyncStart);
    if (subscribers?.asyncEnd) this.asyncEnd.unsubscribe(subscribers.asyncEnd);
  }

  traceSync<T>(fn: (...args: unknown[]) => T, context?: unknown): T {
    this.start.publish(context);
    try {
      const result = fn();
      this.end.publish(context);
      return result;
    } catch (error) {
      this.end.publish(context);
      throw error;
    }
  }

  get [Symbol.toStringTag](): string {
    return "TracingChannel";
  }
}

/** Returns a {@link TracingChannel} facade for `name`. */
export const tracingChannel = (name: string | symbol): TracingChannel => new TracingChannel(name);

const diagnostics_channel = {
  Channel,
  channel,
  hasSubscribers,
  subscribe,
  unsubscribe,
  tracingChannel,
  TracingChannel,
};

/**
 * Creates a node:diagnostics_channel shim with real channel/pub-sub
 * semantics — unenv's `Channel.subscribe` accepts non-functions (Node throws
 * `ERR_INVALID_ARG_TYPE`), which the Node 22 object-channel tests assert.
 */
export const createDiagnosticsChannelShim = (): typeof diagnostics_channel => {
  return diagnostics_channel;
};

export default createDiagnosticsChannelShim();
