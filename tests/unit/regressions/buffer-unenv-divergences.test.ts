import { describe, it, expect } from "vitest";
import nodeBuffer from "node:buffer";
// Same internal import as tests/unit/property/buffer.prop.test.ts — this is
// the Buffer implementation the shim ships to browsers.
// @ts-expect-error no published types for this internal module
import { Buffer as BrowserBuffer } from "unenv/node/internal/buffer/buffer";

const NodeBuffer = nodeBuffer.Buffer;

// Counterexamples found by tests/unit/property/buffer.prop.test.ts.
describe("known unenv browser-Buffer vs node:buffer divergences", () => {
  it.fails("[seed -633580446] hex decoder tolerates non-hex chars instead of truncating", () => {
    expect(Array.from(BrowserBuffer.from("a b", "hex") as Uint8Array)).toEqual(
      Array.from(NodeBuffer.from("a b", "hex")),
    ); // shim [10], node []
  });

  it.fails("[seed -870563936] utf8 decoder emits one U+FFFD per leftover byte", () => {
    expect(BrowserBuffer.from(Uint8Array.from([225, 128])).toString("utf8")).toBe(
      NodeBuffer.from(Uint8Array.from([225, 128])).toString("utf8"),
    ); // shim "\ufffd\ufffd", node "\ufffd"
  });

  it.fails("[seed 1609839687] isEncoding does not know base64url", () => {
    expect(BrowserBuffer.isEncoding("base64url")).toBe(NodeBuffer.isEncoding("base64url"));
    // shim false, node true
  });
});
