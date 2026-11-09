import { describe, it, expect } from "vitest";
import { patchWasiAsyncPool } from "./index";

const oxc = "/n/@oxc-transform/binding-wasm32-wasi/transform.wasi-browser.js";
const rd = "/n/@rolldown/browser/dist/rolldown-binding.wasi-browser.js";
const src = "const x = { context: c,\n  asyncWorkPoolSize: 4,\n  wasi: w };";

describe("patchWasiAsyncPool", () => {
  it("zeroes the pool for oxc and rolldown WASI browser bindings", () => {
    for (const id of [oxc, rd, `${oxc}?v=1`]) {
      expect(patchWasiAsyncPool(id, src)).toContain("asyncWorkPoolSize: 0");
    }
  });
  it("leaves other files and already patched code alone", () => {
    expect(patchWasiAsyncPool("/n/other.js", src)).toBeNull();
    expect(patchWasiAsyncPool(oxc, "asyncWorkPoolSize: 0, // x")).toBeNull();
  });
});
