# @bolojs/node-web-shims

`node:*` to Web API shims for [bolo](https://github.com/bolojs/bolo): crypto, stream, buffer,
path, url, events, os, http, worker_threads. Independently usable in any Vite app that needs
Node built-ins to resolve in the browser, no container required.

## Install

```bash
npm i @bolojs/node-web-shims
```

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
