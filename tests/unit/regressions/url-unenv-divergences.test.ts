import { describe, it, expect } from "vitest";
import nodeUrl from "node:url";
import { createUrlShim } from "../../../packages/node-web-shims/src/url.ts";

const shim = createUrlShim();

// Counterexamples found by tests/unit/property/url.prop.test.ts.
describe("unenv url.parse/resolve divergences (fixed by vendored lib/url.js)", () => {
  it("[seed 1498418356] parse matches node's DEP0170 leniency on invalid hosts", () => {
    const s = "user:passuser:passhttp";
    // node warns (DEP0170) but still parses — hostname "passuser", rest becomes path.
    expect({ ...shim.parse(s) }).toEqual({ ...nodeUrl.parse(s) });
  });

  it("[seed 1300371642] resolve matches node on invalid base URLs", () => {
    expect(shim.resolve("user:passuser:passhttp", "http://a.aa")).toBe(
      nodeUrl.resolve("user:passuser:passhttp", "http://a.aa"),
    ); // "http://a.aa/"
  });
});

describe("known node:url shim vs node:url divergences", () => {
  it.fails("[seed -1943976771] pathToFileURL does not %-encode [] | in paths", () => {
    expect(shim.pathToFileURL("[::1]http").href).toBe(nodeUrl.pathToFileURL("[::1]http").href); // shim ".../[::1]http", node ".../%5B::1%5Dhttp"
  });

  it.fails("[seed 318295977] pathToFileURL trims trailing whitespace off the path", () => {
    expect(shim.pathToFileURL("a/ ").href).toBe(nodeUrl.pathToFileURL("a/ ").href);
    // shim ".../a/", node ".../a/%20"
  });
});
