import stream from "unenv/node/stream";
export * from "unenv/node/stream";

import { EventEmitter } from "./events.js";

/**
 * Minimal `stream.Stream` — the base class every Node stream inherits from.
 * Unlike unenv's `notImplementedClass` stub this is constructible and, more
 * importantly, usable as `util.inherits(ctor, Stream)`: CJS consumers like
 * `jws` do `var Stream = require('stream'); util.inherits(DataStream, Stream)`,
 * which only works when `module.exports` itself is a constructor.
 */
export class Stream extends EventEmitter {
  /**
   * `stream.pipe(dest[, opts])` — forwards `data`/`end` events into a writable
   * destination and returns it so calls can be chained.
   */
  pipe<T extends { write?: (chunk: unknown) => unknown; end?: () => unknown }>(
    dest: T,
    opts?: { end?: boolean },
  ): T {
    this.on("data", (chunk: unknown) => dest.write?.(chunk));
    if (opts?.end !== false) this.once("end", () => dest.end?.());
    return dest;
  }
}

/**
 * `node:stream` module shape. `module.exports` must be the `Stream`
 * constructor itself — everything else hangs off it as static properties —
 * so this is the class with the remaining unenv surface attached.
 */
export const createStreamShim = (): typeof stream & typeof Stream =>
  Object.assign(Stream, stream, { Stream }) as typeof stream & typeof Stream;

export default createStreamShim();
