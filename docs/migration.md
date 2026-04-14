# Migration Guide

## Concept mapping

| Concept | WebContainers | Nodebox | browser-containers |
|---------|--------------|---------|-------------------|
| Boot | `WebContainer.boot()` | `new Nodebox({ iframe }); .connect()` | `new VfsBus()` + `SWSandbox.create()` + wire services |
| Mount files | `.mount(files)` | `fs.init(fileMap)` | `vfs.writeFile(path, content)` per file, or `vfs.restore(snapshot)` for bulk |
| Run command | `.spawn('node', ['file.js'])` | `shell.runCommand('node', ['file.js'])` | `shell.execute('runtime run file.js')` |
| Streaming output | `process.output.pipeTo(writable)` | shell output stream | `execute(cmd, { stdout, stderr })` callbacks |
| npm install | `.spawn('npm', ['install'])` | `shell.runCommand('npm', ['install'])` | `shell.execute('npm install')` |
| Preview URL | `.on('server-ready', handler)` | port forwarding | `SWSandbox` virtual origin via iframe |
| Untrusted sandbox | — | — | `shell.execute('agent run file.js')` (QuickJS tier) |
| Trusted user code | Native (full Node.js) | Native (polyfills) | `shell.execute('runtime run file.js')` (V8 Web Worker) |

## Coming from WebContainers

### Before (WebContainers)

```ts
import { WebContainer } from '@webcontainer/api';

const container = await WebContainer.boot();

await container.mount({
  'index.js': { file: { contents: 'console.log("hello")' } }
});

const proc = await container.spawn('node', ['index.js']);
proc.output.pipeTo(new WritableStream({ write: (chunk) => console.log(chunk) }));
await proc.exit;
```

### After (browser-containers)

```ts
import { VfsBus } from '@browser-containers/vfs-bus';
import { SWSandbox } from '@browser-containers/sw-sandbox';
import { PackageManager } from '@browser-containers/npm';
import { RuntimeWorker, SandboxPool, ShellService } from '@browser-containers/runtime';

// Boot (manual wiring — no single boot() yet)
const vfs = new VfsBus();
const sandbox = await SWSandbox.create({ origin: 'https://sandbox.local/', swPath: '/sw.js' });
const runtimeWorker = new RuntimeWorker(vfs, sandbox);
const sandboxPool = new SandboxPool(vfs);
const packageManager = new PackageManager({ vfs });
const shell = new ShellService({ vfs, packageManager, runtimeWorker, sandboxPool });

// Mount
await vfs.writeFile('/index.js', 'console.log("hello")');

// Run
const result = await shell.execute('runtime run /index.js', {
  stdout: (chunk) => console.log(chunk),
});
console.log(result.exitCode); // 0
```

**Key differences:**
- No `boot()` — wire services manually (a high-level entry point is on the roadmap)
- No `server-ready` event — the ServiceWorker intercepts the virtual origin directly
- `spawn()` returns a process handle with a stream; `execute()` returns a `Promise<ShellResult>`
  with optional streaming callbacks

## Coming from Nodebox

### Before (Nodebox)

```ts
import { Nodebox } from '@codesandbox/nodebox';

const sandbox = new Nodebox({ iframe: document.getElementById('preview') });
await sandbox.connect();

await sandbox.fs.init({
  'index.js': 'console.log("hello")',
});

const shell = await sandbox.shell.create();
const { stdout } = await shell.runCommand('node', ['index.js']);
console.log(stdout);
```

### After (browser-containers)

```ts
// (same boot sequence as above)

// Bulk mount via snapshot
vfs.restore({
  '/index.js': 'console.log("hello")',
});

// Run
const result = await shell.execute('runtime run /index.js', {
  stdout: (chunk) => process.stdout.write(chunk),
});
```

**Key differences:**
- `fs.init(fileMap)` → `vfs.restore(snapshot)` for bulk mount, or multiple `vfs.writeFile` calls
- `shell.runCommand('node', ['file.js'])` → `shell.execute('runtime run file.js')`
- Nodebox command runner accepts arbitrary commands; browser-containers routes only `npm`, `runtime`, and `agent`

## No equivalent yet

These features exist in WebContainers or Nodebox but are not yet implemented:

| Feature | Status |
|---------|--------|
| `boot()` single entry point | Roadmap |
| npm-published packages | Roadmap |
| `spawn()` with process handle | Not planned (use execute callbacks) |
| Arbitrary shell commands (`ls`, `cat`, etc.) | Not planned |
| Full Node.js native package support (NAPI) | Not planned (WASM/JS only) |
| `fork()` / `cluster` | Not planned |
