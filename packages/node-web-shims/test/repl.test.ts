import { describe, it, expect } from "vitest";
import repl, { start, REPLServer } from "../src/repl.ts";

const memoryStream = () => {
  let buffer = "";
  return {
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    get buffer() {
      return buffer;
    },
    isTTY: false,
  };
};

describe("node-web-shims: repl", () => {
  it("start() returns a REPLServer with node defaults", async () => {
    const output = memoryStream();
    const r = start({ terminal: false, output });
    expect(r).toBeInstanceOf(REPLServer);
    expect(r.prompt).toBe("> ");
    expect(r.terminal).toBe(false);
    r.close();
    await Promise.resolve();
  });

  it("setupHistory succeeds asynchronously for a nonexistent file (test-repl-no-terminal)", async () => {
    const r = start({ terminal: false, output: memoryStream() });
    let sync = true;
    await new Promise<void>((resolve, reject) => {
      r.setupHistory("/nonexistent/file", (err, history) => {
        try {
          expect(sync).toBe(false);
          expect(err).toBeNull();
          expect(history).toBe("");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      sync = false;
    });
    r.close();
  });

  it("throw null/undefined neither crashes nor emits error (test-repl-throw-null-or-undefined)", () => {
    const output = memoryStream();
    const r = start({ terminal: false, output });
    let errorEmitted = false;
    let closed = false;
    r.on("error", () => {
      errorEmitted = true;
    });
    r.on("close", () => {
      closed = true;
    });

    expect(() => {
      r.write("throw null\n");
      r.write("throw undefined\n");
      r.write(".exit\n");
    }).not.toThrow();

    expect(errorEmitted).toBe(false);
    expect(closed).toBe(true);
  });

  it("evaluates lines against the context and writes results", () => {
    const output = memoryStream();
    const r = start({ terminal: false, output, context: { x: 21 } });
    r.write("x * 2\n");
    expect(output.buffer).toContain("42");
    r.write("'a' + 'b'\n");
    expect(output.buffer).toContain("'ab'");
    r.close();
  });

  it("prints non-null thrown errors and keeps reading", () => {
    const output = memoryStream();
    const r = start({ terminal: false, output });
    let errorEmitted = false;
    r.on("error", () => {
      errorEmitted = true;
    });
    r.write('throw new Error("boom")\n');
    expect(output.buffer).toContain("boom");
    expect(errorEmitted).toBe(false);
    r.write("1 + 1\n");
    expect(output.buffer).toContain("2");
    r.close();
  });

  it("unknown dot commands write 'Invalid REPL keyword'", () => {
    const output = memoryStream();
    const r = start({ terminal: false, output });
    r.write(".doesnotexist\n");
    expect(output.buffer).toContain("Invalid REPL keyword");
    r.close();
  });

  it("defineCommand registers dot commands", () => {
    const output = memoryStream();
    const r = start({ terminal: false, output });
    let ran = false;
    r.defineCommand("greet", {
      action() {
        ran = true;
      },
    });
    r.write(".greet\n");
    expect(ran).toBe(true);
    r.close();
  });

  it("ignoreUndefined suppresses undefined results", () => {
    const output = memoryStream();
    const r = start({ terminal: false, output, ignoreUndefined: true });
    r.write("undefined\n");
    expect(output.buffer).not.toContain("undefined");
    r.close();
  });

  it("produces no ANSI escapes with terminal: false", () => {
    const output = memoryStream();
    const r = start({ terminal: false, output });
    r.write("1 + 1\n");
    expect(output.buffer).not.toMatch(/\x1b\[/);
    r.close();
  });

  it("default export exposes start and REPLServer", () => {
    expect(repl.start).toBe(start);
    expect(repl.REPLServer).toBe(REPLServer);
  });
});
