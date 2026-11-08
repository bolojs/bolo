import { describe, it, expect } from "vitest";
import nodeQs from "node:querystring";
import { createQuerystringShim } from "../../../packages/node-web-shims/src/querystring.ts";

const shim = createQuerystringShim();

// Counterexamples found by tests/unit/property/querystring.prop.test.ts.
describe("known unenv node:querystring vs node:querystring divergences", () => {
  it.fails("[seed any] parse corrupts astral chars in value after %-decoded key", () => {
    const s = "%e2%82%ac=%&k💩=v";
    expect(shim.parse(s, ",")).toEqual(nodeQs.parse(s, ","));
    // shim {"€":"%&k=�=v"}, node {"€":"%&k💩=v"}
  });
});
