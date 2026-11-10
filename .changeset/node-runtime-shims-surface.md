---
"@bolojs/node-runtime-shims": minor
"@bolojs/runtime": patch
---

Broaden `fs` shim surface via memfs (`vfs.hot`/`vfs.vol` passthrough): `realpath*` incl. `.native`, fd API + `fs.promises.open` FileHandle, `rename`/`unlink`/`copyFile`/`appendFile`/`access`/`mkdtemp`/`rmdir`/`truncate`/`chmod`/`utimes`/`cp`/`statfs`, `createReadStream`/`createWriteStream`, `watchFile`/`unwatchFile`, `constants`, stream/stat classes, Node-style callbacks on the async API, and `fs.promises` parity. Expand `process` surface: `env` Proxy with ToString coercion, `arch`/`execPath`/`release`/`features`/`config`, `emitWarning`, `setUncaughtExceptionCaptureCallback`/`hasUncaughtExceptionCaptureCallback` (wired into the process worker's uncaught path), and `getBuiltinModule` resolving through the live registry. Complete `child_process` export shape (`execFile`, `execFileSync`, `ChildProcess`, `spawnfile`/`spawnargs`/`stdio`/`signalCode`, `ref`/`unref`) for globby/del-style imports. Fix timers singleton leak: each live registry now gets its own timers object so the process worker's `Object.assign` no longer mutates the shared unenv module across coexisting containers.
