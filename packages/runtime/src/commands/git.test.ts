import { describe, it, expect, vi, beforeEach } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { git } from "./git.js";

const createDeps = (vfs: VfsBus, cwd: string) => ({
  vfs,
  cwd,
  stdout: vi.fn(),
  stderr: vi.fn(),
});

describe("git", () => {
  let vfs: VfsBus;
  let cwd: string;

  beforeEach(async () => {
    vfs = new VfsBus();
    cwd = "/repo";
    await vfs.mkdir(cwd, { recursive: true });
  });

  it("init creates .git/ in cwd", async () => {
    const deps = createDeps(vfs, cwd);
    const code = await git(["init"], deps);
    expect(code).toBe(0);
    expect(await vfs.exists(`${cwd}/.git`)).toBe(true);
  });

  it("add then commit produces a commit and log shows it", async () => {
    await git(["init"], createDeps(vfs, cwd));
    await vfs.writeFile(`${cwd}/hello.txt`, "hello");

    const addDeps = createDeps(vfs, cwd);
    expect(await git(["add", "hello.txt"], addDeps)).toBe(0);

    const commitDeps = createDeps(vfs, cwd);
    expect(await git(["commit", "-m", "first"], commitDeps)).toBe(0);
    expect(
      commitDeps.stdout.mock.calls
        .map((c) => c[0])
        .join("")
        .trim(),
    ).toMatch(/^\[main [0-9a-f]{7}\] first/);

    const logDeps = createDeps(vfs, cwd);
    expect(await git(["log"], logDeps)).toBe(0);
    const logOutput = logDeps.stdout.mock.calls.map((c) => c[0]).join("");
    expect(logOutput).toContain("commit");
    expect(logOutput).toContain("first");
  });

  it("status reports ?? for untracked and A for staged", async () => {
    await git(["init"], createDeps(vfs, cwd));
    await vfs.writeFile(`${cwd}/untracked.txt`, "u");
    await vfs.writeFile(`${cwd}/staged.txt`, "s");

    const stagedDeps = createDeps(vfs, cwd);
    await git(["add", "staged.txt"], stagedDeps);

    const statusDeps = createDeps(vfs, cwd);
    expect(await git(["status"], statusDeps)).toBe(0);
    const output = statusDeps.stdout.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("?? untracked.txt");
    expect(output).toContain("A  staged.txt");
  });

  it("status reports M for modified tracked file", async () => {
    await git(["init"], createDeps(vfs, cwd));
    await vfs.writeFile(`${cwd}/file.txt`, "v1");
    await git(["add", "file.txt"], createDeps(vfs, cwd));
    await git(["commit", "-m", "initial"], createDeps(vfs, cwd));
    // Change size so memfs stat changes; same-size overwrites can look
    // unmodified to isomorphic-git's stat-cache based status.
    await vfs.writeFile(`${cwd}/file.txt`, "version2");

    const statusDeps = createDeps(vfs, cwd);
    expect(await git(["status"], statusDeps)).toBe(0);
    const output = statusDeps.stdout.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain(" M file.txt");
  });

  it("unknown subcommand returns exit 1 with expected message", async () => {
    const deps = createDeps(vfs, cwd);
    const code = await git(["merge"], deps);
    expect(code).toBe(1);
    expect(deps.stdout).toHaveBeenCalledWith(
      expect.stringContaining("git: 'merge' is not supported. Supported:"),
    );
  });

  it("log --oneline formats correctly", async () => {
    await git(["init"], createDeps(vfs, cwd));
    await vfs.writeFile(`${cwd}/a.txt`, "a");
    await git(["add", "a.txt"], createDeps(vfs, cwd));
    await git(["commit", "-m", "alpha"], createDeps(vfs, cwd));

    const deps = createDeps(vfs, cwd);
    expect(await git(["log", "--oneline"], deps)).toBe(0);
    const output = deps.stdout.mock.calls
      .map((c) => c[0])
      .join("")
      .trim();
    expect(output).toMatch(/^[0-9a-f]{7} alpha$/);
  });

  it("clone with no URL fails with a clear error", async () => {
    const deps = createDeps(vfs, cwd);
    const code = await git(["clone"], deps);
    expect(code).toBe(1);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("clone requires a URL"));
  });

  it("clone with malformed URL fails before any network call", async () => {
    const deps = createDeps(vfs, cwd);
    const code = await git(["clone", "not-a-url"], deps);
    expect(code).toBe(1);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("invalid URL: not-a-url"));
  });
});
