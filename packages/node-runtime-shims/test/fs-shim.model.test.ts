import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { VfsBus } from "@bolojs/fs";
import { createFsShim, type FsShim } from "../src/fs-shim.js";
import { fcParams } from "../../../tests/unit/property/fc-config.ts";

/**
 * Model-based property test: random sequences of write/append/mkdir/rename/
 * rm/readdir/stat run against both `createFsShim(new VfsBus())` and real
 * node:fs on a temp dir. After every command the observable outcome
 * (threw-ness, entries, stat flags, contents) must agree, and at the end of
 * each sequence the whole trees must be identical.
 *
 * append/rename drive the shim's own appendFile/rename surface (memfs-backed).
 * Rename targets that already exist stay filtered out: memfs performs
 * cross-type renames (file↔dir) where node throws EISDIR/ENOTDIR — recorded
 * in tests/unit/regressions/vfs-fs-shim-divergences.
 */

interface Model {
  dirs: Set<string>;
  files: Map<string, string>;
}

interface Real {
  vfs: VfsBus;
  shim: FsShim;
  tmp: string;
}

const dirPath = fc.constantFrom("/a", "/b", "/c", "/a/d", "/b/e");
const filePath = fc.constantFrom(
  "/a/f.txt",
  "/b/f.txt",
  "/c/f.txt",
  "/f1.txt",
  "/f2.txt",
  "/a/d/g.txt",
  "/b/e/g.txt",
);
const anyPath = fc.oneof(dirPath, filePath);
const data = fc.string({ maxLength: 32 });

const parentOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};

const realPath = (tmp: string, p: string): string => nodePath.join(tmp, p);

const threw = async (f: () => unknown | Promise<unknown>): Promise<boolean> => {
  try {
    await f();
    return false;
  } catch {
    return true;
  }
};

const movePrefix = (model: Model, from: string, to: string): void => {
  for (const d of [...model.dirs]) {
    if (d === from || d.startsWith(`${from}/`)) {
      model.dirs.delete(d);
      model.dirs.add(to + d.slice(from.length));
    }
  }
  for (const [f, c] of [...model.files]) {
    if (f === from || f.startsWith(`${from}/`)) {
      model.files.delete(f);
      model.files.set(to + f.slice(from.length), c);
    }
  }
};

class WriteFileCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly path: string,
    readonly data: string,
  ) {}
  check = (m: Model): boolean =>
    // VfsBus.writeFile auto-creates missing parent dirs where node throws
    // ENOENT — recorded in tests/unit/regressions/vfs-fs-shim-divergences.
    m.dirs.has(parentOf(this.path));
  run = async (m: Model, r: Real): Promise<void> => {
    const shimThrew = await threw(() => r.shim.writeFile(this.path, this.data));
    const nodeThrew = await threw(() =>
      nodeFs.writeFileSync(realPath(r.tmp, this.path), this.data),
    );
    expect(shimThrew).toBe(nodeThrew);
    if (shimThrew) return;
    m.files.set(this.path, this.data);
    expect(await r.shim.readFile(this.path, "utf8")).toBe(
      nodeFs.readFileSync(realPath(r.tmp, this.path), "utf8"),
    );
  };
  toString = (): string => `writeFile(${JSON.stringify(this.path)}, ${JSON.stringify(this.data)})`;
}

class AppendFileCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly path: string,
    readonly data: string,
  ) {}
  check = (m: Model): boolean => !m.dirs.has(this.path);
  run = async (m: Model, r: Real): Promise<void> => {
    const shimThrew = await threw(() => r.shim.appendFileSync(this.path, this.data));
    const nodeThrew = await threw(() =>
      nodeFs.appendFileSync(realPath(r.tmp, this.path), this.data),
    );
    expect(shimThrew).toBe(nodeThrew);
    if (shimThrew) return;
    const expected = (m.files.get(this.path) ?? "") + this.data;
    m.files.set(this.path, expected);
    expect(await r.shim.readFile(this.path, "utf8")).toBe(
      nodeFs.readFileSync(realPath(r.tmp, this.path), "utf8"),
    );
  };
  toString = (): string => `appendFile(${JSON.stringify(this.path)}, ${JSON.stringify(this.data)})`;
}

class MkdirCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly path: string,
    readonly recursive: boolean,
  ) {}
  check = (m: Model): boolean =>
    // memfs mkdirSync(recursive:true) on an existing *file* silently
    // succeeds where node throws EEXIST — recorded in the regressions file.
    !(this.recursive && m.files.has(this.path));
  run = async (m: Model, r: Real): Promise<void> => {
    const shimThrew = await threw(() => r.shim.mkdir(this.path, { recursive: this.recursive }));
    const nodeThrew = await threw(() =>
      nodeFs.mkdirSync(realPath(r.tmp, this.path), { recursive: this.recursive }),
    );
    expect(shimThrew).toBe(nodeThrew);
    if (shimThrew) return;
    // Register every ancestor the recursive mkdir may have created.
    let p = this.path;
    for (;;) {
      m.dirs.add(p);
      if (p === "/") break;
      p = parentOf(p);
    }
    expect((await r.shim.stat(this.path)).isDirectory()).toBe(
      nodeFs.statSync(realPath(r.tmp, this.path)).isDirectory(),
    );
  };
  toString = (): string => `mkdir(${JSON.stringify(this.path)}, {recursive:${this.recursive}})`;
}

class RenameCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {}
  check = (m: Model): boolean =>
    // Existing targets stay out: memfs rename performs cross-type renames
    // (file↔dir) where node throws EISDIR/ENOTDIR — see regression file.
    // Renaming a dir into its own subtree is also excluded (EINVAL on both,
    // but error codes differ in kind).
    this.from !== this.to &&
    !m.files.has(this.to) &&
    !m.dirs.has(this.to) &&
    !this.to.startsWith(`${this.from}/`);
  run = async (m: Model, r: Real): Promise<void> => {
    const shimThrew = await threw(() => r.shim.renameSync(this.from, this.to));
    const nodeThrew = await threw(() =>
      nodeFs.renameSync(realPath(r.tmp, this.from), realPath(r.tmp, this.to)),
    );
    expect(shimThrew).toBe(nodeThrew);
    if (shimThrew) return;
    movePrefix(m, this.from, this.to);
    expect(await r.shim.exists(this.to)).toBe(nodeFs.existsSync(realPath(r.tmp, this.to)));
  };
  toString = (): string => `rename(${JSON.stringify(this.from)}, ${JSON.stringify(this.to)})`;
}

class RmCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly path: string,
    readonly recursive: boolean,
  ) {}
  check = (): boolean => true;
  run = async (m: Model, r: Real): Promise<void> => {
    const shimThrew = await threw(() => r.shim.rm(this.path, { recursive: this.recursive }));
    const nodeThrew = await threw(() =>
      nodeFs.rmSync(realPath(r.tmp, this.path), { recursive: this.recursive }),
    );
    expect(shimThrew).toBe(nodeThrew);
    if (shimThrew) return;
    m.dirs.delete(this.path);
    m.files.delete(this.path);
    for (const d of [...m.dirs]) if (d.startsWith(`${this.path}/`)) m.dirs.delete(d);
    for (const f of [...m.files.keys()]) if (f.startsWith(`${this.path}/`)) m.files.delete(f);
    expect(await r.shim.exists(this.path)).toBe(nodeFs.existsSync(realPath(r.tmp, this.path)));
  };
  toString = (): string => `rm(${JSON.stringify(this.path)}, {recursive:${this.recursive}})`;
}

class ReaddirCommand implements fc.AsyncCommand<Model, Real> {
  constructor(readonly path: string) {}
  check = (): boolean => true;
  run = async (m: Model, r: Real): Promise<void> => {
    const shimEntries = await r.shim.readdir(this.path).then(
      (e) => ({ ok: true as const, entries: e }),
      () => ({ ok: false as const, entries: [] as string[] }),
    );
    const nodeEntries = await (async () => nodeFs.readdirSync(realPath(r.tmp, this.path)))().then(
      (e) => ({ ok: true as const, entries: e }),
      () => ({ ok: false as const, entries: [] as string[] }),
    );
    expect(shimEntries.ok).toBe(nodeEntries.ok);
    if (shimEntries.ok) {
      expect([...shimEntries.entries].sort()).toEqual([...nodeEntries.entries].sort());
    }
  };
  toString = (): string => `readdir(${JSON.stringify(this.path)})`;
}

class StatCommand implements fc.AsyncCommand<Model, Real> {
  constructor(readonly path: string) {}
  check = (m: Model): boolean =>
    // The shim synthesizes an all-false stat for missing paths where node
    // throws ENOENT — recorded in the regressions file.
    m.files.has(this.path) || m.dirs.has(this.path);
  run = async (m: Model, r: Real): Promise<void> => {
    const s = await r.shim.stat(this.path);
    const t = nodeFs.statSync(realPath(r.tmp, this.path));
    expect(s.isFile()).toBe(t.isFile());
    expect(s.isDirectory()).toBe(t.isDirectory());
    if (t.isFile()) expect(s.size).toBe(t.size);
  };
  toString = (): string => `stat(${JSON.stringify(this.path)})`;
}

const snapshotVfs = (vfs: VfsBus): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (p: string): void => {
    for (const name of vfs.hot.readdirSync(p)) {
      const full = p === "/" ? `/${name}` : `${p}/${name}`;
      const st = vfs.hot.statSync(full);
      if (st.isDirectory()) {
        out.set(full, "d");
        walk(full);
      } else {
        out.set(full, `f:${vfs.hot.readFileSync(full, "utf8")}`);
      }
    }
  };
  walk("/");
  return out;
};

const snapshotReal = (tmp: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (abs: string, rel: string): void => {
    for (const name of nodeFs.readdirSync(abs)) {
      const fullRel = rel === "/" ? `/${name}` : `${rel}/${name}`;
      const st = nodeFs.statSync(nodePath.join(abs, name));
      if (st.isDirectory()) {
        out.set(fullRel, "d");
        walk(nodePath.join(abs, name), fullRel);
      } else {
        out.set(fullRel, `f:${nodeFs.readFileSync(nodePath.join(abs, name), "utf8")}`);
      }
    }
  };
  walk(tmp, "/");
  return out;
};

describe("VfsBus + fs shim model test vs node:fs", () => {
  it("random op sequences produce identical observable state", async () => {
    const commandArbs = [
      fc.tuple(filePath, data).map(([path, d]) => new WriteFileCommand(path, d)),
      fc.tuple(filePath, data).map(([path, d]) => new AppendFileCommand(path, d)),
      fc.tuple(dirPath, fc.boolean()).map(([path, recursive]) => new MkdirCommand(path, recursive)),
      fc.tuple(anyPath, anyPath).map(([from, to]) => new RenameCommand(from, to)),
      fc.tuple(anyPath, fc.boolean()).map(([path, recursive]) => new RmCommand(path, recursive)),
      anyPath.map((path) => new ReaddirCommand(path)),
      anyPath.map((path) => new StatCommand(path)),
    ];

    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 15 }), async (cmds) => {
        const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "vfs-model-"));
        const vfs = new VfsBus();
        const real: Real = { vfs, shim: createFsShim(vfs), tmp };
        try {
          const model: Model = { dirs: new Set(["/"]), files: new Map() };
          await fc.asyncModelRun(() => ({ model, real }), cmds);
          // Final invariant: whole trees identical.
          expect(snapshotVfs(vfs)).toEqual(snapshotReal(tmp));
        } finally {
          nodeFs.rmSync(tmp, { recursive: true, force: true });
        }
      }),
      fcParams(),
    );
  });
});
