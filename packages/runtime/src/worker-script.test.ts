import { describe, it, expect, vi, afterEach } from "vitest";
import type { RuntimeMessage } from "./runtime-worker.js";

describe("worker-script", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const loadWorker = async () => {
    const posted: RuntimeMessage[] = [];
    let handler: ((ev: { data: unknown }) => void) | null = null;

    const fakeSelf = {
      get onmessage() {
        return handler as unknown as ((ev: MessageEvent) => void) | null;
      },
      set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        handler = fn as unknown as ((ev: { data: unknown }) => void) | null;
      },
      postMessage: (msg: RuntimeMessage) => posted.push(msg),
    };

    vi.stubGlobal("self", fakeSelf);
    vi.stubGlobal("postMessage", fakeSelf.postMessage);
    vi.stubGlobal("setInterval", vi.fn(() => 0));

    vi.resetModules();
    await import("./worker-script.js?repl-test" as string);

    const dispatch = (data: unknown) => handler?.({ data } as { data: unknown });
    return { dispatch, posted };
  };

  it("routes host IPC messages to process.on('message') and sends replies via process.send", async () => {
    const { dispatch, posted } = await loadWorker();

    const runMsg: RuntimeMessage = {
      type: "RUN_SCRIPT",
      code: "process.on('message', (m) => process.send(m)); process.send('ready');",
      opts: {},
    };
    dispatch(runMsg);
    await new Promise((resolve) => setTimeout(resolve, 0));

    dispatch({ type: "IPC_MESSAGE", data: { hello: "world" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted).toContainEqual({ type: "IPC_MESSAGE", data: { hello: "world" } });
  });

  it("REPL evaluates an expression and returns the formatted value", async () => {
    const { dispatch, posted } = await loadWorker();

    dispatch({ type: "REPL_START" });
    dispatch({ type: "REPL_EVAL", id: "a", code: "1 + 1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted).toContainEqual({ type: "REPL_RESULT", id: "a", ok: true, value: "2" });
  });

  it("REPL continues on incomplete input", async () => {
    const { dispatch, posted } = await loadWorker();

    dispatch({ type: "REPL_START" });
    dispatch({ type: "REPL_EVAL", id: "a", code: "({" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted).toContainEqual({ type: "REPL_RESULT", id: "a", ok: true, continuation: true });

    dispatch({ type: "REPL_EVAL", id: "b", code: "a: 1" });
    dispatch({ type: "REPL_EVAL", id: "c", code: "})" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted).toContainEqual(expect.objectContaining({ type: "REPL_RESULT", id: "c", ok: true }));
  });

  it("REPL reports errors", async () => {
    const { dispatch, posted } = await loadWorker();

    dispatch({ type: "REPL_START" });
    dispatch({ type: "REPL_EVAL", id: "err", code: "throw new Error('boom')" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted).toContainEqual({ type: "REPL_RESULT", id: "err", ok: false, error: "Error: boom" });
  });
});
