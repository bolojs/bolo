import { WebSocketServer } from "ws";
import { createConnection, createServer } from "net";

const PORT = parseInt(process.env.RELAY_PORT ?? "9000");

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
    if (!isBinary) return;
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
      const connectionId = generateId();
      const tcp = createConnection(msg.port, msg.host, () => {
        connections.set(connectionId, {
          ws,
          tcp,
          direction: "out",
          host: msg.host,
          port: msg.port,
        });
        ws.send(JSON.stringify({ type: "connected", connectionId }));
      });

      attachTcp(ws, tcp, connectionId);
      break;
    }
    case "listen": {
      const server = createServer((tcpConn) => {
        const connectionId = generateId();
        connections.set(connectionId, {
          ws,
          tcp: tcpConn,
          direction: "in",
          host: tcpConn.remoteAddress,
          port: tcpConn.remotePort,
        });
        ws.send(JSON.stringify({
          type: "connection",
          connectionId,
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
    case "data": {
      const conn = connections.get(msg.connectionId);
      if (conn?.tcp) {
        conn.tcp.write(Buffer.from(msg.bytes, "base64"));
      }
      break;
    }
    case "close": {
      const conn = connections.get(msg.connectionId);
      if (conn) {
        conn.tcp?.destroy();
        connections.delete(msg.connectionId);
      }
      break;
    }
    default:
      console.warn("Unknown message type:", msg.type);
  }
}

function attachTcp(ws, tcp, connectionId) {
  tcp.on("data", (chunk) => {
    if (!connections.has(connectionId)) return;
    ws.send(JSON.stringify({
      type: "data",
      connectionId,
      bytes: chunk.toString("base64"),
    }));
  });

  tcp.on("close", () => {
    if (!connections.has(connectionId)) return;
    ws.send(JSON.stringify({ type: "close", connectionId }));
    connections.delete(connectionId);
  });

  tcp.on("error", (e) => {
    console.error(`TCP error for ${connectionId}:`, e.message);
    connections.delete(connectionId);
  });
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

console.log(`TCP relay listening on ws://localhost:${PORT}`);
console.log(`Supports: outbound connect, inbound listen`);
