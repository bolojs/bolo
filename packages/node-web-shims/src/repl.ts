import { createEventsShim } from "./events.js";

const { EventEmitter } = createEventsShim();

/**
 * node:repl shim — minimal but real.
 *
 * `start()` returns a REPLServer that evaluates each complete line written
 * to it against a plain `context` object (compiled with `new Function`;
 * node:vm is not available in the browser). Non-fatal semantics follow
 * node: throwing `null`/`undefined` from evaluated code neither crashes nor
 * emits 'error'; other thrown values are rendered to the output stream and
 * the REPL keeps reading. With `terminal: false` no ANSI sequences are ever
 * written.
 */

export interface ReplOptions {
  prompt?: string;
  input?: { write?(chunk: string): unknown; pause?(): unknown; resume?(): unknown } | undefined;
  output?: { write(chunk: string): unknown; isTTY?: boolean } | undefined;
  terminal?: boolean;
  ignoreUndefined?: boolean;
  context?: Record<string, unknown>;
  promptCallback?: (p: string) => string;
}

export const REPL_MODE_SLOPPY = Symbol("repl-sloppy");
export const REPL_MODE_STRICT = Symbol("repl-strict");

interface ReplCommand {
  action: (this: REPLServer, text: string) => void;
  help?: string;
}

const formatValue = (value: unknown): string => {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
  if (value instanceof Error) return value.stack ?? String(value);
  try {
    return String(value);
  } catch {
    return "[unformattable]";
  }
};

/** node:repl `writer` default — renders an evaluation result. */
export const writer = (value: unknown): string => formatValue(value);

/** Stub for parity with node:repl's Recoverable (parser-retry marker). */
export class Recoverable extends Error {
  err: Error;
  constructor(err: Error, options?: ErrorOptions) {
    super(err.message, options);
    this.err = err;
  }
}

export class REPLServer extends EventEmitter {
  readonly context: Record<string, unknown>;
  readonly options: ReplOptions;
  readonly prompt: string;
  readonly terminal: boolean;
  readonly input: ReplOptions["input"];
  readonly output: ReplOptions["output"];
  readonly commands: Record<string, ReplCommand> = {};

  #lineBuffer = "";
  #closed = false;

  constructor(options: ReplOptions = {}) {
    super();
    this.options = options;
    const proc = (
      globalThis as { process?: { stdin?: ReplOptions["input"]; stdout?: ReplOptions["output"] } }
    ).process;
    this.input = options.input ?? proc?.stdin;
    this.output = options.output ?? proc?.stdout;
    this.prompt = options.prompt ?? "> ";
    this.terminal = options.terminal ?? !!this.output?.isTTY;
    this.ignoreUndefined = options.ignoreUndefined ?? false;
    this.context = options.context ?? {};
    this.defineCommand("help", {
      help: "Print this help message",
      action: () => {
        const names = Object.keys(this.commands).sort();
        this.output?.write(`${names.join("\n")}\n`);
        this.displayPrompt();
      },
    });
    queueMicrotask(() => this.displayPrompt());
  }

  ignoreUndefined: boolean;

  /** Feed input into the REPL; every complete `\n`-terminated line is evaluated. */
  write(chunk: string | Uint8Array): boolean {
    this.#lineBuffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    let newlineIndex: number;
    while ((newlineIndex = this.#lineBuffer.indexOf("\n")) !== -1) {
      const line = this.#lineBuffer.slice(0, newlineIndex);
      this.#lineBuffer = this.#lineBuffer.slice(newlineIndex + 1);
      this.#processLine(line.replace(/\r$/, ""));
      if (this.#closed) break;
    }
    return true;
  }

  displayPrompt(): void {
    if (!this.#closed) this.output?.write(this.prompt);
  }

  pause(): void {
    this.input?.pause?.();
  }

  resume(): void {
    this.input?.resume?.();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }

  defineCommand(name: string, command: ReplCommand | ((text: string) => void)): void {
    this.commands[name] = typeof command === "function" ? { action: command } : command;
  }

  /**
   * node:repl reads/writes a history file. There is no filesystem here, so
   * a nonexistent path must simply succeed — the callback fires
   * asynchronously with `(null, "")` (node's test-repl-no-terminal).
   */
  setupHistory(_path: string, callback: (err: Error | null, repl: unknown) => void): void {
    queueMicrotask(() => callback(null, ""));
  }

  #processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      this.displayPrompt();
      return;
    }
    if (trimmed.startsWith(".")) {
      this.#runCommand(trimmed);
      return;
    }
    this.#evaluate(trimmed);
  }

  #runCommand(line: string): void {
    const keyword = line.slice(1).split(/\s/, 1)[0];
    if (keyword === "exit" || keyword === "quit") {
      this.close();
      return;
    }
    const command = this.commands[keyword];
    if (command) {
      command.action.call(this, line.slice(keyword.length + 1));
      return;
    }
    this.output?.write("Invalid REPL keyword\n");
    this.displayPrompt();
  }

  #evaluate(code: string): void {
    try {
      // Context members are bound as function parameters; sloppy-mode direct
      // eval lets evaluated code read them and complete with the last
      // expression's value. Assignments land in the eval scope, not the
      // context — documented limitation of the no-vm shim.
      const keys = Object.keys(this.context);
      const values = keys.map((key) => this.context[key]);
      const fn = new Function(...keys, `return eval(${JSON.stringify(code)});`);
      const result = fn(...values);
      if (result !== undefined || !this.ignoreUndefined) {
        this.output?.write(`${formatValue(result)}\n`);
      }
    } catch (err) {
      // Thrown null/undefined is silently swallowed (node's
      // test-repl-throw-null-or-undefined); anything else is printed and
      // the REPL continues.
      if (err !== null && err !== undefined) {
        this.output?.write(`${formatValue(err)}\n`);
      }
    }
    this.displayPrompt();
  }
}

export const start = (options?: ReplOptions | string): REPLServer =>
  new REPLServer(typeof options === "string" ? { prompt: options } : options);

export const createReplShim = () => ({
  start,
  REPLServer,
  writer,
  Recoverable,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
});

export default createReplShim();
