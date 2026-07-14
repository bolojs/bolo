---
title: Getting Started
description: Clone the repo, run the demo, and embed bolo in your own project.
---

## Prerequisites

- Node.js 20+
- pnpm 10+
- Chrome 110+ (required for OPFS persistence; Firefox and Safari work without persistence)

## Run the demo

```bash
git clone https://github.com/bolojs/bolo
cd bolo
pnpm install
pnpm build
pnpm --filter @bolojs/site-demo dev
```

Open `http://localhost:5173`. The demo shows a split terminal + preview pane. Try:

```
npm install lodash
runtime run /hello.js
agent run /untrusted.js
```

## Use packages in your own project

Packages are not yet on npm. Link them from source using pnpm workspaces:

```jsonc
// your-project/package.json
{
  "dependencies": {
    "@bolojs/runtime": "file:../bolo/packages/runtime",
    "@bolojs/vfs-bus": "file:../bolo/packages/vfs-bus"
  }
}
```

## Basic example

The minimum wiring to run a script in the browser:

```ts
import { VfsBus } from '@bolojs/vfs-bus';
import { SWSandbox } from '@bolojs/sw-sandbox';
import { PackageManager } from '@bolojs/npm';
import { RuntimeWorker, IframeSandbox, ShellService } from '@bolojs/runtime';

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
package — it implements `SandboxBackend`, so it drops in as the same `sandbox` dep. See
[ADR-0001](/docs/adr/0001-two-tier-runtime/) for the design rationale.

## Install packages

```ts
const result = await shell.execute('npm install lodash', {
  stdout: (line) => console.log(line),
});
// lodash is now available under /node_modules inside the VFS
```

## Next steps

- [API reference](/docs/api/) — full API surface for all packages
- [Alternatives comparison](/docs/alternatives/) — how bolo compares to WebContainers and Nodebox
- [Migration guide](/docs/migration/) — coming from WebContainers or Nodebox
- [ADRs](/docs/adr/) — architecture decisions
