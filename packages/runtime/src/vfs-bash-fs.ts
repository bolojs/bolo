import type { VfsBus } from "@bolojs/fs";
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";

// just-bash's public entry points (`.` / `./browser`) don't re-export these
// three fs/interface.ts types, so they're mirrored locally to match its shape.
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
  encoding?: BufferEncoding;
}
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

const decodeContent = (raw: Uint8Array, encoding: BufferEncoding = "utf8"): string => {
  if (encoding === "utf8" || encoding === "utf-8") return new TextDecoder().decode(raw);
  return Buffer.from(raw).toString(encoding);
};

const toBytes = (content: FileContent): Uint8Array =>
  content instanceof Uint8Array ? content : new TextEncoder().encode(content);

const resolveOptions = (
  options?: ReadFileOptions | WriteFileOptions | BufferEncoding | null,
): BufferEncoding | undefined =>
  typeof options === "string" ? options : (options?.encoding ?? undefined);

/**
 * Adapter: just-bash IFileSystem → VfsBus.
 *
 * INVARIANT: probe methods (exists/stat/readdir/readdirWithFileTypes/lstat/
 * chmod/symlink/link/readlink/realpath/utimes/getAllPaths) are HOT-ONLY.
 * They use `vfs.hot.*Sync` and never reach the OPFS cold tier. This is
 * mandatory: just-bash's command resolution PATH-searches /usr/bin/<cmd>
 * and /bin/<cmd> before every command (until hashTable caches it), and a
 * cold roundtrip there stalls the shell for up to 10s per miss.
 *
 * Content reads (readFile/readFileBuffer) DO use the async vfs.* path so
 * `cat /old/file-from-prior-session` can hydrate from OPFS on demand. This
 * asymmetry is intentional: cat is allowed to be slow; ls and command
 * resolution are not.
 *
 * The sync methods mkdirSync/writeFileSync satisfy just-bash's isSyncInitFs()
 * (fs/init.ts:27), which gates creation of /bin, /usr/bin, /dev, /proc and
 * the command-stub files registerCommand() (Bash.ts:520) writes into /bin.
 * Without them, every exists("/usr/bin/<cmd>") misses hot and stalls.
 */
export class VfsBashFileSystem implements IFileSystem {
  constructor(private vfs: VfsBus) {}

  // Satisfies just-bash's isSyncInitFs() (fs/init.ts:27) so init creates
  // /bin, /usr/bin, /dev, /proc and registerCommand (Bash.ts:520) creates
  // /bin/<cmd> stubs. Writes go to hot ONLY — persistence is VfsBus's job.
  mkdirSync(path: string, options?: { recursive?: boolean }): void {
    this.vfs.hot.mkdirSync(path, { recursive: options?.recursive ?? false });
  }

  writeFileSync(path: string, content: FileContent): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir && !this.vfs.hot.existsSync(dir)) {
      this.vfs.hot.mkdirSync(dir, { recursive: true });
    }
    this.vfs.hot.writeFileSync(path, bytes);
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return path;
    const parts = base.split("/").filter(Boolean);
    for (const seg of path.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== "." && seg !== "") parts.push(seg);
    }
    return "/" + parts.join("/");
  }

  private async ensureHydrated(path: string): Promise<void> {
    if (this.vfs.hot.existsSync(path)) return;
    try {
      await this.vfs.readFile(path);
      return;
    } catch {
      /* not a file, or doesn't exist */
    }
    try {
      await this.vfs.readdir(path);
    } catch {
      /* genuinely doesn't exist; caller's sync op will throw ENOENT */
    }
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const raw = await this.readFileBuffer(path);
    return decodeContent(raw, resolveOptions(options) ?? "utf8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const data = await this.vfs.readFile(path);
    return data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const encoding = resolveOptions(options);
    const bytes =
      typeof content === "string" && encoding && encoding !== "utf8" && encoding !== "utf-8"
        ? Buffer.from(content, encoding)
        : toBytes(content);
    await this.vfs.writeFile(path, bytes);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    let existing: Uint8Array;
    try {
      existing = await this.readFileBuffer(path);
    } catch {
      existing = new Uint8Array(0);
    }
    const encoding = resolveOptions(options);
    const appended =
      typeof content === "string" && encoding && encoding !== "utf8" && encoding !== "utf-8"
        ? Buffer.from(content, encoding)
        : toBytes(content);
    const merged = new Uint8Array(existing.length + appended.length);
    merged.set(existing, 0);
    merged.set(appended, existing.length);
    await this.vfs.writeFile(path, merged);
  }

  async exists(path: string): Promise<boolean> {
    return this.vfs.hot.existsSync(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.vfs.mkdir(path, { recursive: options?.recursive ?? false });
  }

  async readdir(path: string): Promise<string[]> {
    const entries = this.vfs.hot.readdirSync(path, { withFileTypes: false }) as string[];
    return entries;
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const entries = this.vfs.hot.readdirSync(path, { withFileTypes: true }) as Array<{
      name: string;
      isFile(): boolean;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    }>;
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymbolicLink: e.isSymbolicLink(),
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    try {
      await this.vfs.rm(path, { recursive: options?.recursive ?? false });
    } catch (err) {
      if (options?.force) return;
      throw err;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const stat = this.vfs.hot.statSync(src);
    if (stat.isDirectory()) {
      if (!options?.recursive) {
        throw new Error(`cp: -r not specified; omitting directory '${src}'`);
      }
      await this.mkdir(dest, { recursive: true });
      const entries = await this.readdir(src);
      for (const entry of entries) {
        await this.cp(`${src}/${entry}`, `${dest}/${entry}`, options);
      }
      return;
    }
    const bytes = await this.readFileBuffer(src);
    await this.vfs.writeFile(dest, bytes);
  }

  async mv(src: string, dest: string): Promise<void> {
    try {
      await this.vfs.rename(src, dest);
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "EEXIST") {
        await this.vfs.rm(dest, { recursive: true });
        await this.vfs.rename(src, dest);
        return;
      }
      throw err;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const s = this.vfs.hot.statSync(path);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      mode: Number(s.mode),
      size: Number(s.size),
      mtime: s.mtime,
    };
  }

  async lstat(path: string): Promise<FsStat> {
    const s = this.vfs.hot.lstatSync(path);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      mode: Number(s.mode),
      size: Number(s.size),
      mtime: s.mtime,
    };
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.vfs.hot.chmodSync(path, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.vfs.hot.symlinkSync(target, linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.vfs.hot.linkSync(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    return this.vfs.hot.readlinkSync(path) as string;
  }

  async realpath(path: string): Promise<string> {
    return this.vfs.hot.realpathSync(path) as string;
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.vfs.hot.utimesSync(path, atime, mtime);
  }

  getAllPaths(): string[] {
    return Object.keys(this.vfs.snapshot());
  }
}
