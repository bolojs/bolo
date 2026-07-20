# @bolojs/lockfile

Parses npm, yarn, yarn-berry, pnpm, and bun lockfiles into a unified dependency graph. Used by
[bolo](https://github.com/bolojs/bolo)'s in-browser package manager to resolve installs without
hitting the registry for packages already pinned in a lockfile.

## Install

```bash
npm i @bolojs/lockfile
```

## Usage

```ts
import { parse, resolve } from "@bolojs/lockfile";

const graph = parse(lockfileContents); // format auto-detected
const resolved = resolve(graph, "some-package");
```

## Docs

https://bolojs.dev/docs/api/

## License

Apache-2.0
