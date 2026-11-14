import {
  EventEmitter as _EventEmitter,
  EventEmitterAsyncResource,
  addAbortListener,
  captureRejectionSymbol,
  errorMonitor,
  getEventListeners as unenvGetEventListeners,
  getMaxListeners as unenvGetMaxListeners,
  on,
  usingDomains,
} from "unenv/node/events";

export * from "unenv/node/events";

type EventEmitterLike = {
  getMaxListeners?: () => number;
  listenerCount?: (type: string | symbol) => number;
};
type MaxListenerTarget = { [kMaxEventTargetListeners]?: number };

const kMaxEventTargetListeners = Symbol.for("events.maxEventTargetListeners");

/** Node's DOMException-named rejection reason for aborted `once`/`on` waits. */
class AbortError extends Error {
  readonly code = "ABORT_ERR";
  readonly cause: unknown;
  constructor(message = "The operation was aborted", options?: { cause?: unknown }) {
    super(message);
    this.name = "AbortError";
    this.cause = options?.cause;
  }
}

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

const isAbortSignal = (value: unknown): value is AbortSignal =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AbortSignal).aborted === "boolean" &&
  typeof (value as AbortSignal).addEventListener === "function";

/**
 * Waits for one `name` event on an EventEmitter or EventTarget — Node 22
 * semantics:
 * - invalid `options` / `options.signal` reject `ERR_INVALID_ARG_TYPE`
 *   (the async function turns the synchronous validation into rejections)
 * - an already-aborted signal rejects with `AbortError`
 * - on EventEmitters (checked first, so a poisoned `addEventListener` is
 *   never touched), an emitted `'error'` rejects with the error and both
 *   listeners are removed
 * - on EventTargets, `'error'` resolves like any other event
 * - aborting after listening rejects with `AbortError` and detaches both
 *   listeners; a prior `stopImmediatePropagation()` on the signal cannot
 *   swallow the rejection (Node's kResistStopPropagation equivalent), which
 *   the poll fallback covers since browsers offer no flag channel.
 */
const once = async (
  emitter: {
    on?: Function;
    once?: Function;
    addEventListener?: Function;
    removeListener?: Function;
    removeEventListener?: Function;
  },
  name: string | symbol,
  options?: unknown,
): Promise<unknown[]> => {
  if (options === undefined) {
    options = {};
  } else if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw argTypeError("options", "object", options);
  }
  const signal = (options as { signal?: unknown }).signal;
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw argTypeError("signal", "AbortSignal", signal);
  }
  if (signal?.aborted) {
    throw new AbortError(undefined, { cause: (signal as AbortSignal).reason });
  }

  return new Promise<unknown[]>((resolve, reject) => {
    let settled = false;
    let abortPoll: ReturnType<typeof setInterval> | undefined;

    const cleanup = (): void => {
      if (abortPoll !== undefined) {
        clearInterval(abortPoll);
        abortPoll = undefined;
      }
    };

    const errorListener = (err: unknown): void => {
      if (settled) return;
      settled = true;
      eventTargetAgnosticRemoveListener(emitter, name, resolver);
      if (signal != null) eventTargetAgnosticRemoveListener(signal, "abort", abortListener);
      cleanup();
      reject(err);
    };

    const resolver = (...args: unknown[]): void => {
      if (settled) return;
      settled = true;
      eventTargetAgnosticRemoveListener(emitter, "error", errorListener);
      if (signal != null) eventTargetAgnosticRemoveListener(signal, "abort", abortListener);
      cleanup();
      resolve(args);
    };

    function abortListener(): void {
      if (settled) return;
      settled = true;
      eventTargetAgnosticRemoveListener(emitter, name, resolver);
      eventTargetAgnosticRemoveListener(emitter, "error", errorListener);
      cleanup();
      reject(new AbortError(undefined, { cause: (signal as AbortSignal | undefined)?.reason }));
    }

    eventTargetAgnosticAddListener(emitter, name, resolver, { once: true });
    if (name !== "error" && typeof emitter.once === "function") {
      // EventTargets have no Node-style 'error' semantics — only listen on
      // emitters that look like EventEmitters.
      emitter.once("error", errorListener);
    }
    if (signal != null) {
      signal.addEventListener("abort", abortListener, { once: true });
      // A listener registered before ours may call stopImmediatePropagation()
      // during 'abort' dispatch, which would skip abortListener entirely even
      // though signal.aborted is already true. Node's internal EventTarget
      // honors kResistStopPropagation; native ones do not, so poll as a
      // safety net while the wait is pending.
      abortPoll = setInterval(() => {
        if ((signal as AbortSignal).aborted) abortListener();
      }, 1);
    }
  });
};

const eventTargetAgnosticAddListener = (
  target: {
    on?: Function;
    once?: Function;
    addEventListener?: Function;
  },
  name: string | symbol,
  listener: (...args: unknown[]) => void,
  flags?: { once?: boolean },
): void => {
  if (typeof target.on === "function") {
    if (flags?.once && typeof target.once === "function") target.once(name, listener);
    else target.on(name, listener);
  } else if (typeof target.addEventListener === "function") {
    target.addEventListener(name, listener, flags);
  } else {
    throw argTypeError("emitter", "EventEmitter", target);
  }
};

const eventTargetAgnosticRemoveListener = (
  target: {
    removeListener?: Function;
    removeEventListener?: Function;
  },
  name: string | symbol,
  listener: (...args: unknown[]) => void,
): void => {
  if (typeof target.removeListener === "function") {
    target.removeListener(name, listener);
  } else if (typeof target.removeEventListener === "function") {
    target.removeEventListener(name, listener);
  } else {
    throw argTypeError("emitter", "EventEmitter", target);
  }
};

const isEventTargetLike = (target: unknown): target is EventTarget =>
  typeof target === "object" &&
  target !== null &&
  typeof (target as EventTarget).addEventListener === "function" &&
  typeof (target as EventTarget).removeEventListener === "function";

/**
 * `events.getMaxListeners` works for both EventEmitters and EventTargets.
 * unenv's version throws `ERR_INVALID_ARG_TYPE` for an EventTarget whose max
 * was never set — Node returns `defaultMaxListeners` in that case.
 */
const getMaxListeners = (emitterOrTarget: unknown): number => {
  if (typeof (emitterOrTarget as EventEmitterLike | null)?.getMaxListeners === "function") {
    return (emitterOrTarget as EventEmitterLike).getMaxListeners!();
  }
  if (
    emitterOrTarget !== null &&
    emitterOrTarget !== undefined &&
    (isEventTargetLike(emitterOrTarget) ||
      typeof (emitterOrTarget as MaxListenerTarget)[kMaxEventTargetListeners] === "number")
  ) {
    return (
      (emitterOrTarget as MaxListenerTarget)[kMaxEventTargetListeners] ??
      _EventEmitter.defaultMaxListeners
    );
  }
  // Falls back to unenv's implementation, which throws ERR_INVALID_ARG_TYPE.
  return (unenvGetMaxListeners as (t: unknown) => number)(emitterOrTarget);
};

/**
 * `events.getEventListeners` — unenv's version crashes on EventTargets
 * (`kEvents is not defined`, an upstream unenv bug). Read the listener list
 * through the DOM's own `getEventListeners` when available, else fall back to
 * the wrapped handler chain via a probe `AbortSignal`-style walk.
 */
const getEventListenersFixed = (emitterOrTarget: unknown, type: string | symbol): Function[] => {
  const emitter = emitterOrTarget as { listeners?: (t: string | symbol) => Function[] } | null;
  if (typeof emitter?.listeners === "function") return emitter.listeners(type);
  if (isEventTargetLike(emitterOrTarget)) {
    // Real browsers expose the internal listener list only to DevTools; there
    // is no portable read. Track addEventListener ourselves per target.
    const registry = registryFor(emitterOrTarget as EventTarget).listeners.get(
      emitterOrTarget as EventTarget,
    );
    return registry ? [...(registry.get(type) ?? [])] : [];
  }
  return unenvGetEventListeners(emitterOrTarget as never, type as never);
};

/**
 * The listener registry hangs off `EventTarget.prototype` (a non-enumerable
 * symbol property) rather than a module-local WeakMap: the shim module can
 * be instantiated in more than one realm (the page bundles one copy, the
 * process worker imports another), and realms share the prototype object
 * but not their globals — a registry keyed on either side's `globalThis`
 * would be invisible to the other.
 */
const EVENT_TARGET_LISTENERS = Symbol.for("bolojs.events.eventTargetListeners");

interface ListenerRegistry {
  readonly listeners: WeakMap<EventTarget, Map<string | symbol, Function[]>>;
  tracked: boolean;
}

const createListenerRegistry = (): ListenerRegistry => ({
  listeners: new WeakMap<EventTarget, Map<string | symbol, Function[]>>(),
  tracked: false,
});

const registryOn = (proto: object): ListenerRegistry | undefined =>
  (proto as Record<symbol, ListenerRegistry | undefined>)[EVENT_TARGET_LISTENERS];

/**
 * The registry that owns `target`: walk the target's own prototype chain, so
 * the registry comes from the realm that owns the target (the process
 * worker's realm), not from the realm the reader function happens to run
 * in. Falls back to this realm's prototype for targets that carry no
 * registry at all.
 */
const registryFor = (target: EventTarget): ListenerRegistry => {
  let proto: object | null = Object.getPrototypeOf(target);
  while (proto) {
    const found = registryOn(proto);
    if (found) return found;
    proto = Object.getPrototypeOf(proto);
  }
  return listenerRegistry();
};

const listenerRegistry = (): ListenerRegistry => {
  const proto = EventTarget.prototype as unknown as Record<symbol, ListenerRegistry | undefined>;
  const existing = proto[EVENT_TARGET_LISTENERS];
  if (existing) return existing;
  const created = createListenerRegistry();
  Object.defineProperty(proto, EVENT_TARGET_LISTENERS, {
    configurable: true,
    enumerable: false,
    value: created,
    writable: true,
  });
  return created;
};

const originalAddEventListener = EventTarget.prototype.addEventListener;
const originalRemoveEventListener = EventTarget.prototype.removeEventListener;

/**
 * Tracks EventTarget listener registration so `getEventListeners` can report
 * the list without touching the DOM's private listener storage. Install in
 * realms that own their globals (process workers, harness page).
 */
export const trackEventTargetListeners = (): void => {
  const registry0 = listenerRegistry();
  if (registry0.tracked) return;
  registry0.tracked = true;
  EventTarget.prototype.addEventListener = function addEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    const eventTargetListeners = registryFor(this).listeners;
    let registry = eventTargetListeners.get(this);
    if (!registry) {
      registry = new Map();
      eventTargetListeners.set(this, registry);
    }
    let list = registry.get(type);
    if (!list) {
      list = [];
      registry.set(type, list);
    }
    const fn =
      typeof listener === "function"
        ? listener
        : listener
          ? (ev: Event) => listener.handleEvent(ev)
          : null;
    if (fn && !list.includes(fn)) list.push(fn);
    return originalAddEventListener.call(this, type, listener, options);
  } as typeof EventTarget.prototype.addEventListener;
  EventTarget.prototype.removeEventListener = function removeEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    const eventTargetListeners = registryFor(this).listeners;
    const registry = eventTargetListeners.get(this);
    const list = registry?.get(type);
    if (list) {
      const fn =
        typeof listener === "function"
          ? listener
          : listener
            ? (ev: Event) => listener.handleEvent(ev)
            : null;
      const index = fn ? list.indexOf(fn) : -1;
      if (index !== -1) list.splice(index, 1);
    }
    return originalRemoveEventListener.call(this, type, listener, options);
  } as typeof EventTarget.prototype.removeEventListener;
};
const listenerCount = (emitter: unknown, type: string | symbol): number => {
  const target = emitter as EventEmitterLike | null;
  if (typeof target?.listenerCount === "function") {
    return target.listenerCount(type);
  }
  return 0;
};

// The shim object must be the EventEmitter class itself: Node's
// `require("events")` returns EventEmitter (packages do
// `class Foo extends require("events")`), so the registry shim must stay
// constructable while also exposing every module-level name as an *enumerable*
// own property — `bundleEntry`'s shimModuleSource only re-exports
// `Object.keys(shim)`.
const setMaxListeners = _EventEmitter.setMaxListeners;

/**
 * `events.init(emitter)` — Node's legacy initializer (also reachable as
 * `EventEmitter.init`). unenv ships a stub that throws.
 */
const init = (emitter: { _events?: unknown; _eventsCount?: number }): void => {
  if (
    emitter._events === undefined ||
    emitter._events === Object.getPrototypeOf(emitter)?._events
  ) {
    emitter._events = { __proto__: null };
    emitter._eventsCount = 0;
  }
};

// Node defines `EventEmitter.prototype.on` as the *same function object* as
// `addListener` — `on` does not dispatch through `this.addListener`. unenv
// keeps them separate, with `on` calling `this.addListener(...)`. That breaks
// legacy stream subclasses (readable-stream's `Readable.prototype.on` calls
// `Stream.prototype.on.call(this)` while aliasing `addListener` back to `on`):
// the dispatch ping-pongs `on → addListener → on` until the stack overflows.
// Re-alias so `on` runs the base registration directly, matching Node.
const addListenerImpl = _EventEmitter.prototype.addListener;
Object.defineProperty(_EventEmitter.prototype, "on", {
  value: addListenerImpl,
  writable: true,
  configurable: true,
});

// Several of these names exist on unenv's class as getter-only statics —
// `Object.assign` would throw `Cannot set property … which has only a
// getter`. defineProperties redefines them as enumerable data properties.
const eventStatics = {
  EventEmitter: _EventEmitter,
  EventEmitterAsyncResource,
  once,
  on,
  getEventListeners: getEventListenersFixed,
  getMaxListeners,
  setMaxListeners,
  addAbortListener,
  listenerCount,
  init,
  errorMonitor,
  captureRejectionSymbol,
  usingDomains,
};
Object.defineProperties(
  _EventEmitter,
  Object.fromEntries(
    Object.entries(eventStatics).map(([key, value]) => [
      key,
      { value, enumerable: true, configurable: true, writable: true },
    ]),
  ),
);
// `typeof _EventEmitter & typeof eventStatics` won't do: unenv's ambient
// `static get EventEmitter()` types as `any`, which swallows the explicit
// member type in an intersection. Use a fresh constructor signature instead.
type EventsShim = (new (opts?: unknown) => _EventEmitter) &
  typeof eventStatics & {
    defaultMaxListeners: number;
    captureRejections: boolean;
    prototype: _EventEmitter;
  };
const events = _EventEmitter as unknown as EventsShim;

// `defaultMaxListeners` exists on the class as a non-enumerable accessor;
// re-define it enumerable so it lands in Object.keys while staying live.
const defaultMaxListenersDesc = Object.getOwnPropertyDescriptor(
  _EventEmitter,
  "defaultMaxListeners",
);
Object.defineProperty(_EventEmitter, "defaultMaxListeners", {
  enumerable: true,
  configurable: true,
  get: defaultMaxListenersDesc?.get ?? (() => 10),
  set: defaultMaxListenersDesc?.set ?? (() => {}),
});

const captureRejectionsDesc = Object.getOwnPropertyDescriptor(_EventEmitter, "captureRejections");
Object.defineProperty(_EventEmitter, "captureRejections", {
  enumerable: true,
  configurable: true,
  get: captureRejectionsDesc?.get ?? (() => false),
  set: captureRejectionsDesc?.set ?? (() => {}),
});

/**
 * Creates a node:events shim. The result is the EventEmitter class with all
 * module-level names attached as enumerable statics.
 */
export const createEventsShim = (): typeof events => {
  return events;
};

// Named exports for the direct-import path (vite alias → dist/events.js).
export const EventEmitter = _EventEmitter;
export const getEventListeners = getEventListenersFixed;
export {
  once,
  on,
  getMaxListeners,
  setMaxListeners,
  addAbortListener,
  EventEmitterAsyncResource,
  listenerCount,
  init,
  errorMonitor,
  captureRejectionSymbol,
  usingDomains,
};

export default createEventsShim();
