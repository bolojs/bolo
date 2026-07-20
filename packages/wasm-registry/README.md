# @bolojs/registry

In-browser bundler for [bolo](https://github.com/bolojs/bolo). Wires rolldown + oxc-transform to
bundle and transpile code client-side, plus a `registerWasmTool()` extension seam for adding your
own WASM-backed build tools.

## Install

```bash
npm i @bolojs/registry
```

## Usage

```ts
import { bundleEntry } from "@bolojs/registry";

const output = await bundleEntry({ vfs, entry: "/src/index.ts" });
```

### Extending

Register additional WASM tools (formatters, linters, other transpilers) via the same seam bolo
uses internally:

```ts
import { registerWasmTool } from "@bolojs/registry";

registerWasmTool("my-tool", async (input) => { /* ... */ });
```

## Docs

https://bolojs.dev/docs/api/#extending-bolo

## License

Apache-2.0
