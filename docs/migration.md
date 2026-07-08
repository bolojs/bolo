# Migration Guide

## Concept mapping

| Concept | WebContainers | Nodebox | browser-containers |
|---------|--------------|---------|-------------------|
| Boot | `WebContainer.boot()` | `new Nodebox({ iframe }); .connect()` | `boot()` |
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
import { boot } from '@browser-containers/runtime';

const container = await boot();

await container.mount({
  'index.js': { file: { contents: 'console.log("hello")' } },
});

const proc = container.spawn('node', ['index.js']);
proc.output.pipeTo(new WritableStream({ write: (chunk) => console.log(chunk) }));
await proc.exit;
```

**Key differences:**
- `boot()` mirrors `@webcontainer/api`'s shape directly — same `mount()`/`spawn()`/`fs`/
  `on('server-ready')`/`teardown()` surface
- `spawn()`'s `output` is a `ReadableStream<string>` (not bytes); `container.fs` exposes
  `readFile`/`writeFile`/`mkdir`/`rm`/`readdir`/`rename`/`watch` (`fs.promises`-style, no
  `stat`/`lstat`/symlinks in v1.0)
- The lower-level primitives (`VfsBus`, `SWSandbox`, `ShellService`, `RuntimeWorker`,
  `SandboxPool`) are still available directly for callers who want manual wiring instead
  of `boot()`

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
| npm-published packages | Roadmap |
| Shell builtins (`pwd`, `cd`, `ls`, `cat`, `echo`, `clear`, `help`) | Implemented (`shell-builtins.ts`) — pipes, redirection, quoting, and commands like `mkdir`/`rm`/`grep`/`sed` still missing |
| Full Node.js native package support (NAPI) | Not planned (WASM/JS only) |
| `fork()` / `cluster` | Not planned |
