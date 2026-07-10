import { describe, it, expect, vi, beforeEach } from "vitest";
import { VfsBus } from "@browser-containers/vfs-bus";
import { ShellService, type ShellServiceDeps } from "./shell-service.js";

const createDeps = (vfs: VfsBus): ShellServiceDeps => ({
  vfs,
  packageManager: {
    install: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShellServiceDeps["packageManager"],
  runtimeWorker: {
    runScript: vi.fn(),
    onStdout: null,
    onStderr: null,
  } as unknown as ShellServiceDeps["runtimeWorker"],
  sandbox: { run: vi.fn() } as unknown as ShellServiceDeps["sandbox"],
});

describe("ShellService + just-bash integration", () => {
  let vfs: VfsBus;
  let shell: ShellService;

  beforeEach(() => {
    vfs = new VfsBus();
    shell = new ShellService(createDeps(vfs));
  });

  it("ls lists files written via VfsBus", async () => {
    await vfs.writeFile("/hello.txt", "hi");
    const result = await shell.execute("ls /");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello.txt");
  });

  it("cat reads a file written via VfsBus", async () => {
    await vfs.writeFile("/a.txt", "hello world");
    const result = await shell.execute("cat /a.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
  });

  it("pipes: ls | grep filters output", async () => {
    await vfs.writeFile("/foo.txt", "x");
    await vfs.writeFile("/bar.txt", "y");
    const result = await shell.execute("ls / | grep foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("foo.txt");
    expect(result.stdout).not.toContain("bar.txt");
  });

  it("redirection: echo > file then cat reads it back through VfsBus", async () => {
    const write = await shell.execute("echo hello > /out.txt");
    expect(write.exitCode).toBe(0);

    const readBack = await shell.execute("cat /out.txt");
    expect(readBack.stdout).toContain("hello");

    const viaVfs = await vfs.readFile("/out.txt");
    expect(String(viaVfs)).toContain("hello");
  });

  it("cd persists across separate execute() calls", async () => {
    await vfs.mkdir("/sub", { recursive: true });
    await vfs.writeFile("/sub/inner.txt", "x");

    const cd = await shell.execute("cd /sub");
    expect(cd.exitCode).toBe(0);

    const pwd = await shell.execute("pwd");
    expect(pwd.stdout.trim()).toBe("/sub");

    const ls = await shell.execute("ls");
    expect(ls.stdout).toContain("inner.txt");
  });

  it("mkdir via bash is visible through VfsBus", async () => {
    const result = await shell.execute("mkdir -p /created/nested");
    expect(result.exitCode).toBe(0);
    expect(await vfs.exists("/created/nested")).toBe(true);
  });

  it("rm via bash removes a VfsBus-written file", async () => {
    await vfs.writeFile("/gone.txt", "x");
    const result = await shell.execute("rm /gone.txt");
    expect(result.exitCode).toBe(0);
    expect(await vfs.exists("/gone.txt")).toBe(false);
  });

  it("unknown command returns 127 and does not shadow npm/runtime/agent fast paths", async () => {
    const result = await shell.execute("npm install lodash");
    expect(result.exitCode).toBe(0);
  });

  it("cp copies a file through VfsBus", async () => {
    await vfs.writeFile("/src.txt", "content");
    const result = await shell.execute("cp /src.txt /dst.txt");
    expect(result.exitCode).toBe(0);
    expect(String(await vfs.readFile("/dst.txt"))).toBe("content");
    expect(String(await vfs.readFile("/src.txt"))).toBe("content");
  });

  it("cp -r copies a directory recursively through VfsBus", async () => {
    await vfs.mkdir("/srcdir", { recursive: true });
    await vfs.writeFile("/srcdir/a.txt", "a");
    await vfs.writeFile("/srcdir/b.txt", "b");
    const result = await shell.execute("cp -r /srcdir /dstdir");
    expect(result.exitCode).toBe(0);
    expect(String(await vfs.readFile("/dstdir/a.txt"))).toBe("a");
    expect(String(await vfs.readFile("/dstdir/b.txt"))).toBe("b");
  });

  it("mv renames a file through VfsBus", async () => {
    await vfs.writeFile("/old.txt", "moved");
    const result = await shell.execute("mv /old.txt /new.txt");
    expect(result.exitCode).toBe(0);
    expect(await vfs.exists("/old.txt")).toBe(false);
    expect(String(await vfs.readFile("/new.txt"))).toBe("moved");
  });

  it("mv overwrites an existing destination file", async () => {
    await vfs.writeFile("/src2.txt", "new-content");
    await vfs.writeFile("/dst2.txt", "old-content");
    const result = await shell.execute("mv /src2.txt /dst2.txt");
    expect(result.exitCode).toBe(0);
    expect(String(await vfs.readFile("/dst2.txt"))).toBe("new-content");
  });
});
