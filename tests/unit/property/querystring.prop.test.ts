import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import nodeQs from "node:querystring";
import { createQuerystringShim } from "../../../packages/node-web-shims/src/querystring.ts";
import { fcParams, outcome, expectSameOutcome } from "./fc-config.ts";

const shim = createQuerystringShim();

const qsPiece = fc.constantFrom(
  "a=1",
  "b=2",
  "a=3",
  "k",
  "=v",
  "a=",
  "%20=x",
  "x%20=1",
  "a+b=c",
  "%E9=%C3",
  "k💩=v",
  "a=&b=",
  "%zz=1",
  "a===b",
  "%41=x",
  "%e2%82%ac=%",
  "a[b]=c",
);

const qsStr = fc.array(qsPiece, { maxLength: 6 }).map((parts) => parts.join("&"));

// unenv corrupts astral-plane characters in a parsed value when the same
// string also contains a "%" (its qsUnescape fallback path) — see
// tests/unit/regressions/querystring-unenv-divergences.test.ts.
const noAstralWithPercent = (s: string): boolean =>
  !(/[\u{10000}-\u{10FFFF}]/u.test(s) && s.includes("%"));

const sepArb = fc.option(fc.constantFrom("&", ";", ","), { nil: undefined });
const eqArb = fc.option(fc.constantFrom("=", ":", "-"), { nil: undefined });

const plainObject = (o: unknown): unknown =>
  typeof o === "object" && o !== null ? { ...(o as Record<string, unknown>) } : o;

const qsKey = fc.constantFrom("a", "b", "k1", "x y", "%", "k💩", "", "c.d");
const qsScalar = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer({ min: -100, max: 100 }),
  fc.boolean(),
  fc.constantFrom("", "x y", "%20", "💩"),
);
const qsValue = fc.oneof(qsScalar, fc.array(qsScalar, { maxLength: 3 }));
const qsObject = fc.dictionary(qsKey, qsValue, { maxKeys: 6 });

describe("differential property: node:querystring vs querystring shim (unenv)", () => {
  it("parse matches node:querystring.parse (default sep/eq)", () => {
    fc.assert(
      fc.property(qsStr, (s) => {
        fc.pre(noAstralWithPercent(s));
        const a = outcome(() => plainObject(shim.parse(s)));
        const b = outcome(() => plainObject(nodeQs.parse(s)));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("parse matches node:querystring.parse (explicit sep/eq)", () => {
    fc.assert(
      fc.property(qsStr, sepArb, eqArb, (s, sep, eq) => {
        fc.pre(noAstralWithPercent(s));
        const run = (impl: typeof nodeQs) =>
          outcome(() => plainObject(sep === undefined ? impl.parse(s) : impl.parse(s, sep, eq)));
        expectSameOutcome(run(shim as typeof nodeQs), run(nodeQs));
      }),
      fcParams(),
    );
  });

  it("stringify matches node:querystring.stringify", () => {
    fc.assert(
      fc.property(qsObject, (obj) => {
        const a = outcome(() => shim.stringify(obj));
        const b = outcome(() => nodeQs.stringify(obj));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("escape matches node:querystring.escape", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (s) => {
        expect(shim.escape(s)).toBe(nodeQs.escape(s));
      }),
      fcParams(),
    );
  });

  it("unescape matches node:querystring.unescape", () => {
    fc.assert(
      fc.property(qsStr, (s) => {
        expect(shim.unescape(s)).toBe(nodeQs.unescape(s));
      }),
      fcParams(),
    );
  });

  it("parse(stringify(obj)) round trip matches node:querystring", () => {
    fc.assert(
      fc.property(qsObject, (obj) => {
        const a = outcome(() => plainObject(shim.parse(shim.stringify(obj))));
        const b = outcome(() => plainObject(nodeQs.parse(nodeQs.stringify(obj))));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });
});
