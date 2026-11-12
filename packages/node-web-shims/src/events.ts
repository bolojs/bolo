import {
  EventEmitter as _EventEmitter,
  EventEmitterAsyncResource,
  addAbortListener,
  captureRejectionSymbol,
  errorMonitor,
  getEventListeners as unenvGetEventListeners,
  getMaxListeners as unenvGetMaxListeners,
  on,
  once,
  usingDomains,
} from "unenv/node/events";

export * from "unenv/node/events";

type EventEmitterLike = {
  getMaxListeners?: () => number;
  listenerCount?: (type: string | symbol) => number;
};
type MaxListenerTarget = { [kMaxEventTargetListeners]?: number };

const kMaxEventTargetListeners = Symbol.for("events.maxEventTargetListeners");

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
    const registry = eventTargetListeners.get(emitterOrTarget as EventTarget);
    return registry ? [...(registry.get(type) ?? [])] : [];
  }
  return unenvGetEventListeners(emitterOrTarget as never, type as never);
};

const eventTargetListeners = new WeakMap<EventTarget, Map<string | symbol, Function[]>>();
const originalAddEventListener = EventTarget.prototype.addEventListener;
const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
let listenersTracked = false;

/**
 * Tracks EventTarget listener registration so `getEventListeners` can report
 * the list without touching the DOM's private listener storage. Install in
 * realms that own their globals (process workers, harness page).
 */
export const trackEventTargetListeners = (): void => {
  if (listenersTracked) return;
  listenersTracked = true;
  EventTarget.prototype.addEventListener = function addEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
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
