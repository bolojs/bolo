import { EventEmitter } from "node:events";
import readline from "unenv/node/readline";

export * from "unenv/node/readline";

/** Minimal structural shape of the input stream readline consumes. */
export interface ReadableLike {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  pause?: () => unknown;
  resume?: () => unknown;
}

/** Minimal structural shape of the output stream readline echoes to. */
export interface WritableLike {
  write(chunk: string): unknown;
}

export interface InterfaceOptions {
  input: ReadableLike;
  output?: WritableLike;
  terminal?: boolean;
  crlfDelay?: number;
}

/**
 * A dependency-free `readline.Interface`. unenv's stub splits no lines, never
 * echoes to the output, and swallows writes. This implementation covers the
 * streaming semantics Node's test suite asserts:
 *
 * - line splitting on `\n` / `\r\n`, safe when a chunk boundary falls between
 *   `\r` and `\n` (with `crlfDelay: Infinity` a trailing `\r` waits for the
 *   next chunk indefinitely, so no 'line' event ever contains `\r`),
 * - terminal echo: `write(data)` writes the data back to `output` (newline
 *   rendered as `\r\n`),
 * - re-entrant-safe `write()`: a 'line' handler may call `write()` again; the
 *   new data is queued and drained by the active loop instead of recursing.
 */
export class Interface extends EventEmitter {
  readonly terminal: boolean;
  readonly input: ReadableLike;
  readonly output: WritableLike | undefined;
  line = "";
  cursor = 0;

  private promptText = "";
  private buffer = "";
  private processing = false;
  private closed = false;
  private readonly crlfDelay: number;

  constructor(options: InterfaceOptions) {
    super();
    this.input = options.input;
    this.output = options.output;
    this.terminal = options.terminal === true;
    this.crlfDelay = options.crlfDelay ?? 100;
    this.input.on("data", (chunk) => {
      this.write(String(chunk));
    });
    this.input.on("end", () => {
      this.close();
    });
    this.input.resume?.();
  }

  /** Index of the next line terminator in the buffer, or -1 to wait for more. */
  private nextBreak(): { index: number; skip: number } | null {
    const buf = this.buffer;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (ch === "\n") return { index: i, skip: 1 };
      if (ch === "\r") {
        if (i + 1 < buf.length) {
          // \r\n pair, or a lone \r already followed by data.
          return { index: i, skip: buf[i + 1] === "\n" ? 2 : 1 };
        }
        // Trailing \r: wait for the rest of the pair only with an infinite delay.
        if (this.crlfDelay !== Infinity) return { index: i, skip: 1 };
        return null;
      }
    }
    return null;
  }

  write(data: unknown, _key?: unknown): boolean {
    if (this.closed) return false;
    const text = String(data);
    if (this.processing) {
      // Re-entrant write from a 'line' handler: the active loop drains this.
      this.buffer += text;
      return true;
    }
    if (this.terminal && this.output) {
      this.output.write(text.replace(/\r?\n/g, "\r\n"));
    }
    this.buffer += text;
    this.processing = true;
    try {
      let br = this.nextBreak();
      while (br !== null) {
        const line = this.buffer.slice(0, br.index);
        this.buffer = this.buffer.slice(br.index + br.skip);
        this.line = line;
        this.cursor = line.length;
        this.emit("line", line);
        br = this.nextBreak();
      }
    } finally {
      this.processing = false;
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      this.line = line;
      this.emit("line", line);
    }
    this.emit("close");
  }

  getPrompt(): string {
    return this.promptText;
  }

  setPrompt(prompt: string): void {
    this.promptText = prompt;
  }

  prompt(_preserveCursor?: boolean): void {
    if (this.output) {
      this.output.write(`${this.promptText}${this.line}`);
    }
  }

  question(query: string, optionsOrCallback?: unknown, callback?: (answer: string) => void): void {
    const cb =
      typeof optionsOrCallback === "function"
        ? (optionsOrCallback as (answer: string) => void)
        : callback;
    this.once("line", (line: string) => {
      cb?.(line);
    });
    if (this.output) {
      this.output.write(query);
    }
  }

  pause(): this {
    this.input.pause?.();
    return this;
  }

  resume(): this {
    this.input.resume?.();
    return this;
  }

  getCursorPos(): { rows: number; cols: number } {
    return { rows: 0, cols: this.line.length };
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    const queue: string[] = [];
    let notify: (() => void) | undefined;
    let done = this.closed;
    this.on("line", (line: string) => {
      queue.push(line);
      notify?.();
    });
    this.on("close", () => {
      done = true;
      notify?.();
    });
    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      while (queue.length > 0) {
        yield queue.shift() as string;
      }
    }
  }
}

export const createInterface = (options: InterfaceOptions): Interface => new Interface(options);

/**
 * Creates a node:readline shim. Keeps unenv's `clearLine`/`cursorTo`/…
 * helpers but replaces the inert `Interface` stub with the real
 * line-splitting implementation above.
 */
export const createReadlineShim = (): typeof readline =>
  ({ ...readline, Interface, createInterface }) as unknown as typeof readline;

export default createReadlineShim();
