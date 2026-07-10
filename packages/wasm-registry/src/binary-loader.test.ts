import { describe, it, expect } from "vitest";

describe("binary-loader memory cache", () => {
  it("manifest has esbuild and swc entries", async () => {
    const { BINARY_MANIFEST } = await import("./binary-loader");
    expect(BINARY_MANIFEST.length).toBeGreaterThanOrEqual(2);
    expect(BINARY_MANIFEST.some((m) => m.name === "esbuild-wasm")).toBe(true);
    expect(BINARY_MANIFEST.some((m) => m.name === "@swc/wasm-web")).toBe(true);
  });

  it("cache paths follow /__wasm-cache/{name}@{version}/{filename} pattern", async () => {
    const { BINARY_MANIFEST } = await import("./binary-loader");
    for (const m of BINARY_MANIFEST) {
      expect(m.cdnUrl).toContain(`${m.name}@${m.version}`);
      expect(m.cdnUrl).toContain(m.filename);
    }
  });
});
