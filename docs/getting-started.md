---
title: Getting Started
description: Install bolo, boot a container, and deploy it correctly on the first try.
---

## Prerequisites

- Chrome 110+ (required for OPFS persistence; Firefox and Safari work without persistence)
- Node.js 20+ and pnpm 10+ (only if building from source)

## Install

```bash
npm i bolojs
```

`boot()` alone is enough to get started. Sub-packages (`@bolojs/fs`, `@bolojs/sandbox`, `@bolojs/pm`,
and friends) are pulled in automatically; import them directly only if you need manual, low-level
wiring (see below).

## Quickstart

```ts
import { boot } from 'bolojs';

const container = await boot({ workdirName: '/home/web' });

await container.mount({
  'hello.js': { file: { contents: `console.log('hello from bolo')` } },
});

const proc = container.spawn('node', ['hello.js']);
proc.output.pipeTo(new WritableStream({ write: (chunk) => console.log(chunk) }));
await proc.exit;
```

## Production setup checklist

`boot()` requires **cross-origin isolation**. Without it, the WASM bundler's `SharedArrayBuffer`
transfer throws and worker fetches get blocked. Set these three headers on every response from
your host, not just your app's entry document:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

- **COOP + COEP** make `self.crossOriginIsolated` true, which `SharedArrayBuffer` requires.
- **CORP** is needed because COEP `require-corp` also applies to same-origin sub-resource fetches
  (worker scripts included), and Chrome rejects those without an explicit CORP header.

Missing any one of the three breaks the boot. `examples/app-builder/public/_headers` in the bolo
repo is a working reference for a Cloudflare Pages-style deploy; copy its pattern for your host.

## Run the demo

```bash
git clone https://github.com/bolojs/bolo
cd bolo
pnpm install
pnpm build
pnpm --filter @bolojs/example-app-builder dev
```

Open the URL Vite prints. The demo shows a split terminal + preview pane. Try:

```
npm install lodash
runtime run /hello.js
agent run /untrusted.js
```

## Manual wiring

`boot()` covers most cases. For direct control over each tier, wire the primitives yourself:

```ts
import { VfsBus } from '@bolojs/fs';
import { SWSandbox } from '@bolojs/sandbox';
import { PackageManager } from '@bolojs/pm';
import { RuntimeWorker, IframeSandbox, ShellService } from 'bolojs';

const vfs = new VfsBus();
const swSandbox = await SWSandbox.create({ origin: 'https://sandbox.local/', swPath: '/sw.js' });

const runtimeWorker = new RuntimeWorker(vfs, swSandbox);
const sandbox = new IframeSandbox(); // untrusted-code tier, see below
const packageManager = new PackageManager({ vfs });

const shell = new ShellService({ vfs, packageManager, runtimeWorker, swSandbox, sandbox });

// Write a file into the virtual filesystem
await vfs.writeFile('/hello.js', `console.log('hello from bolo')`);

// Run it in the V8 Web Worker tier
const result = await shell.execute('runtime run /hello.js', {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});

console.log('exit code:', result.exitCode); // 0
```

## Run untrusted AI agent code

`agent run` executes through whichever `SandboxBackend` you pass as `sandbox`. The default,
`IframeSandbox`, isolates code in a cross-origin, opaque-origin iframe:

```ts
await vfs.writeFile('/agent.js', `
  const data = fs.readFileSync('/input.txt', 'utf8');
  'processed: ' + data.toUpperCase()
`);

const result = await shell.execute('agent run /agent.js');
console.log(result.stdout); // 'processed: ...'
```

Write access to the VFS is blocked from inside the sandbox. If you need hard, C-level
memory/CPU/stack caps instead of origin isolation, use the QuickJS-based `SandboxPool`
from the separate [`quickjs-sandbox`](https://github.com/bolojs/quickjs-sandbox)
package: it implements `SandboxBackend`, so it drops in as the same `sandbox` dep. See
[ADR-0001](/docs/adr/0001-two-tier-runtime/) for the design rationale.

## Install packages

```ts
const result = await shell.execute('npm install lodash', {
  stdout: (line) => console.log(line),
});
// lodash is now available under /node_modules inside the VFS
```

## Next steps

- [Compatibility](/docs/compat/): what Node.js surface bolo supports, and the live dashboard
- [API reference](/docs/api/): full API surface for all packages
- [Migration guide](/docs/migration/): coming from WebContainers or Nodebox
- [Alternatives comparison](/docs/alternatives/): how bolo compares to Node.js and WebContainers
