# wasi-echo fixture

Trivial `wasm32-wasip1` binary used by `wasi-executor.test.ts` to exercise a
real WASI module against `VfsBashFileSystem`-adjacent `VfsBus` preopens: it
prints argv, reads `/work/input.txt`, and writes `/work/output.txt`.

Rebuild with zig (any recent version with a `wasm32-wasi` target):

```sh
zig cc -target wasm32-wasi-musl -Os -s -o echo.wasm echo.c
```
