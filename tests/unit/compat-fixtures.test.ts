import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { internalShimSources } from "../../apps/compat-harness/src/test-common.ts";

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), "../../apps/compat-harness");
const nodeTests = join(harnessDir, "node-tests");

describe("vendored node-tests support tree", () => {
  it("ships the common helpers tests require", () => {
    for (const file of ["tmpdir.js", "arraystream.js", "fixtures.js"]) {
      expect(existsSync(join(nodeTests, "test/common", file)), file).toBe(true);
    }
  });

  it("ships the fixtures the manifest's cat-B tests need", () => {
    const files = [
      "empty.txt",
      "worker-script.ts",
      "sample.png",
      "cjs-module-wrap.js",
      "cjs-module-wrapper.js",
      "process-exit-code-cases.js",
      "utf8_test_text.txt",
      "es-modules/test-esm-ok.mjs",
      "es-modules/noext",
      "keys/agent1-key.pem",
      "keys/agent1-cert.pem",
      "keys/ca1-cert.pem",
    ];
    for (const file of files) {
      expect(existsSync(join(nodeTests, "test/fixtures", file)), file).toBe(true);
    }
  });

  it("ships the sibling helper test-tls-ticket-12 requires", () => {
    expect(existsSync(join(nodeTests, "test/parallel/test-tls-ticket.js"))).toBe(true);
  });

  it("carries the Node.js MIT attribution", () => {
    expect(existsSync(join(nodeTests, "ATTRIBUTION.md"))).toBe(true);
  });
});

describe("internal/* shim sources", () => {
  it("covers internal/event_target and internal/util", () => {
    expect(Object.keys(internalShimSources).sort()).toEqual([
      "internal/event_target",
      "internal/util",
    ]);
  });

  it("compiles as CommonJS and exports the surface tests use", () => {
    for (const source of Object.values(internalShimSources)) {
      const mod = { exports: {} as Record<string, unknown> };
      new Function("module", "require", source)(mod, () => ({}));
      expect(mod.exports).toBeTypeOf("object");
    }
    const eventTarget = internalShimSources["internal/event_target"];
    const mod = { exports: {} as Record<string, any> };
    new Function("module", "require", eventTarget)(mod, () => ({}));
    expect(typeof mod.exports.NodeEventTarget).toBe("function");
    const target = new mod.exports.NodeEventTarget();
    const listener = () => {};
    target.addEventListener("abort", listener);
    expect(target[mod.exports.kEvents].get("abort")?.size).toBe(1);
    target.removeEventListener("abort", listener);
    expect(target[mod.exports.kEvents].get("abort")?.size).toBe(0);
  });

  it("stays text-writable (no binary fixtures needed by the shim)", () => {
    for (const source of Object.values(internalShimSources)) {
      expect(source).toContain("module.exports");
    }
  });
});
