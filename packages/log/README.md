# @bolojs/log

Internal diagnostics for [bolo](https://github.com/bolojs/bolo). A thin [logtape](https://logtape.org)
wrapper with Node and browser entrypoints, plus an error-hint registry for translating common
failure signatures into actionable messages.

## Install

```bash
npm i @bolojs/log
```

## Usage

```ts
// Node
import { getLogger } from "@bolojs/log";
// Browser
import { getLogger } from "@bolojs/log/browser";

const logger = getLogger(["myapp"]);
logger.info("started");
```

Used internally by every bolo package for consistent, structured logging across the main thread,
workers, and the ServiceWorker.

## Docs

https://bolojs.dev/docs/api/

## License

Apache-2.0
