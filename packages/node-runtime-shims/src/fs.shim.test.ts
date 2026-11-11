import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { createFsShim } from "./fs-shim.js";
import type { FsStat } from "./fs-shim.js";
import type fs from "node:fs";

describe("fs shim", () => {
  it("write-read round-trip via VfsBus", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);
    const _typeCheck: typeof fs = shim as unknown as typeof fs;
    void _typeCheck;

    await shim.writeFile("/test.txt", "hello");
    const data = await shim.readFile("/test.txt", "utf8");
    expect(data).toBe("hello");
  });

  it("mkdir creates directories", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.mkdir("/nested/dir", { recursive: true });
    expect(await shim.exists("/nested/dir")).toBe(true);
    expect(await shim.readdir("/nested")).toContain("dir");
  });

  it("rm removes files", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.writeFile("/delete-me.txt", "bye");
    await shim.rm("/delete-me.txt");
    expect(await shim.exists("/delete-me.txt")).toBe(false);
  });

  it("sync methods are backed for real by the synchronous memfs volume (vfs.hot)", () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.mkdirSync("/nested/dir", { recursive: true });
    expect(shim.existsSync("/nested/dir")).toBe(true);
    expect(shim.readdirSync("/nested")).toContain("dir");

    shim.writeFileSync("/x.txt", "sync hello");
    expect(shim.readFileSync("/x.txt", "utf8")).toBe("sync hello");

    const s = shim.statSync("/x.txt");
    expect(s.isFile()).toBe(true);
    expect(s.isDirectory()).toBe(false);
    expect(s.size).toBe("sync hello".length);

    shim.rmSync("/x.txt");
    expect(shim.existsSync("/x.txt")).toBe(false);
  });

  it("readFileSync returns raw bytes when no encoding is given", () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.writeFileSync("/bin.dat", "abc");
    const raw = shim.readFileSync("/bin.dat");
    expect(raw).toBeInstanceOf(Uint8Array);
  });

  it("stat returns file metadata", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.writeFile("/stats.txt", "content");
    const s = await shim.stat("/stats.txt");
    expect(s.isFile()).toBe(true);
    expect(s.isDirectory()).toBe(false);
    expect(s.size).toBe(7);
  });

  it("symlink/readlink/lstat round-trip", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.writeFile("/target.txt", "target data");

    await shim.symlink("/target.txt", "/link.txt");
    expect(await shim.readlink("/link.txt")).toBe("/target.txt");
    expect((await shim.lstat("/link.txt")).isSymbolicLink()).toBe(true);
    expect((await shim.stat("/link.txt")).isFile()).toBe(true);
    expect((await shim.stat("/link.txt")).isSymbolicLink()).toBe(false);

    shim.symlinkSync("/target.txt", "/link-sync.txt");
    expect(shim.readlinkSync("/link-sync.txt")).toBe("/target.txt");
    expect(shim.lstatSync("/link-sync.txt").isSymbolicLink()).toBe(true);
    expect(shim.statSync("/link-sync.txt").isFile()).toBe(true);
  });

  it("stat on a symlink to a directory reports isDirectory (virtual-store resolution)", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.mkdir("/real-dir", { recursive: true });
    await shim.writeFile("/real-dir/index.js", "module.exports = 1;");
    await shim.mkdir("/node_modules", { recursive: true });
    await shim.symlink("/real-dir", "/node_modules/pkg");

    const s = await shim.stat("/node_modules/pkg");
    expect(s.isDirectory()).toBe(true);
    expect(s.isFile()).toBe(false);
    expect((await shim.lstat("/node_modules/pkg")).isSymbolicLink()).toBe(true);
  });

  it("promises namespace has all async methods", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.promises.writeFile("/p.txt", "data");
    expect(await shim.promises.readFile("/p.txt", "utf8")).toBe("data");
    expect(await shim.promises.exists("/p.txt")).toBe(true);
  });

  it("watch returns an EventEmitter that emits change on VFS mutation", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    const events: Array<{ eventType: string; filename: string }> = [];
    const watcher = shim.watch("/watch.txt");
    watcher.on("change", (eventType, filename) => {
      events.push({ eventType, filename });
    });

    await shim.writeFile("/watch.txt", "first");
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("add");
    expect(events[0].filename).toBe("/watch.txt");
  });

  it("watch stops emitting after close", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    const events: Array<{ eventType: string; filename: string }> = [];
    const watcher = shim.watch("/watch.txt");
    watcher.on("change", (eventType, filename) => {
      events.push({ eventType, filename });
    });

    await shim.writeFile("/watch.txt", "first");
    watcher.close();
    await shim.writeFile("/watch.txt", "second");

    expect(events).toHaveLength(1);
  });

  it("realpath resolves symlinks (sync, async, .native, promises)", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.writeFile("/real.txt", "data");
    await shim.symlink("/real.txt", "/alias.txt");

    expect(shim.realpathSync("/alias.txt")).toBe("/real.txt");
    expect(shim.realpathSync.native?.("/alias.txt")).toBe("/real.txt");
    await expect(shim.realpath("/alias.txt")).resolves.toBe("/real.txt");
    await expect((shim.realpath as any).native("/alias.txt")).resolves.toBe("/real.txt");
    await expect(shim.promises.realpath("/alias.txt")).resolves.toBe("/real.txt");

    // Callback form (the shape chokidar/glob/rimraf call).
    const viaCb = await new Promise<string>((resolve, reject) => {
      shim.realpath("/alias.txt", (err: unknown, resolved: string) =>
        err ? reject(err) : resolve(resolved),
      );
    });
    expect(viaCb).toBe("/real.txt");
  });

  it("fd API: openSync/readSync/writeSync/closeSync + open/read/write/close", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.writeFileSync("/fd.txt", "hello world");

    const fd = shim.openSync("/fd.txt", "r");
    const buf = new Uint8Array(5);
    const n = shim.readSync(fd, buf, 0, 5, 0);
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf)).toBe("hello");
    expect(shim.fstatSync(fd).isFile()).toBe(true);
    shim.closeSync(fd);

    const wfd = shim.openSync("/fd.txt", "r+");
    const written = shim.writeSync(wfd, new TextEncoder().encode("HELLO"), 0, 5, 0);
    expect(written).toBe(5);
    shim.fsyncSync(wfd);
    shim.closeSync(wfd);
    expect(shim.readFileSync("/fd.txt", "utf8")).toBe("HELLO world");

    // Async fd surface via callbacks.
    const afd = await new Promise<number>((resolve, reject) => {
      shim.open("/fd.txt", "r", (err: unknown, fd: number) => (err ? reject(err) : resolve(fd)));
    });
    const abuf = new Uint8Array(5);
    const [bytesRead] = (await new Promise((resolve, reject) => {
      shim.read(afd, abuf, 0, 5, 0, (err: unknown, n: number, b: Uint8Array) =>
        err ? reject(err) : resolve([n, b]),
      );
    })) as [number, Uint8Array];
    expect(bytesRead).toBe(5);
    await new Promise<void>((resolve, reject) => {
      shim.close(afd, (err: unknown) => (err ? reject(err) : resolve()));
    });
  });

  it("promises.open returns a FileHandle with read/write/stat/close", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.writeFileSync("/fh.txt", "filehandle");
    const fh = (await shim.promises.open("/fh.txt", "r+")) as any;
    expect(typeof fh.readFile).toBe("function");
    expect(String(await fh.readFile())).toBe("filehandle");
    await fh.write(new TextEncoder().encode("X"), 0, 1, 0);
    expect(shim.readFileSync("/fh.txt", "utf8")).toBe("Xilehandle");
    expect((await fh.stat()).isFile()).toBe(true);
    await fh.close();
  });

  it("rename/unlink/copyFile/appendFile/access (sync + async + promises)", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.writeFileSync("/a.txt", "aaa");
    shim.renameSync("/a.txt", "/b.txt");
    expect(shim.existsSync("/b.txt")).toBe(true);

    shim.copyFileSync("/b.txt", "/c.txt");
    shim.appendFileSync("/c.txt", "+more");
    expect(shim.readFileSync("/c.txt", "utf8")).toBe("aaa+more");

    shim.accessSync("/c.txt", shim.constants.R_OK);
    expect(() => shim.accessSync("/missing.txt")).toThrow();

    shim.unlinkSync("/b.txt");
    expect(shim.existsSync("/b.txt")).toBe(false);

    // async callback-style + promise fallback
    await shim.appendFile("/c.txt", "!");
    expect(shim.readFileSync("/c.txt", "utf8")).toBe("aaa+more!");
    await shim.rename("/c.txt", "/d.txt");
    await shim.copyFile("/d.txt", "/e.txt");
    await shim.access("/e.txt");
    await shim.unlink("/e.txt");
    expect(shim.existsSync("/e.txt")).toBe(false);

    await shim.promises.copyFile("/d.txt", "/f.txt");
    await shim.promises.rename("/f.txt", "/g.txt");
    await shim.promises.unlink("/d.txt");
    await shim.promises.unlink("/g.txt");
  });

  it("mkdtemp/rmdir/truncate/chmod/utimes (sync + async + promises)", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.mkdirSync("/tmp-root", { recursive: true });
    const dir = shim.mkdtempSync("/tmp-root/p-");
    expect(dir.startsWith("/tmp-root/p-")).toBe(true);
    expect(shim.statSync(dir).isDirectory()).toBe(true);

    shim.writeFileSync(`${dir}/t.txt`, "abcdef");
    shim.truncateSync(`${dir}/t.txt`, 3);
    expect(shim.readFileSync(`${dir}/t.txt`, "utf8")).toBe("abc");

    shim.chmodSync(`${dir}/t.txt`, 0o644);
    const then = new Date("2020-01-01T00:00:00Z");
    shim.utimesSync(`${dir}/t.txt`, then, then);
    expect(shim.statSync(`${dir}/t.txt`).mtime.getTime()).toBe(then.getTime());

    await shim.promises.chmod(`${dir}/t.txt`, 0o600);
    await shim.promises.truncate(`${dir}/t.txt`, 1);
    expect(shim.readFileSync(`${dir}/t.txt`, "utf8")).toBe("a");
    await shim.promises.utimes(`${dir}/t.txt`, new Date(0), new Date(0));

    shim.mkdirSync(`${dir}/sub`);
    shim.rmdirSync(`${dir}/sub`);
    expect(shim.existsSync(`${dir}/sub`)).toBe(false);

    const dir2 = (await new Promise((resolve, reject) => {
      shim.mkdtemp("/tmp-root/q-", (err: unknown, d: string) => (err ? reject(err) : resolve(d)));
    })) as string;
    expect(shim.statSync(dir2).isDirectory()).toBe(true);
    await shim.rmdir(dir2);
  });

  it("cp/cpSync copy recursively and statfs reports filesystem stats", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.mkdirSync("/src/sub", { recursive: true });
    shim.writeFileSync("/src/sub/f.txt", "nested");
    shim.cpSync("/src", "/dst", { recursive: true });
    expect(shim.readFileSync("/dst/sub/f.txt", "utf8")).toBe("nested");

    await shim.promises.cp("/src", "/dst2", { recursive: true });
    expect(shim.readFileSync("/dst2/sub/f.txt", "utf8")).toBe("nested");

    const stats = shim.statfsSync("/") as { bsize: number; blocks: number };
    expect(stats.bsize).toBeGreaterThan(0);
    expect(stats.blocks).toBeGreaterThan(0);
    const pstats = (await shim.promises.statfs("/")) as { bsize: number };
    expect(pstats.bsize).toBeGreaterThan(0);
  });

  it("createReadStream/createWriteStream stream file contents", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.writeFileSync("/stream.txt", "streamed");
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const rs = shim.createReadStream("/stream.txt");
      rs.on("data", (d: { toString(): string }) => chunks.push(d.toString()));
      rs.on("end", () => resolve());
      rs.on("error", (e: unknown) => reject(e));
    });
    expect(chunks.join("")).toBe("streamed");

    await new Promise<void>((resolve, reject) => {
      const ws = shim.createWriteStream("/out.txt");
      (ws as unknown as { write(d: string, cb?: () => void): void }).write("piped");
      (ws as unknown as { end(cb?: () => void): void }).end(() => resolve());
      ws.on("error", (e: unknown) => reject(e));
    });
    expect(shim.readFileSync("/out.txt", "utf8")).toBe("piped");
  });

  it("watchFile fires on stat changes and unwatchFile stops it", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.writeFileSync("/watched.txt", "v1");
    let fired = 0;
    const listener = () => {
      fired++;
    };
    shim.watchFile("/watched.txt", { interval: 20 }, listener);
    await new Promise((r) => setTimeout(r, 10));
    shim.writeFileSync("/watched.txt", "v2");
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBeGreaterThan(0);
    shim.unwatchFile("/watched.txt", listener);
    const count = fired;
    shim.writeFileSync("/watched.txt", "v3");
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(count);
  });

  it("exposes Node's fs constants and stream/stat classes", () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    expect(shim.constants.F_OK).toBe(0);
    expect(shim.constants.R_OK).toBe(4);
    expect(shim.constants.O_CREAT).toBe(64);
    expect(shim.constants.COPYFILE_EXCL).toBe(1);
    expect(shim.F_OK).toBe(0);
    expect(shim.R_OK).toBe(4);
    expect(typeof shim.Stats).toBe("function");
    expect(typeof shim.Dirent).toBe("function");
    expect(typeof shim.FSWatcher).toBe("function");
    expect(typeof shim.ReadStream).toBe("function");
    expect(typeof shim.WriteStream).toBe("function");
    expect(typeof shim.StatWatcher).toBe("function");
  });

  it("async methods accept Node-style callbacks", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await new Promise<void>((resolve, reject) => {
      shim.writeFile("/cb.txt", "cb-data", (err: unknown) => (err ? reject(err) : resolve()));
    });
    const data = await new Promise<string>((resolve, reject) => {
      shim.readFile("/cb.txt", "utf8", (err: unknown, d: string) =>
        err ? reject(err) : resolve(d),
      );
    });
    expect(data).toBe("cb-data");

    const stats = await new Promise<FsStat>((resolve, reject) => {
      shim.stat("/cb.txt", (err: unknown, s: FsStat) => (err ? reject(err) : resolve(s)));
    });
    expect(stats.isFile()).toBe(true);

    const dirExists = await new Promise<boolean>((resolve) => {
      shim.exists("/cb.txt", (e: boolean) => resolve(e));
    });
    expect(dirExists).toBe(true);
  });

  it("promises namespace exposes the breadth surface", () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    for (const name of [
      "readFile",
      "writeFile",
      "mkdir",
      "rm",
      "readdir",
      "stat",
      "lstat",
      "symlink",
      "readlink",
      "access",
      "appendFile",
      "chmod",
      "chown",
      "copyFile",
      "cp",
      "link",
      "lutimes",
      "mkdtemp",
      "open",
      "opendir",
      "realpath",
      "rename",
      "rmdir",
      "statfs",
      "truncate",
      "unlink",
      "utimes",
      "watch",
    ]) {
      expect(typeof (shim.promises as Record<string, unknown>)[name], `promises.${name}`).toBe(
        "function",
      );
    }
    expect(shim.promises.constants).toBe(shim.constants);
    expect(typeof shim.promises.FileHandle).toBe("function");
  });
});
