# @bolojs/fs

Single-owner observable virtual filesystem (memfs + OPFS) for [bolo](https://github.com/bolojs/bolo)
containers. Used internally by `bolojs`; usable standalone if you need the VFS without the rest of
the runtime.

## Install

```bash
npm i @bolojs/fs
```

## Usage

```ts
import { VfsBus, snapshot, restore } from "@bolojs/fs";

const bus = new VfsBus();
await bus.writeFile("/hello.txt", "hi");

const blob = await snapshot(bus); // persist to IndexedDB, OPFS, etc.
await restore(bus, blob);
```

## Docs

https://bolojs.dev/docs/api/

## License

Apache-2.0
