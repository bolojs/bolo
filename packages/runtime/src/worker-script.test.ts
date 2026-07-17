import { describe, it, expect, vi, afterEach } from "vitest";
import type { RuntimeMessage } from "./runtime-worker.js";

describe("worker-script IPC", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes host IPC messages to process.on('message') and sends replies via process.send", async () => {
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
    await import("./worker-script.js?ipc-test" as string);

    const dispatch = (data: unknown) => handler?.({ data } as { data: unknown });

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
});
