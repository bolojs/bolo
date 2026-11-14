import tty from "unenv/node/tty";
import readline from "unenv/node/readline";
import { Interface as ReadlineInterface, createInterface } from "./readline.js";

export * from "unenv/node/tty";

/**
 * `node:tty` — unenv's WriteStream implements cursorTo/moveCursor/clearLine/
 * clearScreenDown directly, but Node routes them through the readline module
 * (`lib/tty.js` lazily requires readline and calls `readline.cursorTo(this, …)`,
 * which in turn calls `stream.write(CSI, callback)`). Tests monkey-patch
 * `readline.cursorTo` and expect tty.WriteStream to consult the patched
 * function, so the delegation must go through the live module object —
 * resolved on every call, not captured once.
 *
 * Node also builds the stream's handle through the tty_wrap binding
 * (`internalBinding('tty_wrap').TTY`). A host that can provide the binding
 * publishes it on `__browserContainers.ttyWrap`; where it is absent the
 * WriteStream degrades to a plain stream — a browser has no file
 * descriptors, so there is no handle to allocate.
 */
interface TtyWrapBinding {
  /** libuv `uv_tty_t` constructor — Node calls `new TTY(fd, ctx)`. */
  TTY?: new (fd: number, ctx?: { code?: number }) => unknown;
  /** Node's `isTTY(fd)` — truthiness decides `tty.isatty`. */
  isTTY?: (fd: number) => boolean;
}

const ttyWrapBinding = (): TtyWrapBinding | undefined =>
  (globalThis as { __browserContainers?: { ttyWrap?: TtyWrapBinding } }).__browserContainers
    ?.ttyWrap;

/** The readline surface tty.WriteStream delegates to. */
export interface ReadlineHelpers {
  cursorTo(stream: unknown, x: number, y?: number | (() => void), callback?: () => void): unknown;
  moveCursor(stream: unknown, dx: number, dy: number, callback?: () => void): unknown;
  clearLine(stream: unknown, dir: number, callback?: () => void): unknown;
  clearScreenDown(stream: unknown, callback?: () => void): unknown;
}

const lazyReadline = (): ReadlineHelpers => {
  const mod = globalThis as {
    __browserContainers?: { shims?: { readline?: ReadlineHelpers } };
  };
  // Live registry first (a bundled program patches the module object it
  // sees, so the helper must re-read the same object each call), then the
  // module-level copy — the unenv stubs plus the real Interface.
  return (
    mod.__browserContainers?.shims?.readline ??
    ({ ...readline, Interface: ReadlineInterface, createInterface } as unknown as ReadlineHelpers)
  );
};

/**
 * Node's `lib/tty.js` WriteStream: validates the fd and delegates the cursor
 * helpers to readline (late-bound so monkey-patches are visible). The helpers
 * resolve `readline` through the live registry so
 * `require('readline').cursorTo = …` from a bundled program is picked up on
 * the next call — that late binding is the whole point of Node's lazy
 * `require('readline')`.
 */
export class WriteStream extends tty.WriteStream {
  constructor(fd: number) {
    super(fd);
    this.isTTY = true;
  }
}

// Node resolves the helper through the live readline module each call. Note
// the prototype methods must stay enumerable own-properties of the class:
// the bundler re-exports instance surface via Object.keys on the shim, same
// as unenv's prototype does.
WriteStream.prototype.cursorTo = function cursorTo(
  this: WriteStream,
  x: number,
  y?: number | (() => void),
  callback?: () => void,
): boolean {
  return lazyReadline().cursorTo(this, x, y, callback) as boolean;
};

WriteStream.prototype.moveCursor = function moveCursor(
  this: WriteStream,
  dx: number,
  dy: number,
  callback?: () => void,
): boolean {
  return lazyReadline().moveCursor(this, dx, dy, callback) as boolean;
};

WriteStream.prototype.clearLine = function clearLine(
  this: WriteStream,
  dir: number,
  callback?: () => void,
): boolean {
  return lazyReadline().clearLine(this, dir, callback) as boolean;
};

WriteStream.prototype.clearScreenDown = function clearScreenDown(
  this: WriteStream,
  callback?: () => void,
): boolean {
  return lazyReadline().clearScreenDown(this, callback) as boolean;
};

/**
 * Node's `isatty(fd)`: integer fd in [0, 2^31-1] that the binding reports as
 * a TTY. Without a binding every fd reports not-a-TTY — a browser container's
 * stdio is always piped, never a terminal (matches Node run under a pipe).
 */
export const isatty = (fd: number): boolean => {
  if (!Number.isInteger(fd) || fd < 0 || fd > 2147483647) return false;
  return ttyWrapBinding()?.isTTY?.(fd) ?? false;
};

/**
 * Creates a node:tty shim — unenv's ReadStream plus the readline-delegating
 * WriteStream and a binding-aware isatty.
 */
export const createTtyShim = (): typeof tty & {
  WriteStream: typeof WriteStream;
  isatty: typeof isatty;
} => {
  const base = tty as unknown as Record<string, unknown>;
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    WriteStream,
    isatty,
  }) as typeof tty & {
    WriteStream: typeof WriteStream;
    isatty: typeof isatty;
  };
};

export default createTtyShim();
