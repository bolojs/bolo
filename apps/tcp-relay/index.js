import { WebSocketServer } from "ws";
import { createConnection } from "net";

const PORT = parseInt(process.env.RELAY_PORT ?? "9000");

const connections = new Map(); // connectionId → { ws, tcp, host, port }
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
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case "connect": {
      const connectionId = generateId();
      const tcp = createConnection(msg.port, msg.host, () => {
        connections.set(connectionId, { ws, tcp, host: msg.host, port: msg.port });
        ws.send(JSON.stringify({ type: "connected", connectionId }));
      });

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

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

console.log(`TCP relay listening on ws://localhost:${PORT}`);
console.log(`Outbound target example: node ${process.argv[1]} --port 9000`);
