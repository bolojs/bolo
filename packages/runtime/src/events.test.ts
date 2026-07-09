import { describe, expect, it, vi } from "vitest";
import { createEventEmitter } from "./events.js";

describe("createEventEmitter", () => {
  it("should emit port events to listeners", () => {
    const emitter = createEventEmitter();
    const listener = vi.fn();
    emitter.on("port", listener);
    emitter.emit("port", 3000, "open", "http://localhost:3000");
    expect(listener).toHaveBeenCalledWith(3000, "open", "http://localhost:3000");
  });

  it("should emit server-ready events to listeners", () => {
    const emitter = createEventEmitter();
    const listener = vi.fn();
    emitter.on("server-ready", listener);
    emitter.emit("server-ready", 8080, "http://localhost:8080");
    expect(listener).toHaveBeenCalledWith(8080, "http://localhost:8080");
  });

  it("should emit error events to listeners", () => {
    const emitter = createEventEmitter();
    const listener = vi.fn();
    emitter.on("error", listener);
    const err = new Error("fail");
    emitter.emit("error", err);
    expect(listener).toHaveBeenCalledWith(err);
  });

  it("should support multiple listeners for same event", () => {
    const emitter = createEventEmitter();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    emitter.on("port", listener1);
    emitter.on("port", listener2);
    emitter.emit("port", 3000, "open", "http://localhost:3000");
    expect(listener1).toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();
  });

  it("should remove listener via unsubscribe", () => {
    const emitter = createEventEmitter();
    const listener = vi.fn();
    const unsub = emitter.on("port", listener);
    unsub();
    emitter.emit("port", 3000, "open", "http://localhost:3000");
    expect(listener).not.toHaveBeenCalled();
  });

  it("should remove only the unsubscribed listener", () => {
    const emitter = createEventEmitter();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = emitter.on("port", listener1);
    emitter.on("port", listener2);
    unsub1();
    emitter.emit("port", 3000, "open", "http://localhost:3000");
    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();
  });

  it("should remove all listeners via removeAllListeners", () => {
    const emitter = createEventEmitter();
    const portListener = vi.fn();
    const serverReadyListener = vi.fn();
    emitter.on("port", portListener);
    emitter.on("server-ready", serverReadyListener);
    emitter.removeAllListeners();
    emitter.emit("port", 3000, "open", "http://localhost:3000");
    emitter.emit("server-ready", 8080, "http://localhost:8080");
    expect(portListener).not.toHaveBeenCalled();
    expect(serverReadyListener).not.toHaveBeenCalled();
  });

  it("should dispatch synchronously", () => {
    const emitter = createEventEmitter();
    const order: string[] = [];
    emitter.on("port", () => order.push("first"));
    emitter.on("port", () => order.push("second"));
    emitter.emit("port", 3000, "open", "http://localhost:3000");
    expect(order).toEqual(["first", "second"]);
  });
});
