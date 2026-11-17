import { describe, it, expect, vi, afterEach } from "vitest";
import type { RuntimeMessage } from "./runtime-worker.js";

// The worker module pulls in the whole node-runtime-shims graph, so the first
// dynamic import of a suite can take seconds when the machine is busy (CI runs
// every package in parallel). Give each test headroom instead of letting the
// default 5s budget decide the outcome.
const TEST_TIMEOUT = 30_000;

// Poll until `predicate` holds instead of assuming a single macrotask tick is
// enough: the worker posts its messages asynchronously and a `setTimeout(0)`
// can land before the message is queued under load.
const waitFor = async (predicate: () => boolean, timeoutMs = TEST_TIMEOUT) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

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
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    vi.stubGlobal("self", fakeSelf);
    vi.stubGlobal("postMessage", fakeSelf.postMessage);
    vi.stubGlobal(
      "setInterval",
      vi.fn(() => 0),
    );

    vi.resetModules();
    await import("./worker-script.js?repl-test" as string);

    const dispatch = (data: unknown) => handler?.({ data } as { data: unknown });
    return { dispatch, posted };
  };

  it(
    "routes host IPC messages to process.on('message') and sends replies via process.send",
    async () => {
      const { dispatch, posted } = await loadWorker();

      const runMsg: RuntimeMessage = {
        type: "RUN_SCRIPT",
        code: "process.on('message', (m) => process.send(m)); process.send('ready');",
        opts: {},
      };
      dispatch(runMsg);
      await waitFor(() => posted.some((m) => m.type === "IPC_MESSAGE" && m.data === "ready"));

      dispatch({ type: "IPC_MESSAGE", data: { hello: "world" } });
      await waitFor(() =>
        posted.some(
          (m) => m.type === "IPC_MESSAGE" && (m.data as { hello?: string })?.hello === "world",
        ),
      );

      expect(posted).toContainEqual({ type: "IPC_MESSAGE", data: { hello: "world" } });
    },
    TEST_TIMEOUT,
  );

  it(
    "REPL evaluates an expression and returns the formatted value",
    async () => {
      const { dispatch, posted } = await loadWorker();

      dispatch({ type: "REPL_START" });
      dispatch({ type: "REPL_EVAL", id: "a", code: "1 + 1" });
      await waitFor(() => posted.some((m) => m.type === "REPL_RESULT" && m.id === "a"));

      expect(posted).toContainEqual({ type: "REPL_RESULT", id: "a", ok: true, value: "2" });
    },
    TEST_TIMEOUT,
  );

  it(
    "REPL continues on incomplete input",
    async () => {
      const { dispatch, posted } = await loadWorker();

      dispatch({ type: "REPL_START" });
      dispatch({ type: "REPL_EVAL", id: "a", code: "({" });
      await waitFor(() => posted.some((m) => m.type === "REPL_RESULT" && m.id === "a"));

      expect(posted).toContainEqual({ type: "REPL_RESULT", id: "a", ok: true, continuation: true });

      dispatch({ type: "REPL_EVAL", id: "b", code: "a: 1" });
      dispatch({ type: "REPL_EVAL", id: "c", code: "})" });
      await waitFor(() => posted.some((m) => m.type === "REPL_RESULT" && m.id === "c"));

      expect(posted).toContainEqual(
        expect.objectContaining({ type: "REPL_RESULT", id: "c", ok: true }),
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "REPL reports errors",
    async () => {
      const { dispatch, posted } = await loadWorker();

      dispatch({ type: "REPL_START" });
      dispatch({ type: "REPL_EVAL", id: "err", code: "throw new Error('boom')" });
      await waitFor(() => posted.some((m) => m.type === "REPL_RESULT" && m.id === "err"));

      expect(posted).toContainEqual({
        type: "REPL_RESULT",
        id: "err",
        ok: false,
        error: "Error: boom",
      });
    },
    TEST_TIMEOUT,
  );
});
