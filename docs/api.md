---
title: API Reference
description: VfsBus, ShellService, SandboxBackend/IframeSandbox, RuntimeWorker, SWSandbox, and the demo contract.
---

For which `node:*` modules are shimmed and to what degree, see the
[module status table](/docs/compat/#module-status) on the Compatibility page.

## VfsBus (`@bolojs/fs`)

Single-owner observable virtual filesystem backed by memfs (hot layer) and OPFS (cold layer).
The hot layer is authoritative; OPFS is a best-effort persistence cache that degrades silently.
Files not accessed for 5 minutes are evicted from the hot layer (cold layer keeps a copy).

```ts
import { VfsBus } from '@bolojs/fs';
const vfs = new VfsBus();
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `writeFile` | `(path, content: string \| Uint8Array) => Promise<void>` | Write or overwrite a file. Creates parent dirs automatically. |
| `readFile` | `(path) => Promise<string \| Uint8Array>` | Read a file. Falls through to OPFS cold layer if not in hot layer. |
| `exists` | `(path) => boolean` | Synchronous hot-layer existence check. |
| `mkdir` | `(path, opts?) => void` | Create directory (synchronous, hot layer only). |
| `rm` | `(path, opts?) => void` | Remove file or directory (synchronous, hot layer only). |
| `readdir` | `(path) => string[]` | List directory entries (synchronous). |
| `on` | `(event, handler) => void` | Subscribe to filesystem events (see below). |
| `watch` | `(glob, handler) => void` | Watch paths matching a glob pattern. |
| `snapshot` | `() => object` | Export the full hot-layer state as a plain object. |
| `restore` | `(snap) => void` | Restore state from a `snapshot()` export. |
| `use` | `(middleware) => void` | Add a middleware function that runs before writes. |

### Events

```ts
vfs.on('write',  ({ path }) => { /* file written */ });
vfs.on('delete', ({ path }) => { /* file removed */ });
vfs.on('rename', ({ path }) => { /* file renamed */ });
```

### Internal surfaces

`vfs.vol`: the underlying `memfs` Volume (use for low-level operations).
`vfs.hot`: `memfs` fs interface (sync methods available: `readFileSync`, `writeFileSync`, etc.).

---

## ShellService (`bolojs`)

Routes shell commands to the appropriate execution tier.

```ts
import { ShellService } from '@bolojs/runtime';

const shell = new ShellService({ vfs, packageManager, runtimeWorker, sandbox });
```

### Constructor

```ts
interface ShellServiceDeps {
  vfs: VfsBus;
  packageManager: PackageManager;
  runtimeWorker: RuntimeWorker;
  swSandbox?: SWSandbox;      // optional: enables `npm run dev`
  sandbox?: SandboxBackend;   // optional: enables `agent run <script>`
  events?: ContainerEvents;
  workdir?: string;
}
```

### `execute(command, output?)`

```ts
const result = await shell.execute(command, {
  stdout: (data: string) => void,  // called incrementally as output arrives
  stderr: (data: string) => void,
});
// result: { stdout: string, stderr: string, exitCode: number }
```

### Supported commands

| Command | Tier | Notes |
|---------|------|-------|
| `npm install [packages]` | PackageManager | Installs into VFS `/node_modules` |
| `npm run dev` | ContainerAdapter | Requires `sandbox` dep; starts BrowserViteServer |
| `runtime run <file>` | V8 Web Worker | Reads file from VFS, runs in RuntimeWorker |
| `agent run <file>` | `SandboxBackend` | Reads file from VFS, runs via whatever `sandbox` dep is configured |

Unknown commands return exit code `127`.

---

## SandboxBackend / IframeSandbox (`bolojs`)

Untrusted-code execution is pluggable behind a small interface:

```ts
interface SandboxRunResult {
  result?: string;
  error?: string;
}

interface SandboxSnapshot {
  bytes: Uint8Array;  // opaque, backend-defined, locked to the producing build
  format: string;     // e.g. "quickjs-sandbox@1" — restore must reject mismatches
}

interface SandboxBackend {
  run(code: string): Promise<SandboxRunResult>;
  dispose(): void;
  // Optional capabilities — absent means unsupported:
  snapshot?(): Promise<SandboxSnapshot>;
  restore?(snapshot: SandboxSnapshot): Promise<void>;
}

// Type guard: true when both optional methods are implemented.
import { supportsSnapshots } from '@bolojs/runtime';
```

Backends that implement `snapshot`/`restore` follow two rules borrowed from
durable-execution engines: policy (memory/stack limits, interrupt handler,
module loader, ACLs) is host configuration — it is re-applied after restore and
never serialized into the snapshot — and snapshots are trusted input only.
Restoring bytes that a sandboxed party could write is equivalent to loading its
bytecode into the engine.

The default implementation is `IframeSandbox`: a cross-origin, opaque-origin iframe
(browser-native isolation, no WASM runtime to load):

```ts
import { IframeSandbox } from '@bolojs/runtime';
const sandbox = new IframeSandbox();
const { result, error } = await sandbox.run('2 + 2');
// result: '4', error: undefined
```

`fs.readFileSync(path)` is available read-only inside the sandbox; write operations
(`writeFileSync`, `mkdirSync`, `rmSync`) throw immediately.

For hard, C-level memory/CPU/stack caps (not just origin isolation), implement
`SandboxBackend` with the QuickJS-based `SandboxPool` from the separate
[`quickjs-sandbox`](https://github.com/bolojs/quickjs-sandbox) package and
pass it as `sandbox`: it's opt-in and not a dependency of `bolojs`.

### Container checkpoints

`container.checkpoint()` captures the container's VFS hot layer plus the
sandbox backend's state (when the backend supports snapshots) into one
`ContainerCheckpoint`. `boot({ resume: checkpoint })` restores it — VFS always;
backend state only when the configured backend implements `restore`, and boot
fails if a checkpoint carries sandbox state the backend cannot restore.

```ts
const first = await boot({ sandbox });
await first.fs.writeFile('/home/web/state.txt', '...');
const cp = await first.checkpoint();
await first.teardown();

const second = await boot({ sandbox: newBackend, resume: cp });
// second.fs sees state.txt; newBackend.restore() ran during boot.
```

Warm start: keep a base checkpoint taken after `mount()` and boot repeated
instances with `resume` to skip setup. When `workdirName` is omitted, the
checkpoint's workdir is used; when set it must equal the checkpoint's workdir.

Security: checkpoints are trusted input, session-local only in v1. Persisting
them to user-writable storage (OPFS, IndexedDB) is unsafe until an integrity
mechanism (format + version + MAC/signature) lands — a tampered VFS snapshot is
low-risk, but a tampered sandbox snapshot is attacker bytecode.

---

## RuntimeWorker (`bolojs`)

Trusted code execution tier. Runs scripts in a dedicated Web Worker.

```ts
import { RuntimeWorker } from '@bolojs/runtime';
const worker = new RuntimeWorker(vfs, sandbox);
```

### Constructor

```ts
new RuntimeWorker(vfs: VfsBus, sandbox: SWSandbox)
```

### `runScript(code, opts?)`

```ts
worker.onStdout = (data) => console.log(data);
worker.onStderr = (data) => console.error(data);
worker.onExit   = (code) => console.log('exit', code);

await worker.runScript(code, { filename: '/index.js', args: [] });
```

A watchdog terminates the Worker if no heartbeat is received for >10 seconds.

---

## SWSandbox (`@bolojs/sandbox`)

ServiceWorker-based network proxy that intercepts requests to a virtual origin.

```ts
import { SWSandbox } from '@bolojs/sandbox';
const sandbox = await SWSandbox.create({ origin: 'https://sandbox.local/', swPath: '/sw.js' });
```

### `SWSandbox.create(opts)`

Registers the service worker at `swPath` and waits for it to activate. Requires HTTPS
(or `localhost`). Throws if ServiceWorker API is unavailable.

### `onFetch(handler)`

```ts
sandbox.onFetch(async (req) => {
  if (new URL(req.url).origin === 'https://sandbox.local/') {
    return viteServer.onFetch(new URL(req.url).pathname, req);
  }
  return new Response('Not found', { status: 404 });
});
```

### `setPolicyRegistry(registry)`

Attach a `Map<string, unknown>` of sandbox policies. Used by `@bolojs/sandbox-policy`.

---

## Extending bolo

Something you need isn't supported yet? Check the [live compatibility dashboard](https://bolojs.dev/compat/)
first, then extend through one of these seams instead of forking.

### Bundler tools (`@bolojs/registry`)

`registerWasmTool()` registers additional native-binary-to-WASM tools (formatters, linters, other
transpilers) behind the same lazy-load dispatcher bolo uses for its own bundler:

```ts
import { registerWasmTool, resolveWasmTool } from '@bolojs/registry';

registerWasmTool('my-tool', async () => {
  const mod = await import('my-wasm-tool');
  return {
    async run(args, stdin) {
      const result = await mod.compile(args.join(' '));
      return { stdout: result.output, stderr: result.errors, exitCode: 0 };
    },
  };
});

const tool = await resolveWasmTool('my-tool');
```

Unregistered commands fall through to `ShellService`.

### Runtime shims (`@bolojs/node-runtime-shims`)

Some Node.js features need capabilities the browser can't provide natively. Instead of
blocking these forever, `createLiveShimRegistry` exposes backend hooks:

| Feature | Default | Extension point |
|---------|---------|-----------------|
| TCP/IP | HTTP-only (SW proxy) | `netBackend: (deps) => nodeNetNamespace` |
| UDP | Not supported | `dgramBackend: (deps) => { createSocket }` |
| TLS | Not supported | `tlsBackend: (deps) => nodeTlsNamespace` |
| Native `.node` addons | Not supported | `nativeAddonLoader: (path, vfs) => moduleSync` |
| Worker threads | Stub (`isMainThread=true`) | `workerThreadsBackend: (deps) => workerThreadsNamespace` |

```ts
import { createLiveShimRegistry } from '@bolojs/node-runtime-shims';

const registry = createLiveShimRegistry({
  vfs,
  sandbox,
  dgramBackend: ({ vfs }) => ({
    createSocket: (type, onMessage) => new WebTransportDgramSocket(onMessage),
  }),
});
```

Each `deps` object passed to a backend factory is `{ vfs, sandbox }`.

---

## window.__browserbox (demo contract)

The demo app exposes a global API for e2e tests and embedding scripts.

```ts
// Check readiness
if (window.__browserbox_ready) {
  // Install packages
  await window.__browserbox.install(['react', 'react-dom']);

  // Write a file into the VFS
  await window.__browserbox.vfs.writeFile('/src/App.jsx', '<h1>Hello</h1>');

  // Load a URL in the preview iframe
  window.__browserbox.preview.loadUrl('https://sandbox.local/');
}
```

This is the demo shell's external API, not a published library export.
