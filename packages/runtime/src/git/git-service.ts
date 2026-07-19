import type { VfsBus } from "@bolojs/vfs-bus";
import type { AuthCallback, HttpClient } from "isomorphic-git";
import type * as Git from "isomorphic-git";
import { createGitFs } from "./fs-adapter.js";

export interface GitServiceDeps {
  vfs: VfsBus;
  cwd: string;
  stdout: (line: string) => void;
  corsProxy?: string;
  author?: { name: string; email: string };
}

const DEFAULT_CORS_PROXY = "https://cors.isomorphic-git.org";
const DEFAULT_AUTHOR = {
  name: "bolo demo",
  email: "bolo@users.noreply.github.invalid",
};

const SUPPORTED = [
  "init",
  "clone",
  "status",
  "add",
  "commit",
  "log",
  "branch",
  "checkout",
  "fetch",
  "pull",
  "push",
  "remote",
  "diff",
];

const statusToXY = (status: string): string | null => {
  switch (status) {
    case "unmodified":
    case "ignored":
    case "absent":
    case "*unmodified":
    case "*absent":
      return null;
    case "*modified":
      return " M";
    case "*added":
      return "??";
    case "*deleted":
      return " D";
    case "*undeleted":
      return "A ";
    case "*undeletemodified":
      return "AM";
    case "modified":
      return "M ";
    case "added":
      return "A ";
    case "deleted":
      return "D ";
    default:
      return "??";
  }
};

export class GitService {
  private vfs: VfsBus;
  private cwd: string;
  private stdout: (line: string) => void;
  private corsProxy: string;
  private author: { name: string; email: string };

  constructor(deps: GitServiceDeps) {
    this.vfs = deps.vfs;
    this.cwd = deps.cwd;
    this.stdout = deps.stdout;
    this.corsProxy = deps.corsProxy ?? DEFAULT_CORS_PROXY;
    this.author = deps.author ?? DEFAULT_AUTHOR;
  }

  static getSupported(): string[] {
    return SUPPORTED;
  }

  private get fs() {
    return createGitFs(this.vfs);
  }

  private async gitModule(): Promise<typeof Git> {
    return (await import("isomorphic-git")) as typeof Git;
  }

  private async httpModule(): Promise<HttpClient> {
    const { default: http } = await import("isomorphic-git/http/web");
    return http as HttpClient;
  }

  private onProgress = (event: { phase: string; loaded: number; total: number }) => {
    this.stdout(`${event.phase} ${event.loaded}/${event.total}`);
  };

  private parseAuth(args: string[]): { username: string; password: string } | undefined {
    const idx = args.indexOf("-u");
    if (idx !== -1 && args[idx + 1]) {
      const [username, password] = args[idx + 1].split(":");
      if (username && password) return { username, password };
    }
    return undefined;
  }

  // ponytail: args-based auth only. Terminal prompt loop is a nice v2, but
  // for Phase 1 a `-u user:pat` credential is enough for demo clones.
  private authCallback(args: string[]): AuthCallback {
    return (_url) => {
      const auth = this.parseAuth(args);
      if (!auth) return { cancel: true };
      return { username: auth.username, password: auth.password };
    };
  }

  private error(message: string): number {
    this.stdout(`git: ${message}`);
    return 1;
  }

  async init(_args: string[]): Promise<number> {
    try {
      const git = await this.gitModule();
      await git.init({ fs: this.fs, dir: this.cwd, defaultBranch: "main" });
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async clone(args: string[]): Promise<number> {
    const url = args.find((a) => !a.startsWith("-"));
    if (!url) return this.error("clone requires a URL");

    let depth = 1;
    let singleBranch = true;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--depth") depth = Number(args[++i]) || 1;
      if (args[i] === "--single-branch") singleBranch = true;
      if (args[i] === "--no-single-branch") singleBranch = false;
    }

    try {
      const [git, http] = await Promise.all([this.gitModule(), this.httpModule()]);
      await git.clone({
        fs: this.fs,
        http,
        dir: this.cwd,
        url,
        corsProxy: this.corsProxy,
        depth,
        singleBranch,
        onProgress: this.onProgress,
        onAuth: this.authCallback(args),
      });
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async status(_args: string[]): Promise<number> {
    try {
      const git = await this.gitModule();
      const matrix = await git.statusMatrix({ fs: this.fs, dir: this.cwd });
      const lines: [string, string][] = [];
      for (const [filepath] of matrix) {
        const status = await git.status({
          fs: this.fs,
          dir: this.cwd,
          filepath,
          refresh: true,
        });
        const xy = statusToXY(status);
        if (xy) lines.push([filepath, xy]);
      }
      lines.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [filepath, xy] of lines) {
        this.stdout(`${xy} ${filepath}`);
      }
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async add(args: string[]): Promise<number> {
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length === 0) return this.error("add requires file path(s)");

    try {
      const git = await this.gitModule();
      await git.add({ fs: this.fs, dir: this.cwd, filepath: files });
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async commit(args: string[]): Promise<number> {
    let message = "";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-m" || args[i] === "--message") {
        message = args[++i] ?? "";
      }
    }
    if (!message) return this.error("commit requires a message (-m)");

    try {
      const git = await this.gitModule();
      const sha = await git.commit({
        fs: this.fs,
        dir: this.cwd,
        message,
        author: this.author,
      });
      this.stdout(`[main ${sha.slice(0, 7)}] ${message}`);
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async log(args: string[]): Promise<number> {
    const oneline = args.includes("--oneline");
    try {
      const git = await this.gitModule();
      const commits = await git.log({ fs: this.fs, dir: this.cwd });
      for (const commit of commits) {
        if (oneline) {
          this.stdout(`${commit.oid.slice(0, 7)} ${commit.commit.message.trim()}`);
        } else {
          const author = commit.commit.author;
          const date = new Date(author.timestamp * 1000).toString();
          this.stdout(`commit ${commit.oid}`);
          this.stdout(`Author: ${author.name} <${author.email}>`);
          this.stdout(`Date:   ${date}`);
          this.stdout("");
          this.stdout(`    ${commit.commit.message.trim()}`);
        }
      }
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async branch(_args: string[]): Promise<number> {
    try {
      const git = await this.gitModule();
      const current = await git.currentBranch({ fs: this.fs, dir: this.cwd });
      const branches = await git.listBranches({ fs: this.fs, dir: this.cwd });
      branches.sort();
      for (const branch of branches) {
        const prefix = branch === current ? "*" : " ";
        this.stdout(`${prefix} ${branch}`);
      }
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async checkout(args: string[]): Promise<number> {
    const ref = args.find((a) => !a.startsWith("-"));
    if (!ref) return this.error("checkout requires a ref");

    try {
      const git = await this.gitModule();
      await git.checkout({ fs: this.fs, dir: this.cwd, ref });
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async fetch(args: string[]): Promise<number> {
    try {
      const [git, http] = await Promise.all([this.gitModule(), this.httpModule()]);
      await git.fetch({
        fs: this.fs,
        http,
        dir: this.cwd,
        remote: args[0] || "origin",
        corsProxy: this.corsProxy,
        onProgress: this.onProgress,
        onAuth: this.authCallback(args),
      });
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async pull(args: string[]): Promise<number> {
    try {
      const [git, http] = await Promise.all([this.gitModule(), this.httpModule()]);
      await git.pull({
        fs: this.fs,
        http,
        dir: this.cwd,
        remote: args[0] || "origin",
        corsProxy: this.corsProxy,
        author: this.author,
        onProgress: this.onProgress,
        onAuth: this.authCallback(args),
      });
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async push(args: string[]): Promise<number> {
    try {
      const [git, http] = await Promise.all([this.gitModule(), this.httpModule()]);
      await git.push({
        fs: this.fs,
        http,
        dir: this.cwd,
        remote: args[0] || "origin",
        corsProxy: this.corsProxy,
        onProgress: this.onProgress,
        onAuth: this.authCallback(args),
      });
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async remote(args: string[]): Promise<number> {
    if (!args.includes("-v")) return this.error("remote only supports -v");

    try {
      const git = await this.gitModule();
      const remotes = await git.listRemotes({ fs: this.fs, dir: this.cwd });
      for (const { remote, url } of remotes) {
        this.stdout(`${remote}\t${url} (fetch)`);
        this.stdout(`${remote}\t${url} (push)`);
      }
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }

  async diff(_args: string[]): Promise<number> {
    // ponytail: isomorphic-git has no diff() primitive. Use statusMatrix to
    // emit a compact report of changed paths. A real unified diff is v2 work.
    try {
      const git = await this.gitModule();
      const matrix = await git.statusMatrix({ fs: this.fs, dir: this.cwd });
      for (const [filepath, head, workdir, stage] of matrix) {
        if (head === 1 && workdir === 1 && stage === 1) continue;
        this.stdout(`diff --git a/${filepath} b/${filepath}`);
        if (workdir === 0) {
          this.stdout(`deleted: ${filepath}`);
        } else if (head === 0) {
          this.stdout(`new file: ${filepath}`);
        } else {
          this.stdout(`modified: ${filepath}`);
        }
      }
      return 0;
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
  }
}
