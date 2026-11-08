import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import nodeBuffer from "node:buffer";
import { createBufferShim } from "../../../packages/node-web-shims/src/buffer.ts";
// The shim exports `globalThis.Buffer || _Buffer` — under Node that is the
// real Buffer, which would make the differential vacuous. _Buffer is the
// feross/buffer implementation the shim actually ships to browsers, so we
// reach into unenv's internal module to exercise the real browser code path.
// @ts-expect-error no published types for this internal module
import { Buffer as BrowserBuffer } from "unenv/node/internal/buffer/buffer";
import { fcParams, outcome, expectSameOutcome } from "./fc-config.ts";

const shim = createBufferShim();
const NodeBuffer = nodeBuffer.Buffer;

const encoding = fc.constantFrom("utf8", "hex", "base64", "latin1");

const bytes = fc.uint8Array({ maxLength: 32 });

const hexStr = bytes.map((a) => NodeBuffer.from(a).toString("hex"));
const base64Str = bytes.map((a) => NodeBuffer.from(a).toString("base64"));
// node collapses a truncated multi-byte tail into one U+FFFD while unenv's
// decoder emits one per leftover byte — see
// tests/unit/regressions/buffer-unenv-divergences.test.ts.
const validUtf8Bytes = fc.string({ maxLength: 32 }).map((s) => new TextEncoder().encode(s));

const text = fc.oneof(
  fc.string({ maxLength: 32 }),
  base64Str,
  fc.constantFrom("", "é", "💩", "\ud800", "\udfff", "abc", "  padded  "),
);

const toBytes = (buf: unknown): number[] => Array.from(buf as Uint8Array);

describe("differential property: node:buffer vs buffer shim (unenv browser Buffer)", () => {
  it("shim Buffer is the real Buffer under Node (sanity)", () => {
    expect(shim.Buffer).toBe(NodeBuffer);
  });

  it("from(string, enc) produces identical bytes for utf8/base64/latin1", () => {
    fc.assert(
      fc.property(text, fc.constantFrom("utf8", "base64", "latin1"), (s, enc) => {
        const a = outcome(() => toBytes(BrowserBuffer.from(s, enc)));
        const b = outcome(() => toBytes(NodeBuffer.from(s, enc)));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  // unenv's hex decoder tolerates non-hex characters where node truncates at
  // the first invalid pair (regression file), so only valid hex goes through
  // the strict equality property here.
  it("from(validHex, 'hex') produces identical bytes", () => {
    fc.assert(
      fc.property(hexStr, (s) => {
        expect(toBytes(BrowserBuffer.from(s, "hex"))).toEqual(toBytes(NodeBuffer.from(s, "hex")));
      }),
      fcParams(),
    );
  });

  it("from(bytes).toString(enc) produces identical strings", () => {
    fc.assert(
      fc.property(encoding, bytes, (enc, a) => {
        fc.pre(enc !== "utf8"); // valid-utf8 variant covered by its own property
        const x = outcome(() => BrowserBuffer.from(a).toString(enc));
        const y = outcome(() => NodeBuffer.from(a).toString(enc));
        expectSameOutcome(x, y);
      }),
      fcParams(),
    );
  });

  it("from(validUtf8).toString('utf8') produces identical strings", () => {
    fc.assert(
      fc.property(validUtf8Bytes, (a) => {
        expect(BrowserBuffer.from(a).toString("utf8")).toBe(NodeBuffer.from(a).toString("utf8"));
      }),
      fcParams(),
    );
  });

  it("hex round trip: from(hex).toString('hex') matches node", () => {
    fc.assert(
      fc.property(hexStr, (s) => {
        const a = outcome(() => BrowserBuffer.from(s, "hex").toString("hex"));
        const b = outcome(() => NodeBuffer.from(s, "hex").toString("hex"));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("base64 round trip: from(b64).toString('base64') matches node", () => {
    fc.assert(
      fc.property(base64Str, (s) => {
        const a = outcome(() => BrowserBuffer.from(s, "base64").toString("base64"));
        const b = outcome(() => NodeBuffer.from(s, "base64").toString("base64"));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("utf8 round trip: from(str).toString('utf8') matches node", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 32 }), (s) => {
        const a = outcome(() => BrowserBuffer.from(s, "utf8").toString("utf8"));
        const b = outcome(() => NodeBuffer.from(s, "utf8").toString("utf8"));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("latin1 round trip: from(str).toString('latin1') matches node", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 32 }), (s) => {
        const a = outcome(() => BrowserBuffer.from(s, "latin1").toString("latin1"));
        const b = outcome(() => NodeBuffer.from(s, "latin1").toString("latin1"));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("isEncoding agrees with node:buffer.Buffer.isEncoding", () => {
    fc.assert(
      fc.property(
        // "base64url" is a real divergence — regression file.
        fc.constantFrom(
          "utf8",
          "utf-8",
          "hex",
          "base64",
          "latin1",
          "binary",
          "ascii",
          "ucs2",
          "ucs-2",
          "utf16le",
          "utf-16le",
          "bogus",
          "",
          "UTF8",
        ),
        (enc) => {
          expect(BrowserBuffer.isEncoding(enc)).toBe(NodeBuffer.isEncoding(enc));
        },
      ),
      fcParams(),
    );
  });
});
