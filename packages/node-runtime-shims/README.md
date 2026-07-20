# @bolojs/node-runtime-shims

`node:*` to `@bolojs/fs`/`@bolojs/sandbox` bridges for [bolo](https://github.com/bolojs/bolo):
`fs`, `http` (`createServer`), `net`, `child_process`. Depends on `@bolojs/fs` and
`@bolojs/sandbox`; used internally by `bolojs` to make containerized Node code work against the
virtual filesystem and network.

## Install

```bash
npm i @bolojs/node-runtime-shims @bolojs/fs @bolojs/sandbox
```

## Usage

Not typically consumed directly. `bolojs` wires this in automatically when you `boot()` a
container. Import it yourself only if you're assembling a custom runtime.

## Docs

https://bolojs.dev/docs/api/

## License

Apache-2.0
