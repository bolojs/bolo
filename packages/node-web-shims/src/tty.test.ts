import { describe, expect, it } from "vitest";
import { createTtyShim } from "./tty.js";

describe("node:tty shim", () => {
  it("delegates cursorTo through the readline module, not a local copy", () => {
    const shim = createTtyShim();
    const stream = new shim.WriteStream(1);

    // The shim resolves readline lazily through the live registry, so a
    // monkey-patched helper is consulted — Node's lib/tty.js does the same
    // via its lazy `require('readline')`.
    const globals = globalThis as {
      __browserContainers?: { shims?: { readline?: Record<string, unknown> } };
    };
    const previous = globals.__browserContainers?.shims?.readline;
    const patched = {
      cursorTo: () => "patched-cursorTo",
      moveCursor: () => "patched-moveCursor",
      clearLine: () => "patched-clearLine",
      clearScreenDown: () => "patched-clearScreenDown",
    };
    globals.__browserContainers ??= {};
    globals.__browserContainers.shims ??= {};
    globals.__browserContainers.shims.readline = patched;

    try {
      expect(stream.cursorTo(1, 2)).toBe("patched-cursorTo");
      expect(stream.moveCursor(1, 2)).toBe("patched-moveCursor");
      expect(stream.clearLine(1)).toBe("patched-clearLine");
      expect(stream.clearScreenDown()).toBe("patched-clearScreenDown");
    } finally {
      if (previous === undefined) delete globals.__browserContainers.shims.readline;
      else globals.__browserContainers.shims.readline = previous;
    }
  });

  it("keeps a WriteStream constructible and reports isTTY", () => {
    const shim = createTtyShim();
    const stream = new shim.WriteStream(1);
    expect(stream.isTTY).toBe(true);
    expect(typeof stream.write).toBe("function");
  });

  it("isatty accepts integer fds and rejects the rest", () => {
    const shim = createTtyShim();
    // No tty_wrap binding in a bare realm: a browser container's stdio is
    // always piped, so every fd reports not-a-TTY (Node under a pipe).
    expect(shim.isatty(1)).toBe(false);
    expect(shim.isatty(0)).toBe(false);
    expect(shim.isatty(-1)).toBe(false);
    expect(shim.isatty(1.5)).toBe(false);
    expect(shim.isatty("1" as never)).toBe(false);
  });
});
