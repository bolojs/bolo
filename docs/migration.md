---
title: Migration Guide
description: Moving from WebContainers or Nodebox to bolo.
---

## Concept mapping

| Concept | bolo | WebContainers | Nodebox |
|---------|--------------|---------|-------------------|
| Boot | `boot()` | `WebContainer.boot()` | `new Nodebox({ iframe }); .connect()` |
| Mount files | `vfs.writeFile(path, content)` per file, or `vfs.restore(snapshot)` for bulk | `.mount(files)` | `fs.init(fileMap)` |
| Run command | `shell.execute('runtime run file.js')` | `.spawn('node', ['file.js'])` | `shell.runCommand('node', ['file.js'])` |
| Streaming output | `execute(cmd, { stdout, stderr })` callbacks | `process.output.pipeTo(writable)` | shell output stream |
| npm install | `shell.execute('npm install')` | `.spawn('npm', ['install'])` | `shell.runCommand('npm', ['install'])` |
| Preview URL | `SWSandbox` virtual origin via iframe | `.on('server-ready', handler)` | port forwarding |
| Untrusted sandbox | `shell.execute('agent run file.js')` (QuickJS tier) | n/a | n/a |
| Trusted user code | `shell.execute('runtime run file.js')` (V8 Web Worker) | Native (full Node.js) | Native (polyfills) |

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

### After (bolo)

```ts
import { boot } from 'bolojs';

const container = await boot();

await container.mount({
  'index.js': { file: { contents: 'console.log("hello")' } },
});

const proc = container.spawn('node', ['index.js']);
proc.output.pipeTo(new WritableStream({ write: (chunk) => console.log(chunk) }));
await proc.exit;
```

**Key differences:**
- `boot()` mirrors `@webcontainer/api`'s shape directly: same `mount()`/`spawn()`/`fs`/
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

### After (bolo)

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
- `npm`, `runtime`, and `agent` are special-cased to wire into the container's package manager/runtime worker/sandbox pool; every other command line runs through a real bash interpreter ([just-bash](https://www.npmjs.com/package/just-bash)) backed by `VfsBus`, with full support for pipes, redirection, quoting, and POSIX builtins (`ls`, `cat`, `mkdir`, `rm`, `cp`, `mv`, `grep`, `sed`, etc.)

## No equivalent yet

These features exist in WebContainers or Nodebox but are not yet implemented:

| Feature | Status |
|---------|--------|
| Full Node.js native package support (NAPI) | Not planned (WASM/JS only) |
| `fork()` / `cluster` | Not planned |
