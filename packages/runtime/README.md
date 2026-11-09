# bolojs

Core container API for [bolo](https://github.com/bolojs/bolo). Boots a browser-native Node.js runtime with a pluggable sandbox backend. No server, no VM, runs entirely client-side.

## Install

```bash
npm i bolojs
```

This package is bundler-only ESM: `dist` uses extensionless relative imports, so use it through Vite or another bundler. Importing it directly in plain Node ESM fails.

## Usage

```ts
import { boot } from "@bolojs/runtime";

const container = await boot({ workdirName: "/home/web" });

await container.mount({
  "package.json": { file: { contents: `{"name":"demo"}` } },
});

await container.spawn("node", ["-e", "console.log('hello from bolo')"]);
```

`boot()` requires cross-origin isolation. See the production setup checklist in the docs before deploying: bolo needs COOP/COEP/CORP headers set on your host, not just your app code.

## Docs

- Getting started: https://bolojs.dev/docs/getting-started/
- API reference: https://bolojs.dev/docs/api/

## License

Apache-2.0
