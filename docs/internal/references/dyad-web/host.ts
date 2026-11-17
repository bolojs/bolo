import { WebSocketServer } from "ws";
import { channelHandlers, channelListeners, senders } from "./electron-stub";
import { configureTrustedRenderer } from "../src/ipc/utils/renderer_security";
import { registerIpcHandlers } from "../src/ipc/ipc_host";
import { initializeDatabase } from "../src/db";

const WEB_ORIGIN = process.env.DYAD_WEB_ORIGIN ?? "http://localhost:5174";
const PORT = Number(process.env.DYAD_WEB_WS_PORT ?? 5175);

configureTrustedRenderer({ devServerUrl: WEB_ORIGIN, packagedRendererUrl: "file:///dyad/index.html" });
initializeDatabase();
registerIpcHandlers();
console.log(`[host] ${channelHandlers.size} invoke handlers, ${channelListeners.size} send listeners`);

const wss = new WebSocketServer({ port: PORT });
let nextId = 1;
wss.on("connection", (ws) => {
  const frame: any = { url: WEB_ORIGIN + "/", processId: 1, routingId: 1, parent: null };
  const sender: any = {
    id: nextId++, mainFrame: frame,
    send: (channel: string, ...args: unknown[]) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "evt", channel, args })),
    isDestroyed: () => ws.readyState !== 1,
    getURL: () => frame.url,
    on() {}, once() {}, off() {}, removeListener() {},
    setZoomFactor() {}, session: {}, hostWebContents: null,
  };
  senders.add(sender);
  const event = { sender, senderFrame: frame, processId: 1, frameId: 1 };
  ws.on("close", () => senders.delete(sender));
  ws.on("message", async (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === "invoke") {
      const h = channelHandlers.get(m.channel);
      try {
        if (!h) throw new Error(`No handler for channel ${m.channel}`);
        const result = await h(event, ...(m.args ?? []).map((a: unknown) => (a === null ? undefined : a)));
        ws.send(JSON.stringify({ t: "res", id: m.id, result }));
      } catch (e: any) {
        ws.send(JSON.stringify({ t: "res", id: m.id, error: String(e?.message ?? e) }));
      }
    } else if (m.t === "send") {
      for (const l of channelListeners.get(m.channel) ?? []) l(event, ...(m.args ?? []));
    }
  });
});
console.log(`[host] ws://localhost:${PORT}`);
