# @bolojs/vite-server

`BrowserViteServer`, a Vite dev server that runs on the main thread inside a
[bolo](https://github.com/bolojs/bolo) container, with HMR over `BroadcastChannel`.

## Install

```bash
npm i @bolojs/vite-server
```

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
