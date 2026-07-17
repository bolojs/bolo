import { test, describe } from "node:test";
import assert from "node:assert";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const relayPath = path.join(__dirname, "index.js");

const FRAME_TYPE = {
  CONNECT: 0x01,
  CONNECTED: 0x02,
  DATA: 0x03,
  CLOSE: 0x04,
  ERROR: 0x05,
  LISTEN: 0x06,
  LISTENING: 0x07,
  ACCEPT: 0x08,
  UNLISTEN: 0x09,
  UNLISTENED: 0x0a,
  DESTROY: 0x0b,
};

function generateId() {
  return randomBytes(4).toString("hex");
}

function buildFrame(type, connectionId, payload) {
  const idBytes = Buffer.from(connectionId, "utf8");
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const frame = Buffer.allocUnsafe(1 + 8 + payloadBuf.length);
  frame.writeUInt8(type, 0);
  idBytes.copy(frame, 1);
  payloadBuf.copy(frame, 9);
  return frame;
}

function parseFrame(buf) {
  const type = buf.readUInt8(0);
  const connectionId = buf.toString("utf8", 1, 9);
  const payload = buf.subarray(9);
  return { type, connectionId, payload };
}

function getPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function startRelay(port) {
  const proc = spawn(process.execPath, [relayPath], {
    cwd: __dirname,
    env: { ...process.env, RELAY_PORT: String(port) },
    stdio: "pipe",
  });
  await new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.stdout.once("data", () => resolve(undefined));
    setTimeout(() => reject(new Error("Relay failed to start")), 2000);
  });
  return proc;
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitFrame(ws) {
  return new Promise((resolve, reject) => {
    const onMsg = (buf, isBinary) => {
      if (!isBinary) return;
      try {
        const frame = parseFrame(buf);
        ws.off("message", onMsg);
        resolve(frame);
      } catch (e) {
        reject(e);
      }
    };
    ws.on("message", onMsg);
    setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error("Timeout waiting for frame"));
    }, 5000);
  });
}

function startBannerServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.write("HELLO\n");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" ? addr.port : 0 });
    });
    server.on("error", reject);
  });
}

function startEchoServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("data", (data) => socket.write(data));
      socket.on("end", () => socket.end());
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" ? addr.port : 0 });
    });
    server.on("error", reject);
  });
}

describe("tcp relay", { concurrency: false }, () => {
  test("server-first banner is captured", async () => {
    const { server: target, port: targetPort } = await startBannerServer();
    const relayPort = await getPort();
    const relay = await startRelay(relayPort);
    let ws;
    try {
      ws = await connectWs(relayPort);
      const connectionId = generateId();
      ws.send(buildFrame(FRAME_TYPE.CONNECT, connectionId, JSON.stringify({ host: "127.0.0.1", port: targetPort })));

      const connected = await waitFrame(ws);
      assert.strictEqual(connected.type, FRAME_TYPE.CONNECTED);
      assert.strictEqual(connected.connectionId, connectionId);

      const data = await waitFrame(ws);
      assert.strictEqual(data.type, FRAME_TYPE.DATA);
      assert.strictEqual(data.payload.toString(), "HELLO\n");

      ws.send(buildFrame(FRAME_TYPE.CLOSE, connectionId, ""));
      await waitFrame(ws); // consume close

    } finally {
      ws?.close();
      target.close();
      relay.kill();
      await new Promise((r) => relay.once("exit", r));
    }
  });

  test("connection refused is propagated as error frame", async () => {
    const relayPort = await getPort();
    const relay = await startRelay(relayPort);
    let ws;
    try {
      ws = await connectWs(relayPort);
      const connectionId = generateId();
      ws.send(buildFrame(FRAME_TYPE.CONNECT, connectionId, JSON.stringify({ host: "127.0.0.1", port: 1 })));

      const frame = await waitFrame(ws);
      assert.strictEqual(frame.type, FRAME_TYPE.ERROR);
      assert.strictEqual(frame.connectionId, connectionId);
      const err = JSON.parse(frame.payload.toString("utf8"));
      assert.strictEqual(err.code, "ECONNREFUSED");
    } finally {
      ws?.close();
      relay.kill();
      await new Promise((r) => relay.once("exit", r));
    }
  });

  test("frame type audit for connect/data/close", async () => {
    const { server: target, port: targetPort } = await startEchoServer();
    const relayPort = await getPort();
    const relay = await startRelay(relayPort);
    let ws;
    try {
      ws = await connectWs(relayPort);
      const connectionId = generateId();
      ws.send(buildFrame(FRAME_TYPE.CONNECT, connectionId, JSON.stringify({ host: "127.0.0.1", port: targetPort })));

      const connected = await waitFrame(ws);
      assert.strictEqual(connected.type, FRAME_TYPE.CONNECTED);
      assert.strictEqual(connected.connectionId, connectionId);

      ws.send(buildFrame(FRAME_TYPE.DATA, connectionId, Buffer.from("PING")));
      const data = await waitFrame(ws);
      assert.strictEqual(data.type, FRAME_TYPE.DATA);
      assert.strictEqual(data.connectionId, connectionId);
      assert.strictEqual(data.payload.toString(), "PING");

      ws.send(buildFrame(FRAME_TYPE.CLOSE, connectionId, ""));
      const close = await waitFrame(ws);
      assert.strictEqual(close.type, FRAME_TYPE.CLOSE);
      assert.strictEqual(close.connectionId, connectionId);
    } finally {
      ws?.close();
      target.close();
      relay.kill();
      await new Promise((r) => relay.once("exit", r));
    }
  });
});
