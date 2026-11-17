import { describe, it, expect, vi, beforeEach } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { BOLO_NODE_VERSION } from "@bolojs/node-runtime-shims";
import { ShellService, type ShellServiceDeps } from "./shell-service.js";

const createMockDeps = (): ShellServiceDeps => {
  const vfs = new VfsBus();
  vfs.readFile = vi.fn().mockResolvedValue('console.log("hello")') as typeof vfs.readFile;
  return {
    vfs,
    packageManager: {
      install: vi.fn().mockResolvedValue(undefined),
    } as unknown as ShellServiceDeps["packageManager"],
    runtimeWorker: {
      runScript: vi.fn().mockResolvedValue(undefined),
      startRepl: vi.fn(),
      onStdout: null,
      onStderr: null,
    } as unknown as ShellServiceDeps["runtimeWorker"],
    sandbox: {
      run: vi.fn().mockResolvedValue({ result: "ok" }),
    } as unknown as ShellServiceDeps["sandbox"],
    swSandbox: {
      onFetch: vi.fn(),
      setPolicyRegistry: vi.fn(),
    } as unknown as ShellServiceDeps["swSandbox"],
    events: {
      emit: vi.fn(),
      on: vi.fn().mockReturnValue(() => {}),
      removeAllListeners: vi.fn(),
    } as unknown as ShellServiceDeps["events"],
  };
};

describe("ShellService", () => {
  let deps: ShellServiceDeps;
  let shell: ShellService;

  beforeEach(() => {
    deps = createMockDeps();
    shell = new ShellService(deps);
  });

  it("npm install <pkgs> → PackageManager.install(pkgs)", async () => {
    const result = await shell.execute("npm install lodash express");
    expect(deps.packageManager.install).toHaveBeenCalledWith(["lodash", "express"]);
    expect(result.exitCode).toBe(0);
  });

  it("npm install (no args) → PackageManager.install()", async () => {
    const result = await shell.execute("npm install");
    expect(deps.packageManager.install).toHaveBeenCalledWith();
    expect(result.exitCode).toBe(0);
  });

  it("npm i (shorthand) works", async () => {
    const result = await shell.execute("npm i react");
    expect(deps.packageManager.install).toHaveBeenCalledWith(["react"]);
    expect(result.exitCode).toBe(0);
  });

  // BrowserViteServer + sandbox.onFetch wiring moved to boot() in 2ac6bb9b.
  // `npm run dev` is now a status print; the preview is live from page load.
  it("npm run dev → prints preview status (wired at boot, not here)", async () => {
    const result = await shell.execute("npm run dev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/__preview/");
    // shell-service must not touch the sandbox from this path anymore.
    expect(deps.swSandbox?.onFetch).not.toHaveBeenCalled();
  });

  it("npm run <other> → reads package.json and routes the script command", async () => {
    vi.mocked(deps.vfs.readFile).mockResolvedValue(
      JSON.stringify({ scripts: { build: "npm install lodash" } }),
    );
    const result = await shell.execute("npm run build");
    expect(deps.vfs.readFile).toHaveBeenCalledWith("package.json");
    expect(deps.packageManager.install).toHaveBeenCalledWith(["lodash"]);
    expect(result.exitCode).toBe(0);
  });

  it("npm run <other> → error when script is missing", async () => {
    vi.mocked(deps.vfs.readFile).mockResolvedValue(
      JSON.stringify({ scripts: { test: "npm install foo" } }),
    );
    const result = await shell.execute("npm run build");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Missing script: "build"');
  });

  it("runtime run script.ts → bundles over the VFS and executes the result", async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      "/app.ts",
      "globalThis.__ranBundledApp = true;",
    );
    const result = await shell.execute("runtime run /app.ts");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect((globalThis as unknown as { __ranBundledApp?: boolean }).__ranBundledApp).toBe(true);
  });

  it("node <file> and bun <file> route through the same bundler path", async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      "/server.ts",
      "globalThis.__ranViaNode = true;",
    );
    const result = await shell.execute("node /server.ts");
    expect(result.exitCode).toBe(0);
    expect((globalThis as unknown as { __ranViaNode?: boolean }).__ranViaNode).toBe(true);
  });

  it("bundled apps get ambient process/Buffer/__dirname/__filename with no explicit import", async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      "/app.ts",
      `globalThis.__globalsProbe = {
        platform: process.platform,
        stdoutWorks: typeof process.stdout.write,
        bufferRoundTrip: Buffer.from('hi').toString(),
        dirname: __dirname,
        filename: __filename,
        nodeEnv: process.env.NODE_ENV,
        hasSetImmediate: typeof setImmediate,
      };`,
    );
    const result = await shell.execute("node /app.ts");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(
      (globalThis as unknown as { __globalsProbe?: Record<string, unknown> }).__globalsProbe,
    ).toEqual({
      platform: "browser",
      stdoutWorks: "function",
      bufferRoundTrip: "hi",
      dirname: "/",
      filename: "/app.ts",
      nodeEnv: "development",
      hasSetImmediate: "function",
    });
  });

  it("bundled apps can import expanded node:* builtins (string_decoder, tty, assert, zlib, module, ...)", async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      "/builtins.ts",
      `import * as stringDecoder from 'node:string_decoder';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import tty from 'node:tty';
assert.ok(true);
const require = createRequire('/builtins.ts');
globalThis.__builtinsProbe = {
  hasStringDecoderExport: typeof stringDecoder.StringDecoder,
  hasGzipStream: typeof zlib.createGzip,
  isTty: tty.isatty(0),
  requireFsWorks: typeof require('node:fs').readFile,
};`,
    );
    const result = await shell.execute("node /builtins.ts");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(
      (globalThis as unknown as { __builtinsProbe?: Record<string, unknown> }).__builtinsProbe,
    ).toEqual({
      hasStringDecoderExport: "function",
      hasGzipStream: "function",
      isTty: false,
      requireFsWorks: "function",
    });
  });

  it("bundled apps get real fs.*Sync backed by the synchronous memfs volume (A3)", async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      "/fs-sync.ts",
      `import fs from 'node:fs';
fs.mkdirSync('/from-sync', { recursive: true });
fs.writeFileSync('/from-sync/out.txt', 'written synchronously');
globalThis.__fsSyncProbe = {
  existed: fs.existsSync('/from-sync/out.txt'),
  content: fs.readFileSync('/from-sync/out.txt', 'utf8'),
  isFile: fs.statSync('/from-sync/out.txt').isFile(),
  dirList: fs.readdirSync('/from-sync'),
};`,
    );
    const result = await shell.execute("node /fs-sync.ts");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(
      (globalThis as unknown as { __fsSyncProbe?: Record<string, unknown> }).__fsSyncProbe,
    ).toEqual({
      existed: true,
      content: "written synchronously",
      isFile: true,
      dirList: ["out.txt"],
    });
  });

  it("bundled http servers get real streaming req/res (A4)", async () => {
    (deps.vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      "/http-stream.ts",
      `import http from 'node:http';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"echo":');
    res.write(JSON.stringify(body));
    res.end('}');
  });
});
server.listen(3000);`,
    );
    const result = await shell.execute("node /http-stream.ts");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);

    const fetchHandler = (deps.swSandbox!.onFetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const req = new Request("http://localhost:3000/", { method: "POST", body: "hello" });
    const resp: Response = await fetchHandler(req);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/json");
    expect(await resp.text()).toBe('{"echo":"hello"}');
  });

  it("node with no args → starts REPL", async () => {
    const result = await shell.execute("node");
    expect(deps.runtimeWorker.startRepl).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("runtime run → error when no file specified", async () => {
    const result = await shell.execute("runtime run");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage");
  });

  it("agent run agent.ts → Sandbox.run()", async () => {
    const result = await shell.execute("agent run bot.ts");
    expect(deps.vfs.readFile).toHaveBeenCalledWith("bot.ts");
    expect(deps.sandbox!.run).toHaveBeenCalledWith('console.log("hello")');
    expect(result.exitCode).toBe(0);
  });

  it("agent run → error when no file specified", async () => {
    const result = await shell.execute("agent run");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage");
  });

  it("wasmRegistry dispatch handles registered tools before just-bash", async () => {
    const dispatch = vi.fn().mockResolvedValue({
      stdout: "0.20.2\n",
      stderr: "",
      exitCode: 0,
    });
    deps.wasmRegistry = { dispatch };
    shell = new ShellService(deps);

    const result = await shell.execute("esbuild --version");
    expect(dispatch).toHaveBeenCalledWith("esbuild", ["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0.20.2\n");
  });

  it("wasmRegistry 'WASM tool not found' falls through to just-bash", async () => {
    const dispatch = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "WASM tool not found: frobnicate",
      exitCode: 1,
    });
    deps.wasmRegistry = { dispatch };
    shell = new ShellService(deps);

    const result = await shell.execute("frobnicate arg");
    expect(dispatch).toHaveBeenCalledWith("frobnicate", ["arg"]);
    // Falls through to just-bash, which reports the missing command.
    expect(result.exitCode).toBe(127);
  });

  it("commands route to just-bash untouched when no wasmRegistry is configured", async () => {
    const result = await shell.execute("frobnicate arg");
    expect(result.exitCode).toBe(127);
  });

  it("unknown command → exit code 127", async () => {
    const result = await shell.execute("foo bar");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("foo: command not found");
  });

  it("npm install error → exit code 1", async () => {
    vi.mocked(deps.packageManager.install).mockRejectedValue(new Error("network fail"));
    const result = await shell.execute("npm install lodash");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("network fail");
  });

  it("stdout/stderr callbacks are invoked", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await shell.execute("npm install foo", {
      stdout: (d) => stdoutChunks.push(d),
      stderr: (d) => stderrChunks.push(d),
    });
    expect(result.exitCode).toBe(0);
  });

  it("unsupported npm subcommand → exit code 1", async () => {
    const result = await shell.execute("npm outdated");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unsupported npm subcommand");
  });

  it("unsupported runtime subcommand → exit code 1", async () => {
    const result = await shell.execute("runtime compile");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unsupported runtime subcommand");
  });

  it("unsupported agent subcommand → exit code 1", async () => {
    const result = await shell.execute("agent list");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unsupported agent subcommand");
  });

  it("node --version and -v → prints v22.12.0", async () => {
    for (const flag of ["--version", "-v"]) {
      const result = await shell.execute(`node ${flag}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${BOLO_NODE_VERSION}\n`);
      expect(result.stdout).toBe("v22.12.0\n");
    }
  });

  it("node --help / -h → usage", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await shell.execute(`node ${flag}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: node <file.js>");
      expect(result.stdout).toContain(BOLO_NODE_VERSION);
    }
  });

  it("node -e evaluates a snippet (console + require of node:*)", async () => {
    const result = await shell.execute(
      `node -e "const fs = require('node:fs'); console.log('eval-ok ' + typeof fs.readFileSync)"`,
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("eval-ok function");
  });

  it("node --eval and --eval=<code> evaluate snippets", async () => {
    const spaced = await shell.execute(`node --eval "console.log('eval-two')"`);
    expect(spaced.exitCode).toBe(0);
    expect(spaced.stdout).toContain("eval-two");

    const inline = await shell.execute(`node --eval=console.log(123)`);
    expect(inline.exitCode).toBe(0);
    expect(inline.stdout).toContain("123");
  });

  it("node -e honours process.exitCode", async () => {
    const result = await shell.execute(`node -e "process.exitCode = 3"`);
    expect(result.exitCode).toBe(3);
  });

  it("node -e with no argument → clear error, not a file lookup", async () => {
    const result = await shell.execute("node -e");
    expect(result.exitCode).toBe(9);
    expect(result.stderr).toContain("-e requires an argument");
  });

  it("node --bogus → bad option error, not an opaque bundler ENOENT", async () => {
    const result = await shell.execute("node --inspect-brk");
    expect(result.exitCode).toBe(9);
    expect(result.stderr).toContain("node: bad option: --inspect-brk");
  });

  it("npx --version / -v → prints the npm version", async () => {
    for (const flag of ["--version", "-v"]) {
      const result = await shell.execute(`npx ${flag}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("10.9.0\n");
    }
  });

  it("npx <tool> resolves node_modules/.bin first and runs it as a node app", async () => {
    const dispatch = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    deps.wasmRegistry = { dispatch };
    shell = new ShellService(deps);

    const hot = deps.vfs.hot as unknown as {
      mkdirSync: (p: string, o?: { recursive?: boolean }) => void;
      writeFileSync: (p: string, c: string) => void;
    };
    hot.mkdirSync("/node_modules/.bin", { recursive: true });
    hot.writeFileSync("/node_modules/.bin/hello-bin", "console.log('ran from .bin');");

    const result = await shell.execute("npx hello-bin");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ran from .bin");
    // A local .bin hit must not reach the wasm registry.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("npx <tool> falls through to the wasm registry when no .bin exists", async () => {
    const dispatch = vi.fn().mockResolvedValue({
      stdout: "0.20.2\n",
      stderr: "",
      exitCode: 0,
    });
    deps.wasmRegistry = { dispatch };
    shell = new ShellService(deps);

    const result = await shell.execute("npx esbuild --version");
    expect(dispatch).toHaveBeenCalledWith("esbuild", ["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0.20.2\n");
  });

  it("npx <unknown> → named error, not 'command not found'", async () => {
    const result = await shell.execute("npx frobnicate");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("npx: 'frobnicate' not found");
    expect(result.stderr).toContain("npm install frobnicate");
  });

  it("npx with no tool → usage", async () => {
    const result = await shell.execute("npx");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: npx");
  });

  it("quoted args reach routed builtins as single argv entries", async () => {
    const dispatch = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "WASM tool not found: mytool",
      exitCode: 1,
    });
    deps.wasmRegistry = { dispatch };
    shell = new ShellService(deps);

    await shell.execute('mytool -m "a b c"');
    expect(dispatch).toHaveBeenCalledWith("mytool", ["-m", "a b c"]);
  });

  it('git commit -m "a b c" keeps the whole message', async () => {
    expect((await shell.execute("git init")).exitCode).toBe(0);
    await deps.vfs.writeFile("/msg.txt", "x");
    expect((await shell.execute("git add msg.txt")).exitCode).toBe(0);

    const commit = await shell.execute('git commit -m "a b c"');
    expect(commit.exitCode).toBe(0);
    expect(commit.stdout).toContain("a b c");

    const log = await shell.execute("git log");
    expect(log.stdout).toContain("a b c");
  });

  it("help → prints the command surface", async () => {
    const result = await shell.execute("help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("node <file.js>");
    expect(result.stdout).toContain("npm install");
    expect(result.stdout).toContain("npm run");
    expect(result.stdout).toContain("preview pane");
  });

  it("help node / help npm → per-command usage", async () => {
    const nodeHelp = await shell.execute("help node");
    expect(nodeHelp.exitCode).toBe(0);
    expect(nodeHelp.stdout).toContain("Usage: node <file.js>");

    const npmHelp = await shell.execute("help npm");
    expect(npmHelp.exitCode).toBe(0);
    expect(npmHelp.stdout).toContain("npm install");
  });

  it("node --help and node -h → usage", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await shell.execute(`node ${flag}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: node <file.js>");
      expect(result.stdout).toContain(BOLO_NODE_VERSION);
    }
  });

  it("node --version → prints the compat version", async () => {
    const result = await shell.execute("node --version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${BOLO_NODE_VERSION}\n`);
  });

  it("node with no args → prints a usage hint and still starts the REPL", async () => {
    const result = await shell.execute("node");
    expect(deps.runtimeWorker.startRepl).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: node <file.js>");
    expect(result.stdout).toContain("node --help");
  });

  it("npm --help / npm -h / bare npm → usage", async () => {
    for (const cmd of ["npm --help", "npm -h", "npm"]) {
      const result = await shell.execute(cmd);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: npm install");
      expect(result.stdout).toContain("npm run <script>");
    }
  });

  it("runtime --help and agent --help → usage", async () => {
    const runtimeHelp = await shell.execute("runtime --help");
    expect(runtimeHelp.exitCode).toBe(0);
    expect(runtimeHelp.stdout).toContain("Usage: runtime run");

    const agentHelp = await shell.execute("agent --help");
    expect(agentHelp.exitCode).toBe(0);
    expect(agentHelp.stdout).toContain("Usage: agent run");
  });

  it("unknown command → suggests help", async () => {
    const result = await shell.execute("foo bar");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("foo: command not found");
    expect(result.stderr).toContain("type 'help'");
  });
});
