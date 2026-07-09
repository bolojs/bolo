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

  it("runs nextTick callbacks as a microtask", async () => {
    const process = createProcessShim();
    let called = false;
    process.nextTick(() => {
      called = true;
    });
    expect(called).toBe(false);
    await Promise.resolve();
    expect(called).toBe(true);
  });
});
