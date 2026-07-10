import { describe, it, expect } from "vitest";
import { IframeSandbox } from "./iframe-sandbox";
import { VfsBus } from "@browser-containers/vfs-bus";

describe("IframeSandbox", () => {
  it("constructs with vfs and workdir", () => {
    const sandbox = new IframeSandbox(new VfsBus(), "/home/web");
    expect(sandbox).toBeInstanceOf(IframeSandbox);
    sandbox.dispose();
  });

  // Full eval tests require a real browser (the iframe needs to actually
  // load and execute its script). Covered by e2e specs, not unit tests.
});
