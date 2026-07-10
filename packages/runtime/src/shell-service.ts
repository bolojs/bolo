import type { VfsBus } from "@browser-containers/vfs-bus";
import type { PackageManager } from "@browser-containers/npm";
import type { SWSandbox } from "@browser-containers/sw-sandbox";
import { BrowserViteServer } from "@browser-containers/vite-server";
import { bundleEntry } from "@browser-containers/wasm-registry";
import { createLiveShimRegistry } from "@browser-containers/node-runtime-shims";
import { Bash } from "just-bash/browser";
import type { RuntimeWorker } from "./runtime-worker.js";
import type { SandboxPool } from "./sandbox-pool.js";
import type { ContainerEvents } from "./events.js";
import { VfsBashFileSystem } from "./vfs-bash-fs.js";

declare global {
  // Populated just before executing a bundled node app so its aliased `node:*`
  // imports (see `bundleEntry`'s node-alias plugin) can bind to this
  // container's live `VfsBus`/`SWSandbox` instead of a fresh one per bundle.
  // eslint-disable-next-line no-var
  var __browserContainers:
    | { vfs: VfsBus; sandbox?: SWSandbox; shims: Record<string, unknown> }
    | undefined;
}

export interface ShellServiceDeps {
  vfs: VfsBus;
  sandbox?: SWSandbox;
  events?: ContainerEvents;
  packageManager: PackageManager;
  runtimeWorker: RuntimeWorker;
  sandboxPool: SandboxPool;
  workdir?: string;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OutputCallbacks {
  stdout: (data: string) => void;
  stderr: (data: string) => void;
}

export class ShellService {
  private deps: ShellServiceDeps;
  private cwd: string;
  private bash: Bash;
  private viteWatcher?: ReturnType<VfsBus["watch"]>;

  constructor(deps: ShellServiceDeps) {
    this.deps = deps;
    this.cwd = deps.workdir ?? "/";
    this.bash = new Bash({ fs: new VfsBashFileSystem(deps.vfs), cwd: this.cwd });
  }

  async execute(command: string, output?: Partial<OutputCallbacks>): Promise<ShellResult> {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const callbacks: OutputCallbacks = {
      stdout: (data: string) => {
        stdoutChunks.push(data);
        output?.stdout?.(data);
      },
      stderr: (data: string) => {
        stderrChunks.push(data);
        output?.stderr?.(data);
      },
    };

    try {
      const exitCode = await this.route(command, callbacks);
      return {
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.stderr(message);
      return {
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: 1,
      };
    }
  }

  /** Resolve a user-supplied path against the workdir. */
  private resolvePath(p: string): string {
    if (this.cwd === "/" || p.startsWith(this.cwd)) return p;
    return p.startsWith("/") ? `${this.cwd}${p}` : `${this.cwd}/${p}`;
  }

  private async route(command: string, output: OutputCallbacks): Promise<number> {
    const [cmd, ...rest] = command.trim().split(/\s+/);

    if (cmd === "npm") return this.routeNpm(rest, output);
    if (cmd === "runtime") return this.routeRuntime(rest, output);
    if (cmd === "agent") return this.routeAgent(rest, output);
    if (cmd === "node" || cmd === "bun") {
      const filePath = rest[0];
      if (!filePath) {
        output.stderr(`Usage: ${cmd} <script>`);
        return 1;
      }
      return this.runNodeApp(filePath, output);
    }

    // just-bash restores cwd to its pre-call value after each exec(), so the
    // shell's persistent working directory is threaded through explicitly.
    const result = await this.bash.exec(command, { cwd: this.cwd });
    if (result.stdout) output.stdout(result.stdout);
    if (result.stderr) output.stderr(result.stderr);
    this.cwd = result.env.PWD ?? this.cwd;
    return result.exitCode;
  }

  private async routeNpm(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd !== "install" && subcmd !== "i") {
      if (subcmd === "run") return this.routeNpmRun(rest, output);
      output.stderr(`Unsupported npm subcommand: ${subcmd}`);
      return 1;
    }

    try {
      if (rest.length > 0) {
        await this.deps.packageManager.install(rest);
      } else {
        await this.deps.packageManager.install();
      }
      return 0;
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  private async routeNpmRun(args: string[], output: OutputCallbacks): Promise<number> {
    const scriptName = args[0];

    if (scriptName === "dev") {
      if (!this.deps.sandbox) {
        output.stderr("No sandbox configured for dev server");
        return 1;
      }
      try {
        const root = this.deps.workdir ?? "/";
        const previewPrefix = "/__preview/";
        const server = new BrowserViteServer({ vfs: this.deps.vfs, root, base: previewPrefix });
        await server.start();
        this.viteWatcher = this.deps.vfs.watch("**", (path) => {
          if (!path.includes("node_modules") && !path.endsWith("importmap.json")) {
            server.broadcastHmr({ type: "full-reload", path });
          }
        });
        this.deps.sandbox.onFetch(async (req) => {
          const url = new URL(req.url);
          if (!url.pathname.startsWith(previewPrefix)) {
            throw new Error("not handled");
          }
          const serverUrl = new URL(req.url);
          serverUrl.pathname = url.pathname.replace(/^\/(__preview)/, "") || "/";
          const response = await server.onFetch(serverUrl.toString(), req);
          const headers = new Headers(response.headers);
          headers.set("Cross-Origin-Embedder-Policy", "credentialless");
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          headers.set("Cross-Origin-Resource-Policy", "cross-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        });
        this.deps.events?.emit("port", 3000, "open", previewPrefix);
        this.deps.events?.emit("server-ready", 3000, previewPrefix);
        return 0;
      } catch (err) {
        output.stderr(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }

    try {
      const pkgPath = this.resolvePath("package.json");
      const pkgContent = await this.deps.vfs.readFile(pkgPath);
      const pkg = JSON.parse(String(pkgContent)) as { scripts?: Record<string, string> };
      const scriptCmd = pkg.scripts?.[scriptName];
      if (!scriptCmd) {
        output.stderr(`Missing script: "${scriptName}"\n`);
        output.stderr(`Available scripts: ${Object.keys(pkg.scripts ?? {}).join(", ") || "(none)"}\n`);
        return 1;
      }
      return this.route(scriptCmd, output);
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  private async routeRuntime(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd !== "run") {
      output.stderr(`Unsupported runtime subcommand: ${subcmd}`);
      return 1;
    }

    const filePath = rest[0];
    if (!filePath) {
      output.stderr("Usage: runtime run <script>");
      return 1;
    }

    return this.runNodeApp(filePath, output);
  }

  /**
   * Resolves and bundles a node entry point over the VFS (see `bundleEntry`),
   * with `node:*` builtins aliased to this container's live shims, then
   * executes the self-contained bundle in the main realm via a blob import.
   * `http.createServer().listen()` inside the app fires `onPortEvent`, which
   * is forwarded through the same `events.emit('port', …)` the dev server
   * (`routeNpmRun`, above) uses, so a node server drives the preview iframe
   * identically to `npm run dev`.
   */
  private async runNodeApp(filePath: string, output: OutputCallbacks): Promise<number> {
    try {
      const onPortEvent = (event: string, data: { port: number; url?: string }) => {
        const url = data.url ?? "";
        if (event === "server-ready") this.deps.events?.emit("server-ready", data.port, url);
        if (event === "port-open") this.deps.events?.emit("port", data.port, "open", url);
        if (event === "port-close") this.deps.events?.emit("port", data.port, "close", url);
      };

      // User files are written under the workdir but referenced with paths
      // relative to it (e.g. '/server.ts' → '/home/web/server.ts').
      const entry = this.resolvePath(filePath);

      globalThis.__browserContainers = {
        vfs: this.deps.vfs,
        sandbox: this.deps.sandbox,
        shims: createLiveShimRegistry({
          vfs: this.deps.vfs,
          sandbox: this.deps.sandbox,
          onPortEvent,
          shellService: { exec: (cmd, cmdArgs) => this.execute([cmd, ...cmdArgs].join(" ")) },
          cwd: this.cwd,
          argv: ["node", entry],
          onStdout: output.stdout,
          onStderr: output.stderr,
        }),
      };

      const { code, warnings } = await bundleEntry(entry, {
        vfs: this.deps.vfs,
        cwd: this.cwd,
        getShim: (builtin) =>
          globalThis.__browserContainers?.shims[builtin] as Record<string, unknown> | undefined,
      });
      for (const warning of warnings) output.stderr(`[bundle warning] ${warning}\n`);

      const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
        default?: { fetch?: (req: Request) => Promise<Response> };
      };
      // Hono/workers-style: if the module exports a default with a `.fetch`
      // method, auto-register it as a fetch handler so the server starts
      // without an explicit http.createServer().listen() call.
      const exportedApp = mod?.default;
      if (exportedApp && typeof exportedApp.fetch === "function" && this.deps.sandbox) {
        this.deps.sandbox.onFetch(exportedApp.fetch.bind(exportedApp));
        onPortEvent("server-ready", { port: 3000, url: "https://sandbox.local" });
        onPortEvent("port-open", { port: 3000, url: "https://sandbox.local" });
      }
      return 0;
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  private async routeAgent(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd !== "run") {
      output.stderr(`Unsupported agent subcommand: ${subcmd}`);
      return 1;
    }

    const filePath = rest[0];
    if (!filePath) {
      output.stderr("Usage: agent run <script>");
      return 1;
    }

    try {
      const code = String(await this.deps.vfs.readFile(filePath));
      const result = await this.deps.sandboxPool.run(code);
      if (result.error) {
        output.stderr(result.error);
        return 1;
      }
      if (result.result) {
        output.stdout(result.result);
      }
      return 0;
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
}
