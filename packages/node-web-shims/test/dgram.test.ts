import { describe, it, expect } from "vitest";
import { createDgramShim, Socket } from "../src/dgram.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("node-web-shims: dgram", () => {
  it("should match node:dgram type shape", () => {
    const shim = createDgramShim();
    const _nodeDgram = shim as unknown as typeof import("node:dgram");
    expect(_nodeDgram).toBeDefined();
  });

  it("createSocket validates the socket type", () => {
    const dgram = createDgramShim();
    expect(dgram.createSocket("udp4")).toBeInstanceOf(Socket);
    expect(dgram.createSocket({ type: "udp6" })).toBeInstanceOf(Socket);
    expect(() => dgram.createSocket("tcp" as never)).toThrowError(
      expect.objectContaining({
        code: "ERR_SOCKET_BAD_TYPE",
        message: "Bad socket type specified. Valid types are: udp4, udp6",
      }) as Error,
    );
  });

  // Mirrors test-dgram-bind.js.
  it("bind() returns the socket, emits 'listening' async, and re-bind throws", async () => {
    const dgram = createDgramShim();
    const socket = dgram.createSocket("udp4");

    const listening = new Promise<void>((resolve) => {
      socket.on("listening", () => {
        expect(() => socket.bind()).toThrowError(
          expect.objectContaining({
            code: "ERR_SOCKET_ALREADY_BOUND",
            name: "Error",
            message: "Socket is already bound",
          }) as Error,
        );
        socket.close();
        resolve();
      });
    });

    const result = socket.bind(); // Should not throw.
    expect(result).toBe(socket); // Should have returned itself.
    await listening;
  });

  it("bind(port, address) is reflected by address()", async () => {
    const dgram = createDgramShim();
    const socket = dgram.createSocket("udp4");
    socket.bind(41234, "127.0.0.1");
    await tick();
    expect(socket.address()).toEqual({
      address: "127.0.0.1",
      family: "IPv4",
      port: 41234,
    });
    socket.close();
  });

  it("address() before bind throws ERR_SOCKET_DGRAM_NOT_CONNECTED", () => {
    const dgram = createDgramShim();
    const socket = dgram.createSocket("udp4");
    expect(() => socket.address()).toThrowError(
      expect.objectContaining({
        code: "ERR_SOCKET_DGRAM_NOT_CONNECTED",
        message: "Not connected",
      }) as Error,
    );
  });

  it("close() emits 'close' and a second close throws ERR_SOCKET_DGRAM_NOT_RUNNING", async () => {
    const dgram = createDgramShim();
    const socket = dgram.createSocket("udp4");
    socket.bind(0);
    await tick();
    const closed = new Promise<void>((resolve) => socket.on("close", resolve));
    socket.close();
    await closed;
    expect(() => socket.close()).toThrowError(
      expect.objectContaining({
        code: "ERR_SOCKET_DGRAM_NOT_RUNNING",
        message: "Not running",
      }) as Error,
    );
  });

  // Mirrors test-dgram-abort-closed.js: closing an unbound socket must not
  // throw, and aborting after close must not throw either.
  it("abort signal after close is a no-op (test-dgram-abort-closed.js)", () => {
    const dgram = createDgramShim();
    const controller = new AbortController();
    const socket = dgram.createSocket({ type: "udp4", signal: controller.signal });
    socket.close();
    expect(() => controller.abort()).not.toThrow();
  });

  it("abort signal closes a bound socket", async () => {
    const dgram = createDgramShim();
    const controller = new AbortController();
    const socket = dgram.createSocket({ type: "udp4", signal: controller.signal });
    socket.bind(0);
    await tick();
    const closed = new Promise<void>((resolve) => socket.on("close", resolve));
    controller.abort();
    await closed;
  });

  // Mirrors test-dgram-send-callback-buffer-empty-address.js's contract:
  // send failures are reported through the callback, asynchronously, never
  // thrown synchronously.
  it("send() reports ERR_BOL_UNSUPPORTED_DGRAM_BACKEND through the callback asynchronously", async () => {
    const dgram = createDgramShim();
    const client = dgram.createSocket("udp4");
    client.bind(0);
    await tick();

    const buf = new Uint8Array(256).fill(0x78);
    let sync = true;
    const error = await new Promise<Error | null>((resolve) => {
      client.send(buf, client.address().port, "", (err) => {
        resolve(Object.assign(err ?? new Error("no error"), { firedSynchronously: sync }));
      });
      sync = false;
    });
    expect((error as Error & { firedSynchronously: boolean }).firedSynchronously).toBe(false);
    expect(error).toMatchObject({ code: "ERR_BOL_UNSUPPORTED_DGRAM_BACKEND" });
    client.close();
  });

  it("send() validates port synchronously", async () => {
    const dgram = createDgramShim();
    const socket = dgram.createSocket("udp4");
    socket.bind(0);
    await tick();
    expect(() => socket.send("x", 99999, "127.0.0.1")).toThrowError(
      expect.objectContaining({ code: "ERR_SOCKET_BAD_PORT" }) as Error,
    );
    socket.close();
  });

  it("ref()/unref() are chainable no-ops; tuning methods throw ERR_BOL_UNSUPPORTED_DGRAM_BACKEND", () => {
    const dgram = createDgramShim();
    const socket = dgram.createSocket("udp4");
    expect(socket.ref()).toBe(socket);
    expect(socket.unref()).toBe(socket);
    expect(() => socket.setTTL(64)).toThrowError(
      expect.objectContaining({ code: "ERR_BOL_UNSUPPORTED_DGRAM_BACKEND" }) as Error,
    );
    expect(() => socket.addMembership("224.0.0.1")).toThrowError(
      expect.objectContaining({ code: "ERR_BOL_UNSUPPORTED_DGRAM_BACKEND" }) as Error,
    );
    expect(() => socket.setBroadcast(true)).toThrowError(
      expect.objectContaining({ code: "ERR_BOL_UNSUPPORTED_DGRAM_BACKEND" }) as Error,
    );
  });
});
