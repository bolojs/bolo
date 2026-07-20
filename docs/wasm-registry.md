---
title: WASM Registry
description: The bundler (rolldown + oxc-transform) plus a lazy-load extension seam for more WASM tools.
---

`@bolojs/registry` ships the real bundler used in production — [rolldown](https://rolldown.rs) for bundling and [oxc-transform](https://oxc.rs) for TS/JSX transforms — plus a generic `registerWasmTool()` seam for adding more native-binary-to-WASM tools later.

## What's actually wired up

- **Bundling**: rolldown/browser, invoked directly (not through `registerWasmTool`)
- **Transform**: oxc-transform, invoked directly for single-file TS/JSX
- Both load lazily (dynamic `import()`), same-origin in dev-server hosts, CDN (esm.sh) elsewhere

## Extension seam

`registerWasmTool()` lets a host app register additional native binaries (esbuild, tsc, sass, swc, or anything else compiled to WASM/WASI) behind the same lazy-load dispatcher. Nothing beyond rolldown/oxc-transform is registered by default — this is a seam for consumers to plug into, not a preinstalled toolchain.

```typescript
import { registerWasmTool } from '@bolojs/registry';

registerWasmTool('my-tool', async () => {
  const mod = await import('my-wasm-tool');
  return {
    async run(args, stdin) {
      const result = await mod.compile(args.join(' '));
      return { stdout: result.output, stderr: result.errors, exitCode: 0 };
    }
  };
});
```

### Resolving a registered tool

```typescript
import { resolveWasmTool } from '@bolojs/registry';

const tool = await resolveWasmTool('my-tool');
if (tool) {
  const result = await tool.run(['--version']);
  console.log(result.stdout);
}
```

### Wiring into the child_process shim

```typescript
import { createChildProcessShim } from '@bolojs/node-runtime-shims';
import { createWasmRegistry } from '@bolojs/registry';

const registry = createWasmRegistry();
const shell = createShellService(); // from sw-sandbox
const shim = createChildProcessShim(registry, shell);
```

Unregistered commands fall through to the shell service.
