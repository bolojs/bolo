# @bolojs/registry

In-browser bundler for [bolo](https://github.com/bolojs/bolo). Wires rolldown + oxc-transform to bundle and transpile code client-side, plus a `registerWasmTool()` extension seam for adding your own WASM-backed build tools.

## Install

```bash
npm i @bolojs/registry
```

This package is bundler-only ESM: `dist` uses extensionless relative imports, so use it through Vite or another bundler. Importing it directly in plain Node ESM fails.

When bundling this package in your own Vite app, use `@bolojs/vite-preset`: it re-applies two WASI binding fixes (napi async pool disabled) that stock `oxc-transform` and `@rolldown/browser` need in cross-origin worker contexts.

## Usage

```ts
import { bundleEntry } from "@bolojs/registry";

const output = await bundleEntry({ vfs, entry: "/src/index.ts" });
```

### Extending

Register additional WASM tools (formatters, linters, other transpilers) via the same seam bolo uses internally:

```ts
import { registerWasmTool } from "@bolojs/registry";

registerWasmTool("my-tool", async (input) => { /* ... */ });
```

## Docs

https://bolojs.dev/docs/api/#extending-bolo

## License

Apache-2.0
