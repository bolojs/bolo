import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { IframeSandbox } from "./iframe-sandbox.js";
import { supportsSnapshots, type SandboxBackend } from "./sandbox-backend.js";

describe("supportsSnapshots", () => {
  it("returns false for IframeSandbox (no snapshot/restore)", () => {
    const sandbox = new IframeSandbox(new VfsBus(), "/home/web");
    expect(supportsSnapshots(sandbox)).toBe(false);
    sandbox.dispose();
  });

  it("returns true when both snapshot and restore are implemented", () => {
    const backend: SandboxBackend = {
      run: () => Promise.resolve({ result: "ok" }),
      dispose: () => {},
      snapshot: () => Promise.resolve({ bytes: new Uint8Array([1]), format: "stub@1" }),
      restore: () => Promise.resolve(),
    };
    expect(supportsSnapshots(backend)).toBe(true);
  });

  it("returns false when only one of snapshot/restore is implemented", () => {
    const backend: SandboxBackend = {
      run: () => Promise.resolve({ result: "ok" }),
      dispose: () => {},
      snapshot: () => Promise.resolve({ bytes: new Uint8Array([1]), format: "stub@1" }),
    };
    expect(supportsSnapshots(backend)).toBe(false);
  });
});
