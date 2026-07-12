---
title: API Reference
description: VfsBus, ShellService, SandboxPool, RuntimeWorker, SWSandbox, and the demo contract.
sidebar:
  order: 3
---

## VfsBus (`@browser-containers/vfs-bus`)

Single-owner observable virtual filesystem backed by memfs (hot layer) and OPFS (cold layer).
The hot layer is authoritative; OPFS is a best-effort persistence cache that degrades silently.
Files not accessed for 5 minutes are evicted from the hot layer (cold layer keeps a copy).

```ts
import { VfsBus } from '@browser-containers/vfs-bus';
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

`vfs.vol` — the underlying `memfs` Volume (use for low-level operations).
`vfs.hot` — `memfs` fs interface (sync methods available: `readFileSync`, `writeFileSync`, etc.).

---

## ShellService (`@browser-containers/runtime`)

Routes shell commands to the appropriate execution tier.

```ts
import { ShellService } from '@browser-containers/runtime';

const shell = new ShellService({ vfs, packageManager, runtimeWorker, sandboxPool });
```

### Constructor

```ts
interface ShellServiceDeps {
  vfs: VfsBus;
  packageManager: PackageManager;
  runtimeWorker: RuntimeWorker;
  sandboxPool: SandboxPool;
  sandbox?: ContainerAdapter;  // optional: enables `npm run dev`
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
| `agent run <file>` | QuickJS | Reads file from VFS, runs in SandboxPool with caps |

Unknown commands return exit code `127`.

---

## SandboxPool (`@browser-containers/runtime`)

Untrusted code execution tier using QuickJS WASM. A fresh context is created per call.

```ts
import { SandboxPool } from '@browser-containers/runtime';
const pool = new SandboxPool(vfs);
```

### `run(code)`

```ts
const { result, error } = await pool.run('2 + 2');
// result: '4', error: undefined
```

**Resource limits (C-level, cannot be bypassed by JS):**
- Memory: 16 MB
- Stack: 1 MB
- Instruction count: 1 000 000 ops (interrupt returns `undefined`)

**Filesystem access inside the sandbox:** read-only via `fs.readFileSync(path)`.
Write operations (`writeFileSync`, `mkdirSync`, `rmSync`) throw immediately.

---

## RuntimeWorker (`@browser-containers/runtime`)

Trusted code execution tier. Runs scripts in a dedicated Web Worker.

```ts
import { RuntimeWorker } from '@browser-containers/runtime';
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

## SWSandbox (`@browser-containers/sw-sandbox`)

ServiceWorker-based network proxy that intercepts requests to a virtual origin.

```ts
import { SWSandbox } from '@browser-containers/sw-sandbox';
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

Attach a `Map<string, unknown>` of sandbox policies. Used by `@browser-containers/sandbox-policy`.

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
