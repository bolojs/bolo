import { describe, expect, it } from "vitest";
import {
  createSyncBuffer,
  createSyncServer,
  decodeResponse,
  encodeError,
  encodeResult,
  SyncCallError,
} from "./sync-channel.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sync-channel envelope", () => {
  it("round-trips arbitrary bytes including empty and binary", () => {
    for (const payload of [
      new Uint8Array(0),
      bytes("hello"),
      new Uint8Array([0, 1, 2, 255, 254, 0]),
      new Uint8Array(1024).fill(7),
    ]) {
      expect(decodeResponse(encodeResult(payload))).toEqual(payload);
    }
  });

  it("throws SyncCallError with the remote message on error envelope", () => {
    expect(() => decodeResponse(encodeError("ENOENT: no such file"))).toThrow(SyncCallError);
    expect(() => decodeResponse(encodeError("ENOENT: no such file"))).toThrow(
      "ENOENT: no such file",
    );
  });

  it("rejects empty responses", () => {
    expect(() => decodeResponse(new Uint8Array(0))).toThrow(SyncCallError);
  });
});

describe("sync-channel server (SAB write path)", () => {
  it("writes the enveloped response and publishes the seq", async () => {
    const server = createSyncServer({});
    const sab = createSyncBuffer(1024);
    server.attach("p1", (payload) => bytes(`echo:${text(payload)}`), { sab });

    const consumed = server.handleWorkerMessage("p1", {
      type: "BOLO_SYNC_REQ",
      pid: "p1",
      seq: 3,
      payload: bytes("hi"),
    });
    expect(consumed).toBe(true);
    await tick();

    const i32 = new Int32Array(sab);
    expect(i32[0]).toBe(3); // state = seq
    expect(i32[1]).toBe(1); // SAB_READY
    const len = i32[2];
    const raw = new Uint8Array(sab, 64, len);
    expect(text(decodeResponse(raw.slice()))).toBe("echo:hi");
  });

  it("envelopes handler errors for the worker to decode", async () => {
    const server = createSyncServer({});
    const sab = createSyncBuffer(1024);
    server.attach(
      "p1",
      () => {
        throw new Error("boom");
      },
      { sab },
    );
    server.handleWorkerMessage("p1", {
      type: "BOLO_SYNC_REQ",
      pid: "p1",
      seq: 1,
      payload: bytes("x"),
    });
    await tick();
    const i32 = new Int32Array(sab);
    const raw = new Uint8Array(sab, 64, i32[2]);
    expect(() => decodeResponse(raw.slice())).toThrow("boom");
  });

  it("flags TOO_BIG when the response exceeds buffer capacity", async () => {
    const server = createSyncServer({});
    const sab = createSyncBuffer(16);
    server.attach("p1", () => new Uint8Array(100).fill(1), { sab });
    server.handleWorkerMessage("p1", {
      type: "BOLO_SYNC_REQ",
      pid: "p1",
      seq: 9,
      payload: bytes("x"),
    });
    await tick();
    const i32 = new Int32Array(sab);
    expect(i32[0]).toBe(9);
    expect(i32[1]).toBe(2); // SAB_TOO_BIG
    expect(i32[2]).toBe(101); // needed length reported (enveloped: +1 status byte)
  });

  it("ignores non-sync messages and reports unknown pids", async () => {
    const server = createSyncServer({});
    expect(server.handleWorkerMessage("p1", { type: "STDOUT", data: "x" })).toBe(false);
    expect(server.handleWorkerMessage("p1", { type: "BOLO_SYNC_REQ", pid: "ghost", seq: 1 })).toBe(
      false,
    );
    server.attach("p1", () => bytes("ok"));
    expect(server.handleWorkerMessage("p1", { type: "BOLO_SYNC_REQ", pid: "p1", seq: 1 })).toBe(
      true,
    ); // consumed but dropped: no SAB, no Uint8Array payload
  });
});
