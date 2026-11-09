import { describe, it, expect } from "vitest";
import nodeUrl from "node:url";
import { createUrlShim } from "../../../packages/node-web-shims/src/url.ts";

const shim = createUrlShim();

// Counterexamples found by tests/unit/property/url.prop.test.ts.
describe("known unenv node:url vs node:url divergences", () => {
  it.fails("[seed 1498418356] parse accepts invalid URLs node rejects (DEP0170)", () => {
    const s = "user:passuser:passhttp";
    expect(() => shim.parse(s)).toThrow(); // node throws ERR_INVALID_URL, shim parses
  });

  it.fails("[seed 1300371642] resolve accepts invalid base URLs node rejects", () => {
    expect(() => shim.resolve("user:passuser:passhttp", "http://a.aa")).toThrow();
    // node throws ERR_INVALID_ARG_TYPE/URL, shim returns "http://a.aa/"
  });

  it.fails("[seed -1943976771] pathToFileURL does not %-encode [] | in paths", () => {
    expect(shim.pathToFileURL("[::1]http").href).toBe(nodeUrl.pathToFileURL("[::1]http").href); // shim ".../[::1]http", node ".../%5B::1%5Dhttp"
  });

  it.fails("[seed 318295977] pathToFileURL trims trailing whitespace off the path", () => {
    expect(shim.pathToFileURL("a/ ").href).toBe(nodeUrl.pathToFileURL("a/ ").href);
    // shim ".../a/", node ".../a/%20"
  });
});
