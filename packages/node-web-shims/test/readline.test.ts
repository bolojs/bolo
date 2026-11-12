import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createReadlineShim, createInterface, Interface } from "../src/readline.ts";

/**
 * Minimal port of node:test's common/arraystream — a Duplex-ish collector
 * with no-op pause/resume/write that tests can replace.
 */
class ArrayStream extends EventEmitter {
  readable = true;
  writable = true;
  pause(): void {}
  resume(): void {}
  write(): boolean {
    return true;
  }
}

describe("node-web-shims: readline", () => {
  it("should match node:readline type shape", () => {
    const shim = createReadlineShim();
    const _nodeReadline: typeof import("node:readline") = shim;
    expect(_nodeReadline).toBeDefined();
  });

  // Verbatim port of node v22.0.0 test-readline-interface-no-trailing-newline.js
  it("terminal interface echoes written data back to output (#47305)", () => {
    const rli = new Interface({
      terminal: true,
      input: new ArrayStream(),
      output: new ArrayStream(),
    });

    const testInput = "{\n}";

    let accum = "";
    (rli.output as unknown as { write: (data: string) => void }).write = (data) => {
      accum += data.replace("\r", "");
    };

    rli.write(testInput);

    expect(accum).toBe(testInput);
  });

  // Verbatim port of node v22.0.0 test-readline-carriage-return-between-chunks.js
  it("crlfDelay:Infinity never emits a line containing \\r across chunks", async () => {
    const input = Readable.from(
      (function* () {
        yield "a\nb";
        yield "\r\n";
      })(),
    );
    const rl = createInterface({ input, crlfDelay: Infinity });
    let carriageReturns = 0;
    const lines: string[] = [];

    rl.on("line", (line) => {
      lines.push(line);
      if (line.includes("\r")) carriageReturns++;
    });

    await new Promise<void>((resolve) => rl.on("close", resolve));

    expect(carriageReturns).toBe(0);
    expect(lines).toEqual(["a", "b"]);
  });

  // Verbatim port of node v22.0.0 test-readline-interface-recursive-writes.js
  it("recursive writes from a 'line' handler are queued, not recursed (#46731)", () => {
    const rli = new Interface({
      terminal: true,
      input: new ArrayStream(),
    });

    let recursionDepth = 0;

    const testInput = " \n}\n";
    const numberOfExpectedLines = testInput.match(/\n/g)?.length ?? 0;

    rli.on("line", () => {
      // Abort in case of infinite loop
      if (recursionDepth > numberOfExpectedLines) {
        return;
      }
      recursionDepth++;
      // Write something recursively to readline
      rli.write("foo");
    });

    rli.write(testInput);

    expect(recursionDepth).toBe(numberOfExpectedLines);
  });

  it("emits the trailing unterminated line on close", async () => {
    const input = Readable.from(["partial"]);
    const rl = createInterface({ input });
    const lines: string[] = [];
    rl.on("line", (line) => lines.push(line));
    await new Promise<void>((resolve) => rl.on("close", resolve));
    expect(lines).toEqual(["partial"]);
  });
});
