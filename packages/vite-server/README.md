# @bolojs/vite-server

`BrowserViteServer`, a Vite dev server that runs on the main thread inside a [bolo](https://github.com/bolojs/bolo) container, with HMR over `BroadcastChannel`.

## Install

```bash
npm i @bolojs/vite-server
```

This package is bundler-only ESM: `dist` uses extensionless relative imports, so use it through Vite or another bundler. Importing it directly in plain Node ESM fails.

When bundling this package in your own Vite app, use `@bolojs/vite-preset`: it re-applies two WASI binding fixes (napi async pool disabled) that stock `oxc-transform` and `@rolldown/browser` need in cross-origin worker contexts.

## Usage

```ts
import { BrowserViteServer } from "@bolojs/vite-server";

const server = new BrowserViteServer({ vfs, root: "/project" });
await server.start();
```

Used internally by `bolojs` when a container project runs `npm run dev` against a Vite config.

## Docs

https://bolojs.dev/docs/api/

## License

Apache-2.0
