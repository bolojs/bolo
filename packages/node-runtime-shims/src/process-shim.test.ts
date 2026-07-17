import { describe, it, expect } from "vitest";
import { createProcessShim } from "./process-shim.js";

describe("createProcessShim", () => {
  it("routes stdout/stderr writes to the supplied callbacks instead of discarding them", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const process = createProcessShim({
      onStdout: (d) => stdout.push(d),
      onStderr: (d) => stderr.push(d),
    });

    process.stdout.write("hello\n");
    process.stderr.write("oops\n");

    expect(stdout).toEqual(["hello\n"]);
    expect(stderr).toEqual(["oops\n"]);
  });

  it("reports platform as browser and exposes cwd/chdir", () => {
    const process = createProcessShim({ cwd: "/home/web" });

    expect(process.platform).toBe("browser");
    expect(process.cwd()).toBe("/home/web");
    process.chdir("/tmp");
    expect(process.cwd()).toBe("/tmp");
  });

  it("reports memory usage with the expected shape", () => {
    const process = createProcessShim();
    const usage = process.memoryUsage();

    expect(usage).toHaveProperty("rss");
    expect(usage).toHaveProperty("heapTotal");
    expect(usage).toHaveProperty("heapUsed");
    expect(usage).toHaveProperty("external");
    expect(usage).toHaveProperty("arrayBuffers");
    expect(typeof process.memoryUsage.rss()).toBe("number");
  });

  it("zeros external and arrayBuffers while preserving heap values", () => {
    (performance as any).memory = { totalHeapSize: 1000, usedHeapSize: 500 };
    try {
      const process = createProcessShim();
      const usage = process.memoryUsage();

      expect(usage.heapTotal).toBe(1000);
      expect(usage.heapUsed).toBe(500);
      expect(usage.rss).toBe(1000);
      expect(usage.external).toBe(0);
      expect(usage.arrayBuffers).toBe(0);
    } finally {
      delete (performance as any).memory;
    }
  });
});
