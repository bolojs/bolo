import { createProcessShim } from "@bolojs/node-runtime-shims";
import type { ProcessShim } from "@bolojs/node-runtime-shims";
import type { RuntimeMessage, RunScriptOptions } from "./runtime-worker.js";

declare global {
  var __httpShimOptions: unknown | undefined;
}

type IPCProcessShim = ProcessShim & {
  send(message: unknown): boolean;
  disconnect(): void;
};

let activeProcess: IPCProcessShim | null = null;

const post = (msg: RuntimeMessage) => self.postMessage(msg);

const runUserCode = (code: string, opts: RunScriptOptions) => {
  if (opts.httpShimOptions) {
    __httpShimOptions = opts.httpShimOptions;
  }

  const processShim = createProcessShim({
    argv: ["node", opts.filename ?? "<anonymous>", ...(opts.args ?? [])],
  });
  const childProcess = processShim as IPCProcessShim;
  childProcess.send = (message: unknown) => {
    post({ type: "IPC_MESSAGE", data: message });
    return true;
  };
  childProcess.disconnect = () => {
    post({ type: "IPC_DISCONNECT" });
    childProcess.emit("disconnect");
  };
  (self as unknown as { process: IPCProcessShim }).process = childProcess;
  activeProcess = childProcess;

  const wrapped = `
    (function(process) {
      const originalLog = console.log;
      console.log = function(...args) {
        postMessage({ type: 'STDOUT', data: args.map(String).join(' ') });
        originalLog.apply(console, args);
      };
      ${code}
    })(self.process)
  `;
  try {
    // eslint-disable-next-line no-eval
    (0, eval)(wrapped);
    post({ type: "EXIT", code: 0 });
  } catch (err) {
    post({ type: "STDERR", data: String(err) });
    post({ type: "EXIT", code: 1 });
  }
};

setInterval(() => {
  post({ type: "HEARTBEAT" });
}, 5000);

self.onmessage = (ev: MessageEvent<RuntimeMessage>) => {
  const msg = ev.data;
  if (msg.type === "RUN_SCRIPT") {
    runUserCode(msg.code, msg.opts);
  } else if (msg.type === "IPC_MESSAGE") {
    activeProcess?.emit("message", msg.data);
  } else if (msg.type === "IPC_DISCONNECT") {
    activeProcess?.emit("disconnect");
  }
};
