// Browser-side window.electron replacement: tunnels ipcRenderer over WebSocket.
(() => {
  const url = `ws://${location.hostname}:5175`;
  let ws; const pending = new Map(); const listeners = new Map(); const queue = []; let id = 1;
  const open = new Promise((res) => {
    ws = new WebSocket(url);
    ws.onopen = () => { queue.splice(0).forEach((m) => ws.send(m)); res(); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === "res") { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); }
      else if (m.t === "evt") (listeners.get(m.channel) ?? []).forEach((l) => l(...m.args));
    };
  });
  const tx = (o) => { const s = JSON.stringify(o); ws.readyState === 1 ? ws.send(s) : queue.push(s); };
  const unwrap = (r) => (r && r.__dyadIpc ? r : r);
  window.__dyadShimReady = open;
  window.electron = {
    ipcRenderer: {
      invoke: (channel, ...args) => new Promise((resolve, reject) => { const i = id++; pending.set(i, { resolve, reject }); tx({ t: "invoke", id: i, channel, args }); }),
      invokeEnvelope: (channel, ...args) => window.electron.ipcRenderer.invoke(channel, ...args),
      send: (channel, ...args) => tx({ t: "send", channel, args }),
      on: (channel, l) => { listeners.set(channel, [...(listeners.get(channel) ?? []), l]); return () => window.electron.ipcRenderer.removeListener(channel, l); },
      removeListener: (channel, l) => listeners.set(channel, (listeners.get(channel) ?? []).filter((x) => x !== l)),
      removeAllListeners: (channel) => listeners.delete(channel),
    },
    webFrame: { setZoomFactor() {}, getZoomFactor: () => 1 },
  };
})();
