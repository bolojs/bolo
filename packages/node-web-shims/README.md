# @bolojs/node-web-shims

`node:*` to Web API shims for [bolo](https://github.com/bolojs/bolo): crypto, stream, buffer, path, url, events, os, http, worker_threads. Independently usable in any Vite app that needs Node built-ins to resolve in the browser, no container required.

## Install

```bash
npm i @bolojs/node-web-shims
```

This package is bundler-only ESM: `dist` uses extensionless relative imports, so use it through Vite or another bundler. Importing it directly in plain Node ESM fails. The `@bolojs/node-web-shims/vite-plugin` entry runs in Node (Vite config) and works as plain ESM.

## Usage

As a Vite plugin:

```ts
// vite.config.ts
import { nodeWebShims } from "@bolojs/node-web-shims/vite-plugin";

export default {
  plugins: [nodeWebShims()],
};
```

## Docs

https://bolojs.dev/docs/api/

## License

Apache-2.0
