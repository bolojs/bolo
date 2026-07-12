---
title: Getting Started
description: Clone the repo, run the demo, and embed browser-containers in your own project.
sidebar:
  order: 1
---

## Prerequisites

- Node.js 20+
- pnpm 10+
- Chrome 110+ (required for OPFS persistence; Firefox and Safari work without persistence)

## Run the demo

```bash
git clone https://github.com/your-org/browser-containers
cd browser-containers
pnpm install
pnpm build
pnpm --filter @browser-containers/site-demo dev
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
    "@browser-containers/runtime": "file:../browser-containers/packages/runtime",
    "@browser-containers/vfs-bus": "file:../browser-containers/packages/vfs-bus"
  }
}
```

## Basic example

The minimum wiring to run a script in the browser:

```ts
import { VfsBus } from '@browser-containers/vfs-bus';
import { SWSandbox } from '@browser-containers/sw-sandbox';
import { PackageManager } from '@browser-containers/npm';
import { RuntimeWorker, SandboxPool, ShellService } from '@browser-containers/runtime';

const vfs = new VfsBus();
const sandbox = await SWSandbox.create({ origin: 'https://sandbox.local/', swPath: '/sw.js' });

const runtimeWorker = new RuntimeWorker(vfs, sandbox);
const sandboxPool = new SandboxPool(vfs);
const packageManager = new PackageManager({ vfs });

const shell = new ShellService({ vfs, packageManager, runtimeWorker, sandboxPool });

// Write a file into the virtual filesystem
await vfs.writeFile('/hello.js', `console.log('hello from browser-containers')`);

// Run it in the V8 Web Worker tier
const result = await shell.execute('runtime run /hello.js', {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});

console.log('exit code:', result.exitCode); // 0
```

## Run untrusted AI agent code

Use the QuickJS tier for code you don't trust (AI-generated scripts, plugins, etc.):

```ts
await vfs.writeFile('/agent.js', `
  const data = fs.readFileSync('/input.txt', 'utf8');
  'processed: ' + data.toUpperCase()
`);

const result = await shell.execute('agent run /agent.js');
console.log(result.stdout); // 'processed: ...'
```

The QuickJS tier enforces C-level hard limits: 16 MB memory, 1 MB stack, 1 M op interrupt.
Write access to the VFS is blocked. See [ADR-0001](/docs/adr/0001-two-tier-runtime/) for the
 design rationale.

## Install packages

```ts
const result = await shell.execute('npm install lodash', {
  stdout: (line) => console.log(line),
});
// lodash is now available under /node_modules inside the VFS
```

## Next steps

- [API reference](/docs/api/) — full API surface for all packages
- [Alternatives comparison](/docs/alternatives/) — how browser-containers compares to WebContainers and Nodebox
- [Migration guide](/docs/migration/) — coming from WebContainers or Nodebox
- [ADRs](/docs/adr/) — architecture decisions
