# @bolojs/pm

Browser-native npm package installer for [bolo](https://github.com/bolojs/bolo). Resolves the
registry and extracts tarballs into a `@bolojs/fs` virtual filesystem, no server required.

## Install

```bash
npm i @bolojs/pm
```

## Usage

```ts
import { PackageManager } from "@bolojs/pm";
import { VfsBus } from "@bolojs/fs";

const vfs = new VfsBus();
const pm = new PackageManager({ vfs, cwd: "/project" });

await pm.install(["lodash@^4"]);
```

Used internally by `bolojs` to power `npm install` inside a container; usable standalone in any
app that needs an in-browser package installer.

## Docs

https://bolojs.dev/docs/api/

## License

Apache-2.0
