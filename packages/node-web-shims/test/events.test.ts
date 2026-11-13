import { describe, it, expect } from "vitest";
import { createEventsShim } from "../src/events.ts";

describe("node-web-shims: events", () => {
  it("should match node:events type shape", () => {
    const shim = createEventsShim();
    const _nodeEvents: typeof import("node:events") = shim;
    expect(_nodeEvents).toBeDefined();
  });

  it("exposes every module-level name as an enumerable key", () => {
    // `bundleEntry`'s shimModuleSource re-exports Object.keys(shim) — the
    // shim must carry the full surface as enumerable own properties.
    const keys = Object.keys(createEventsShim());
    for (const name of [
      "EventEmitter",
      "EventEmitterAsyncResource",
      "once",
      "on",
      "getEventListeners",
      "getMaxListeners",
      "setMaxListeners",
      "addAbortListener",
      "listenerCount",
      "init",
      "defaultMaxListeners",
      "errorMonitor",
      "captureRejectionSymbol",
    ]) {
      expect(keys, `missing ${name}`).toContain(name);
    }
  });

  it("is itself the EventEmitter class (require('events') === EventEmitter)", () => {
    const shim = createEventsShim();
    expect(shim).toBe(shim.EventEmitter);
    const emitter = new (shim as unknown as new () => {
      on: (e: string, f: () => void) => void;
      emit: (e: string) => boolean;
    })();
    let fired = false;
    emitter.on("x", () => (fired = true));
    emitter.emit("x");
    expect(fired).toBe(true);
  });

  it("once/on return working async helpers", async () => {
    const shim = createEventsShim();
    const emitter = new shim.EventEmitter();
    const p = shim.once(emitter, "go");
    emitter.emit("go", 42);
    await expect(p).resolves.toEqual([42]);
  });

  it("on is the same function as addListener (Node alias semantics)", () => {
    const shim = createEventsShim();
    expect(shim.EventEmitter.prototype.on).toBe(shim.EventEmitter.prototype.addListener);
  });

  it("on does not recurse through stream-style subclasses that alias addListener to on", () => {
    // readable-stream's Readable.prototype.on calls Stream.prototype.on while
    // Readable.prototype.addListener aliases back to Readable.prototype.on.
    // Node's `on === addListener` impl makes that safe; a dispatching `on`
    // (unenv's `on` calls `this.addListener`) ping-pongs until stack overflow.
    const shim = createEventsShim();
    class Legacy extends shim.EventEmitter {}
    Object.assign(Legacy.prototype, { addListener: Legacy.prototype.on });
    const emitter = new Legacy();
    let fired = false;
    emitter.on("x", () => (fired = true));
    emitter.emit("x");
    expect(fired).toBe(true);
  });

  it("init initializes emitter internals", () => {
    const shim = createEventsShim();
    const target = {} as { _events?: unknown; _eventsCount?: number };
    (shim.init as (e: unknown) => void)(target);
    expect(target._eventsCount).toBe(0);
    expect(target._events).toEqual({});
  });

  it("setMaxListeners updates defaultMaxListeners", () => {
    const shim = createEventsShim();
    const before = shim.defaultMaxListeners;
    shim.setMaxListeners(before + 5);
    expect(shim.defaultMaxListeners).toBe(before + 5);
    shim.setMaxListeners(before);
  });

  it("getEventListeners returns listeners for emitters and EventTargets", () => {
    const shim = createEventsShim();
    const emitter = new shim.EventEmitter();
    const listener = () => {};
    emitter.on("a", listener);
    expect(shim.getEventListeners(emitter, "a")).toContain(listener);
  });
});
