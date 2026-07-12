---
title: WASM Registry
description: Lazy-loading WASM dispatcher for esbuild, tsc, sass, swc, and custom tools.
sidebar:
  order: 7
---

Lazy-loading WASM tool dispatcher for native build tools in the browser.

## Overview

The WASM Registry provides a lazy-loading mechanism for build tools (esbuild, tsc, sass, swc) that:

- Loads tools only when first used (zero eager initialization)
- Caches loaded tools for subsequent calls
- Integrates with `node-runtime-shims` child_process shim
- Falls back to shell service for unregistered commands

## Supported Tools

| Binary | npm Package | License | Coverage | Known Edge Cases |
|--------|-------------|---------|----------|----------------|
| `esbuild` | `esbuild-wasm` | MIT | Basic transform | Requires `wasmURL` initialization; full CLI not yet implemented |
| `tsc` | `typescript` (pure JS) | Apache-2.0 | Basic transpile | Single-file transpilation only; no module resolution |
| `sass` | `sass` (pure JS) | MIT | Basic compile | String-only; no file I/O; limited syntax support |
| `swc` | `@swc/wasm-web` | Apache-2.0 | Basic transform | Requires initialization call; single-file only |

## API Usage

### Basic Registration

```typescript
import { registerWasmTool } from '@browser-containers/wasm-registry';

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

### Using with Child Process Shim

```typescript
import { createChildProcessShim } from '@browser-containers/node-runtime-shims';
import { createWasmRegistry } from '@browser-containers/wasm-registry';

const registry = createWasmRegistry();
const shell = createShellService(); // from sw-sandbox
const shim = createChildProcessShim(registry, shell);

// Executes esbuild via WASM
const esbuild = shim.spawn('esbuild', ['const x = 1;']);
```

### Manual Tool Resolution

```typescript
import { resolveWasmTool } from '@browser-containers/wasm-registry';

const esbuild = await resolveWasmTool('esbuild');
if (esbuild) {
  const result = await esbuild.run(['--version']);
  console.log(result.stdout);
}
```

## Implementation Notes

- All tools use dynamic `import()` for lazy loading
- No static imports of WASM binaries
- Zero eager initialization overhead
- Tool instances cached after first load
- Error handling: missing tools fall through to shell service

## Testing

Run WASM registry tests:

```bash
pnpm test --filter wasm-registry
```

Test files:
- `tests/unit/wasm-registry/esbuild.compat.test.ts`
- `tests/unit/wasm-registry/tsc.compat.test.ts`
- `tests/unit/wasm-registry/sass.compat.test.ts`
- `tests/unit/wasm-registry/swc.compat.test.ts`
