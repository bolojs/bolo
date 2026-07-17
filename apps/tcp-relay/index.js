import { WebSocketServer } from "ws";
import { createConnection, createServer } from "net";
import { randomBytes } from "crypto";

const PORT = parseInt(process.env.RELAY_PORT ?? "9000");

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

const ZERO_CONNECTION_ID = "00000000";

const connections = new Map(); // connectionId → { ws, tcp, direction, host, port }
const listeners = new Map(); // ws → { server, port, host }
const ipConnections = new Map(); // ip → count

setInterval(() => ipConnections.clear(), 60_000).unref?.();

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  const ip = ws._socket?.remoteAddress;
  const count = ipConnections.get(ip) ?? 0;
  if (count > 10) {
    ws.close();
    return;
  }
  ipConnections.set(ip, count + 1);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Binary frame: [1-byte type][8-byte connId (ASCII hex)][payload...]
      const type = data[0];
      if (type === FRAME_TYPE.DATA) {
        // Fast path for data frames — connectionId is ASCII hex text, not raw bytes
        const connectionId = data.subarray(1, 9).toString("utf8");
        const payload = data.subarray(9);
        const conn = connections.get(connectionId);
        if (conn?.tcp) {
          conn.tcp.write(payload);
        }
        return;
      }
      // All other binary frame types: parse and dispatch via handleMessage
      try {
        const { type, connectionId, payload } = parseFrame(data);
        handleMessage(ws, type, connectionId, payload);
      } catch (e) {
        console.error("Invalid frame from browser:", e.message);
      }
      return;
    }
    try {
      const { type, connectionId, payload } = parseFrame(data);
      handleMessage(ws, type, connectionId, payload);
    } catch (e) {
      console.error("Invalid frame from browser:", e.message);
    }
  });

  ws.on("close", () => {
    for (const [id, conn] of connections) {
      if (conn.ws === ws) {
        conn.tcp?.destroy();
        connections.delete(id);
      }
    }
    const listener = listeners.get(ws);
    if (listener) {
      listener.server.close();
      listeners.delete(ws);
    }
  });
});

function handleMessage(ws, type, connectionId, payload) {
  switch (type) {
    case FRAME_TYPE.CONNECT: {
      let options;
      try {
        options = JSON.parse(payload.toString("utf8"));
      } catch (e) {
        console.error("Invalid connect payload:", e.message);
        return;
      }
      const tcp = createConnection(options.port, options.host);
      connections.set(connectionId, {
        ws,
        tcp,
        direction: "out",
        host: options.host,
        port: options.port,
      });
      attachTcp(ws, tcp, connectionId);
      tcp.on("connect", () => {
        ws.send(buildFrame(FRAME_TYPE.CONNECTED, connectionId, ""));
      });
      break;
    }
    case FRAME_TYPE.LISTEN: {
      let options;
      try {
        options = JSON.parse(payload.toString("utf8"));
      } catch (e) {
        console.error("Invalid listen payload:", e.message);
        return;
      }
      const server = createServer((tcpConn) => {
        const connId = generateId();
        connections.set(connId, {
          ws,
          tcp: tcpConn,
          direction: "in",
          host: tcpConn.remoteAddress,
          port: tcpConn.remotePort,
        });
        ws.send(buildFrame(FRAME_TYPE.ACCEPT, connId, JSON.stringify({
          remoteAddress: tcpConn.remoteAddress,
          remotePort: tcpConn.remotePort,
        })));
        attachTcp(ws, tcpConn, connId);
      });

      const listenPort = options.port ?? 0;
      const listenHost = options.host || "0.0.0.0";

      server.listen(listenPort, listenHost, () => {
        const addr = server.address();
        const assignedPort = typeof addr === "object" ? addr.port : listenPort;
        listeners.set(ws, { server, port: assignedPort, host: listenHost });
        ws.send(buildFrame(FRAME_TYPE.LISTENING, ZERO_CONNECTION_ID, ""));
      });

      server.on("error", (e) => {
        console.error("Listener error:", e.message);
        ws.send(buildFrame(FRAME_TYPE.ERROR, ZERO_CONNECTION_ID, JSON.stringify({
          code: e.code,
          syscall: e.syscall,
          address: e.address,
          port: e.port,
          message: e.message,
        })));
      });
      break;
    }
    case FRAME_TYPE.UNLISTEN: {
      const listener = listeners.get(ws);
      if (!listener) {
        console.warn("unlisten requested with no active listener");
        return;
      }
      for (const [id, conn] of connections) {
        if (conn.ws === ws && conn.direction === "in") {
          conn.tcp?.destroy();
          connections.delete(id);
        }
      }
      listener.server.close(() => {
        ws.send(buildFrame(FRAME_TYPE.UNLISTENED, ZERO_CONNECTION_ID, ""));
        listeners.delete(ws);
      });
      break;
    }
    case FRAME_TYPE.DATA: {
      const conn = connections.get(connectionId);
      if (conn?.tcp) {
        conn.tcp.write(payload);
      }
      break;
    }
    case FRAME_TYPE.CLOSE: {
      const conn = connections.get(connectionId);
      if (conn?.tcp) {
        // Half-close: send FIN to target but keep socket readable so
        // in-flight response data still flows back.
        conn.tcp.end();
      }
      break;
    }
    case FRAME_TYPE.DESTROY: {
      const conn = connections.get(connectionId);
      if (conn?.tcp) {
        // Full teardown: RST, do not wait for graceful shutdown.
        conn.tcp.destroy();
      }
      break;
    }
    default:
      console.warn("Unknown frame type:", type);
  }
}

function attachTcp(ws, tcp, connectionId) {
  tcp.on("data", (chunk) => {
    if (!connections.has(connectionId)) return;
    ws.send(buildFrame(FRAME_TYPE.DATA, connectionId, chunk));
  });

  tcp.on("close", () => {
    if (!connections.has(connectionId)) return;
    ws.send(buildFrame(FRAME_TYPE.CLOSE, connectionId, ""));
    connections.delete(connectionId);
  });

  tcp.on("error", (e) => {
    if (!connections.has(connectionId)) return;
    const err = {
      code: e.code,
      syscall: e.syscall,
      address: e.address,
      port: e.port,
      message: e.message,
    };
    try {
      ws.send(buildFrame(FRAME_TYPE.ERROR, connectionId, JSON.stringify(err)));
    } catch {}
    connections.delete(connectionId);
  });
}

function buildFrame(type, connectionId, payload) {
  if (!/^[0-9a-f]{8}$/i.test(connectionId)) {
    throw new Error("Invalid connectionId: must be 8 hex chars");
  }
  const idBytes = Buffer.from(connectionId, "utf8");
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const frame = Buffer.allocUnsafe(1 + 8 + payloadBuf.length);
  frame.writeUInt8(type, 0);
  idBytes.copy(frame, 1);
  payloadBuf.copy(frame, 9);
  return frame;
}

function parseFrame(buf) {
  if (buf.length < 9) throw new Error("Frame too short");
  const type = buf.readUInt8(0);
  const connectionId = buf.toString("utf8", 1, 9);
  if (!/^[0-9a-f]{8}$/i.test(connectionId)) {
    throw new Error("Invalid connectionId in frame");
  }
  const payload = buf.subarray(9);
  return { type, connectionId, payload };
}

function generateId() {
  return randomBytes(4).toString("hex");
}

console.log(`TCP relay listening on ws://localhost:${PORT}`);
console.log(`Supports: outbound connect, inbound listen`);
