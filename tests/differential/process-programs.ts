import * as fc from "fast-check";

/**
 * Grammar for process-semantics programs (v0.2.0 differential testing).
 *
 * Each program is rendered to plain CommonJS that only uses process/timer
 * primitives and logs ordered `L<n>` markers. Real Node is the oracle: the
 * stdout `L` lines and the exit code of bolo must match Node's. Timer delays
 * are multiples of 10ms (never 0) so ordering is deterministic in both
 * runtimes; setImmediate is never mixed with setTimeout(0).
 */
export type Stmt =
  | { k: "log" }
  | { k: "timeout"; delay: number; body: Stmt[]; unref: boolean }
  | { k: "immediate"; body: Stmt[] }
  | { k: "tick"; body: Stmt[] }
  | { k: "micro"; body: Stmt[] }
  | { k: "then"; body: Stmt[] }
  | { k: "interval"; delay: number; times: number; body: Stmt[]; unref: boolean }
  | { k: "onExit" }
  | { k: "onBeforeExit" }
  | { k: "exitCode"; code: number }
  | { k: "exit"; code: number }
  | { k: "throw" }
  | { k: "reject" }
  | { k: "catchExit"; code: number };

export interface Program {
  body: Stmt[];
}

const code = fc.integer({ min: 0, max: 5 });

/**
 * `inMicro`: inside a microtask/promise job. `top`: the main script itself.
 * process.nextTick is only generated where bolo can order it like Node
 * (BOLO-DIV-001: bolo cannot observe the engine's microtask queue, so ticks
 * queued from the main script or from microtask jobs run in a different place).
 */
const stmtArb = (depth: number, inMicro: boolean, top: boolean): fc.Arbitrary<Stmt> => {
  const sub = (micro: boolean) =>
    depth <= 0
      ? fc.constant<Stmt[]>([])
      : fc.array(stmtArb(depth - 1, micro, false), { maxLength: 3 });
  const nested = sub(false);
  const nestedMicro = sub(true);
  const tickAllowed = !inMicro && !top;
  return fc.oneof(
    { weight: 6, arbitrary: fc.constant<Stmt>({ k: "log" }) },
    {
      weight: 3,
      arbitrary: fc.record({
        k: fc.constant("timeout" as const),
        delay: fc.integer({ min: 1, max: 6 }).map((n) => n * 30),
        body: nested,
        unref: fc.boolean(),
      }),
    },
    { weight: 2, arbitrary: fc.record({ k: fc.constant("immediate" as const), body: nested }) },
    {
      weight: tickAllowed ? 2 : 0,
      arbitrary: fc.record({ k: fc.constant("tick" as const), body: nested }),
    },
    { weight: 2, arbitrary: fc.record({ k: fc.constant("micro" as const), body: nestedMicro }) },
    { weight: 2, arbitrary: fc.record({ k: fc.constant("then" as const), body: nestedMicro }) },
    {
      weight: 2,
      arbitrary: fc.record({
        k: fc.constant("interval" as const),
        delay: fc.integer({ min: 1, max: 3 }).map((n) => n * 30),
        times: fc.integer({ min: 1, max: 3 }),
        body: nested,
        unref: fc.boolean(),
      }),
    },
    { weight: 1, arbitrary: fc.constant<Stmt>({ k: "onExit" }) },
    { weight: 1, arbitrary: fc.constant<Stmt>({ k: "onBeforeExit" }) },
    { weight: 1, arbitrary: code.map((c): Stmt => ({ k: "exitCode", code: c })) },
    { weight: 1, arbitrary: code.map((c): Stmt => ({ k: "exit", code: c })) },
    {
      // BOLO-DIV-002: a top-level sync throw cannot stop promise jobs already queued.
      weight: top ? 0 : 1,
      arbitrary: fc.constant<Stmt>({ k: "throw" }),
    },
    { weight: 1, arbitrary: fc.constant<Stmt>({ k: "reject" }) },
    { weight: 1, arbitrary: code.map((c): Stmt => ({ k: "catchExit", code: c })) },
  );
};

export const programArb: fc.Arbitrary<Program> = fc.record({
  body: fc.array(stmtArb(2, false, true), { minLength: 1, maxLength: 6 }),
});

/** Renders a program to CommonJS source. Log ids are assigned in source order. */
export const renderProgram = (program: Program): string => {
  let id = 0;
  const log = () => `console.log("L${id++}");`;
  const block = (stmts: Stmt[]): string => stmts.map(stmt).join("\n");
  const stmt = (s: Stmt): string => {
    switch (s.k) {
      case "log":
        return log();
      case "timeout":
        return `{ const t = setTimeout(() => {\n${log()}\n${block(s.body)}\n}, ${s.delay});${s.unref ? " t.unref();" : ""} }`;
      case "immediate":
        return `setImmediate(() => {\n${log()}\n${block(s.body)}\n});`;
      case "tick":
        return `process.nextTick(() => {\n${log()}\n${block(s.body)}\n});`;
      case "micro":
        return `queueMicrotask(() => {\n${log()}\n${block(s.body)}\n});`;
      case "then":
        return `Promise.resolve().then(() => {\n${log()}\n${block(s.body)}\n});`;
      case "interval":
        return `{ let n = 0; const t = setInterval(() => {\n${log()}\n${block(s.body)}\nif (++n >= ${s.times}) clearInterval(t);\n}, ${s.delay});${s.unref ? " t.unref();" : ""} }`;
      case "onExit":
        return `process.on("exit", (c) => {\n${log()}\n});`;
      case "onBeforeExit":
        return `{ let once = false; process.on("beforeExit", () => {\nif (once) return; once = true;\n${log()}\n}); }`;
      case "exitCode":
        return `process.exitCode = ${s.code};`;
      case "exit":
        return `process.exit(${s.code});`;
      case "throw":
        return `throw new Error("boom");`;
      case "reject":
        return `Promise.reject(new Error("nope"));`;
      case "catchExit":
        return `try { process.exit(${s.code}); } catch (e) { ${log()} }`;
    }
  };
  return `${block(program.body)}\n`;
};

/** Keeps only the deterministic `L<n>` marker lines of combined output. */
export const markerLines = (output: string): string[] =>
  output.split(/\r?\n/).filter((line) => /^L\d+$/.test(line));
