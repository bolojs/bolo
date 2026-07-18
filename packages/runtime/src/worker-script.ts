import { configureBrowserLogging, getLogger } from "@bolojs/log/browser";
import { createProcessShim } from "@bolojs/node-runtime-shims";
import type { ProcessShim } from "@bolojs/node-runtime-shims";
import type { RuntimeMessage, RunScriptOptions } from "./runtime-worker.js";

await configureBrowserLogging();
const logger = getLogger(["bolo", "runtime", "worker"]);

declare global {
  var __httpShimOptions: unknown | undefined;
}

type IPCProcessShim = ProcessShim & {
  send(message: unknown): boolean;
  disconnect(): void;
};

let activeProcess: IPCProcessShim | null = null;
let replActive = false;
let replCodeBuffer = "";

const post = (msg: RuntimeMessage) => self.postMessage(msg);

const isComplete = (buf: string): boolean => {
  // ponytail: `new Function(buf)` wraps buf in its own `{ }`, so an unclosed
  // brace in buf silently pairs with the wrapper's closing brace instead of
  // surfacing as "unexpected end of input" — pre-check raw bracket balance.
  const opens = (buf.match(/[{([]/g) || []).length;
  const closes = (buf.match(/[)}\]]/g) || []).length;
  if (opens > closes) return false;
  try {
    new Function(buf);
    return true;
  } catch (e) {
    return !/end of input|unexpected end|unterminated/i.test((e as SyntaxError).message);
  }
};

const formatValue = (v: unknown): string => {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "function") return v.toString();
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
};

const runUserCode = (code: string, opts: RunScriptOptions) => {
  logger.debug("RUN_SCRIPT received", { filename: opts.filename, args: opts.args });

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
    logger.info("EXIT", { code: 0 });
    post({ type: "EXIT", code: 0 });
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? String(err)) : String(err);
    logger.error("Uncaught error in user code", { error: message });
    post({ type: "STDERR", data: String(err) });
    logger.info("EXIT", { code: 1 });
    post({ type: "EXIT", code: 1 });
  }
};

setInterval(() => {
  post({ type: "HEARTBEAT" });
}, 5000);

self.addEventListener("error", (ev: ErrorEvent) => {
  const error =
    ev.error instanceof Error ? (ev.error.stack ?? String(ev.error)) : String(ev.message);
  logger.error("Uncaught worker error", {
    message: ev.message,
    filename: ev.filename,
    lineno: ev.lineno,
    error,
  });
  post({ type: "STDERR", data: error });
});

self.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
  const reason =
    ev.reason instanceof Error ? (ev.reason.stack ?? String(ev.reason)) : String(ev.reason);
  logger.error("Unhandled worker rejection", { reason });
  post({ type: "STDERR", data: reason });
});

self.onmessage = (ev: MessageEvent<RuntimeMessage>) => {
  const msg = ev.data;
  if (msg.type === "REPL_START") {
    replActive = true;
    replCodeBuffer = "";
    return;
  }
  if (msg.type === "REPL_EXIT") {
    replActive = false;
    replCodeBuffer = "";
    return;
  }
  if (msg.type === "REPL_EVAL") {
    const { id, code } = msg;
    replCodeBuffer += code + "\n";
    if (!isComplete(replCodeBuffer)) {
      post({ type: "REPL_RESULT", id, ok: true, continuation: true });
      return;
    }
    const fullCode = replCodeBuffer.trim();
    replCodeBuffer = "";

    let result: unknown;
    let error: string | undefined;
    const originalLog = console.log;
    console.log = function (...args: unknown[]) {
      post({ type: "STDOUT", data: args.map(String).join(" ") });
      originalLog.apply(console, args);
    };
    try {
      // ponytail: expression-first heuristic; matches node REPL UX without a parser dep
      try {
        result = (0, eval)(`(${fullCode})`);
      } catch {
        result = (0, eval)(fullCode);
      }
    } catch (e) {
      error = String(e);
    } finally {
      console.log = originalLog;
    }
    post({
      type: "REPL_RESULT",
      id,
      ok: !error,
      value: error ? undefined : formatValue(result),
      error,
    });
    return;
  }
  if (msg.type === "RUN_SCRIPT") {
    runUserCode(msg.code, msg.opts);
  } else if (msg.type === "IPC_MESSAGE") {
    activeProcess?.emit("message", msg.data);
  } else if (msg.type === "IPC_DISCONNECT") {
    activeProcess?.emit("disconnect");
  }
};
