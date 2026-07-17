import { WebSocketServer } from "ws";
import { createConnection, createServer } from "net";
import { randomBytes } from "crypto";

const PORT = parseInt(process.env.RELAY_PORT ?? "9000");

// Message types for binary data frames
const MSG_DATA = 0x03;

const connections = new Map(); // connectionId (Buffer, 8 bytes) → { ws, tcp, direction, host, port }
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
      // Binary frame: [1-byte type][8-byte connId][payload...]
      const type = data[0];
      if (type === MSG_DATA) {
        const connectionId = data.subarray(1, 9);
        const payload = data.subarray(9);
        const conn = connections.get(connectionId.toString("hex"));
        if (conn?.tcp) {
          conn.tcp.write(payload);
        }
      }
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(ws, msg);
    } catch (e) {
      console.error("Invalid JSON from browser:", e.message);
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

function handleMessage(ws, msg) {
  switch (msg.type) {
    case "connect": {
      const connectionId = randomBytes(8);
      const idHex = connectionId.toString("hex");
      const tcp = createConnection(msg.port, msg.host, () => {
        connections.set(idHex, {
          ws,
          tcp,
          direction: "out",
          host: msg.host,
          port: msg.port,
        });
        ws.send(JSON.stringify({ type: "connected", connectionId: idHex }));
      });

      attachTcp(ws, tcp, connectionId);
      break;
    }
    case "listen": {
      const server = createServer((tcpConn) => {
        const connectionId = randomBytes(8);
        const idHex = connectionId.toString("hex");
        connections.set(idHex, {
          ws,
          tcp: tcpConn,
          direction: "in",
          host: tcpConn.remoteAddress,
          port: tcpConn.remotePort,
        });
        ws.send(JSON.stringify({
          type: "connection",
          connectionId: idHex,
          remoteAddress: tcpConn.remoteAddress,
          remotePort: tcpConn.remotePort,
        }));
        attachTcp(ws, tcpConn, connectionId);
      });

      const listenPort = msg.port ?? 0;
      const listenHost = msg.host || "0.0.0.0";

      server.listen(listenPort, listenHost, () => {
        const addr = server.address();
        const assignedPort = typeof addr === "object" ? addr.port : listenPort;
        listeners.set(ws, { server, port: assignedPort, host: listenHost });
        ws.send(JSON.stringify({ type: "listening", port: assignedPort, host: listenHost }));
      });

      server.on("error", (e) => {
        console.error("Listener error:", e.message);
        ws.send(JSON.stringify({ type: "error", message: `Listen failed: ${e.message}` }));
      });
      break;
    }
    case "unlisten": {
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
        ws.send(JSON.stringify({ type: "unlistened" }));
        listeners.delete(ws);
      });
      break;
    }
    case "close": {
      const conn = connections.get(msg.connectionId);
      if (conn) {
        // Half-close: send FIN to target but keep socket readable so
        // in-flight response data still flows back. The tcp "close"
        // event handler above sends {type:"close"} back to the browser
        // and cleans up when the target also closes.
        conn.tcp?.end();
      }
      break;
    }
    default:
      console.warn("Unknown message type:", msg.type);
  }
}

function attachTcp(ws, tcp, connectionId) {
  const idHex = connectionId.toString("hex");

  tcp.on("data", (chunk) => {
    if (!connections.has(idHex)) return;
    // Binary frame: [0x03][8-byte connId][payload]
    const frame = Buffer.alloc(9 + chunk.length);
    frame[0] = MSG_DATA;
    connectionId.copy(frame, 1);
    chunk.copy(frame, 9);
    ws.send(frame);
  });

  tcp.on("close", () => {
    if (!connections.has(idHex)) return;
    ws.send(JSON.stringify({ type: "close", connectionId: idHex }));
    connections.delete(idHex);
  });

  tcp.on("error", (e) => {
    console.error(`TCP error for ${idHex}:`, e.message);
    // Send structured error to browser so the pending connect promise resolves.
    // Browser will close the WS on receipt.
    ws.send(JSON.stringify({
      type: "error",
      connectionId: idHex,
      code: e.code ?? "ECONNREFUSED",
      syscall: e.syscall ?? "connect",
      address: e.address,
      port: e.port,
      message: e.message,
    }));
    connections.delete(idHex);
  });
}

console.log(`TCP relay listening on ws://localhost:${PORT}`);
console.log(`Supports: outbound connect, inbound listen`);
