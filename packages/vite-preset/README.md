# @bolojs/vite-preset

Vite preset for apps embedding [bolo](https://github.com/bolojs/bolo). Wires `node:*` polyfills
via `@bolojs/node-web-shims` so your app's own build resolves the same Node built-ins bolo needs.

## Install

```bash
npm i -D @bolojs/vite-preset
```

## Usage

```ts
// vite.config.ts
import { defineConfig, mergeConfig } from "vite";
import { bolojsPreset } from "@bolojs/vite-preset";

export default defineConfig((env) => mergeConfig(bolojsPreset(), {
  // your app's own vite config
}));
```

The preset only wires polyfills; it does not set the COOP/COEP/CORP headers a deployed bolo app
needs. See the production setup checklist in the docs for that.

## Docs

https://bolojs.dev/docs/getting-started/

## License

Apache-2.0
