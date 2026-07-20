# @bolojs/sandbox

ServiceWorker-based network proxy for [bolo](https://github.com/bolojs/bolo). Gives a container a
virtual localhost by intercepting fetches at the origin's ServiceWorker and bridging them to the
container over a `MessageChannel`.

## Install

```bash
npm i @bolojs/sandbox
```

## Usage

```ts
import { SWSandbox } from "@bolojs/sandbox";

const sandbox = await SWSandbox.create({ origin: location.origin, swPath: "/sw.js" });
```

Requires a ServiceWorker script implementing the SWSandbox protocol registered at your app's
origin. Used internally by `bolojs` when you pass `swPath` to `boot()`.

## Docs

https://bolojs.dev/docs/api/

## License

Apache-2.0
