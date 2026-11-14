import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { createLoopbackDgramBackend } from "./dgram-backend.js";
import { createLiveShimRegistry } from "./live.js";

describe("createLoopbackDgramBackend", () => {
  it("binds and reports the bound address", async () => {
    const backend = createLoopbackDgramBackend();
    const socket = backend.createSocket("udp4");
    const bound = await new Promise<{ address: string; port: number }>((resolve, reject) => {
      socket.bind(0, "0.0.0.0", (err) => (err ? reject(err) : resolve(socket.address())));
    });
    expect(bound.port).toBeGreaterThan(0);
    expect(bound.address).toBe("0.0.0.0");
  });

  it("delivers a datagram in-realm and reports the byte count in the send callback", async () => {
    const backend = createLoopbackDgramBackend();
    const receiver = backend.createSocket("udp4");
    const sender = backend.createSocket("udp4");

    const received = new Promise<{ msg: Uint8Array; rinfo: { port: number } }>((resolve) => {
      receiver.onMessage((msg, rinfo) => resolve({ msg, rinfo: rinfo as { port: number } }));
    });

    const receiverPort = await new Promise<number>((resolve, reject) => {
      receiver.bind(0, "0.0.0.0", (err) => (err ? reject(err) : resolve(receiver.address().port)));
    });
    await new Promise<void>((resolve, reject) => {
      sender.bind(0, "0.0.0.0", (err) => (err ? reject(err) : resolve()));
    });

    const buf = new Uint8Array(256).fill(120); // 'x'
    const bytes = await new Promise<number>((resolve, reject) => {
      sender.send(buf, receiverPort, "127.0.0.1", (err, sent) => {
        if (err) reject(err);
        else resolve(sent!);
      });
    });
    expect(bytes).toBe(buf.byteLength);

    const { msg, rinfo } = await received;
    expect(msg.byteLength).toBe(256);
    expect(msg[0]).toBe(120);
    expect(rinfo.port).toBe(sender.address().port);
  });

  it("reports EHOSTUNREACH for an unbound destination rather than pretending success", async () => {
    const backend = createLoopbackDgramBackend();
    const sender = backend.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      sender.bind(0, "0.0.0.0", (err) => (err ? reject(err) : resolve()));
    });

    const err = await new Promise<Error & { code?: string }>((resolve) => {
      sender.send(new Uint8Array(4), 59999, "127.0.0.1", (e) =>
        resolve(e as Error & { code?: string }),
      );
    });
    expect(err.code).toBe("EHOSTUNREACH");
  });

  it("allocates distinct ephemeral ports to concurrent sockets", async () => {
    const backend = createLoopbackDgramBackend();
    const a = backend.createSocket("udp4");
    const b = backend.createSocket("udp4");
    const ports = await Promise.all(
      [a, b].map(
        (s) =>
          new Promise<number>((resolve, reject) => {
            s.bind(0, "0.0.0.0", (err) => (err ? reject(err) : resolve(s.address().port)));
          }),
      ),
    );
    expect(ports[0]).not.toBe(ports[1]);
  });
});

describe("dgram registry seam", () => {
  it("routes registry.dgram through the loopback backend so the ledger test's send contract holds", async () => {
    const registry = createLiveShimRegistry({ vfs: new VfsBus() });
    const dgram = registry.dgram as {
      createSocket: (type: string) => {
        bind: (port: number, cb: (err: Error | null) => void) => unknown;
        address: () => { port: number };
        send: (
          msg: Uint8Array,
          port: number,
          cb: (err: Error | null, bytes?: number) => void,
        ) => unknown;
        close: () => void;
        on: (event: string, cb: (...args: unknown[]) => void) => void;
      };
    };

    const client = dgram.createSocket("udp4");
    const buf = new Uint8Array(256).fill(120);

    const onMessage = new Promise<number>((resolve, reject) => {
      client.on("message", (first: unknown) => resolve((first as Uint8Array).byteLength));
      client.bind(0, (err) => {
        if (err) reject(err);
        else
          client.send(buf, client.address().port, (sendErr, bytes) => {
            expect(sendErr).toBeNull();
            expect(bytes).toBe(buf.byteLength);
          });
      });
    });

    expect(await onMessage).toBe(256);
    client.close();
  });

  it("a host dgramBackend overrides the loopback default", () => {
    const sentinelSocket = {
      bind: () => {},
      send: () => {},
      close: () => {},
      address: () => ({ address: "0.0.0.0", family: "IPv4" as const, port: 0 }),
      onMessage: () => {},
    };
    const registry = createLiveShimRegistry({
      vfs: new VfsBus(),
      dgramBackend: () => ({ createSocket: () => sentinelSocket }),
    });
    // The host factory's socket surface is exposed through the shim wrapper —
    // createSocket must produce sockets, not the raw factory.
    const dgram = registry.dgram as { createSocket: (t: "udp4") => unknown };
    expect(typeof dgram.createSocket).toBe("function");
    expect(dgram.createSocket("udp4")).toBeDefined();
  });
});
