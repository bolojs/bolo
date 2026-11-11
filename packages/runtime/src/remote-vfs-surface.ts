/**
 * The memfs surface the process-worker VFS facade exposes, shared by the
 * main-side op table (`remote-ops.ts`) and the worker-side facade
 * (`remote-objects.ts`). Keeping the lists in one module is what guarantees
 * the two sides cannot drift: the fs shim (`@bolojs/node-runtime-shims`)
 * reads this surface at construction, so any member the shim touches must
 * either be proxied here or feature-detected there.
 *
 * Wire ops are flat-named: `vfs.hot.<m>` (sync or async-RPC depending on the
 * list), `vfs.hot.promises.<m>` and `vfs.vol.<m>` (both async-RPC / sync
 * channel respectively, see remote-ops.ts).
 */

/**
 * Sync `hot` methods proxied over the sync channel as `vfs.hot.<m>`.
 * Args and results must be marshalling-safe (no callbacks, no live objects).
 * `readSync`/`readvSync` are excluded — they mutate their buffer arg and are
 * served by dedicated ops that round-trip the bytes.
 * `opendirSync` is excluded — its `Dir` result cannot cross the boundary.
 */
export const HOT_SYNC_METHODS = [
  "readFileSync",
  "writeFileSync",
  "mkdirSync",
  "rmSync",
  "readdirSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "symlinkSync",
  "readlinkSync",
  "renameSync",
  "copyFileSync",
  "chmodSync",
  "appendFileSync",
  "realpathSync",
  "utimesSync",
  "truncateSync",
  "unlinkSync",
  "rmdirSync",
  "accessSync",
  "mkdtempSync",
  // Breadth: chown/link/lchmod/lchown/lutimes + the fd family. memfs fds are
  // plain numbers on the main-side volume, so they survive the wire.
  "chownSync",
  "linkSync",
  "lchmodSync",
  "lchownSync",
  "lutimesSync",
  "openSync",
  "closeSync",
  "fchmodSync",
  "fchownSync",
  "fdatasyncSync",
  "fstatSync",
  "fsyncSync",
  "ftruncateSync",
  "futimesSync",
  "writeSync",
  "writevSync",
] as const;

/**
 * Callback-style async `hot` methods proxied over async RPC as `vfs.hot.<m>`.
 * Main wraps the memfs Node-callback API in a promise resolving the single
 * result. Excluded:
 * - `read`/`readv`/`write`/`writev` — buffer args round-trip via dedicated
 *   ops.
 * - `opendir` — returns a live `Dir`.
 * - `watchFile`/`unwatchFile`, `createReadStream`/`createWriteStream` —
 *   listeners/streams cannot cross the boundary; the fs shim throws a clear
 *   "not supported" error for these instead.
 */
export const HOT_CALLBACK_METHODS = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "close",
  "copyFile",
  "cp",
  "fchmod",
  "fchown",
  "fdatasync",
  "fstat",
  "fsync",
  "ftruncate",
  "futimes",
  "glob",
  "lchmod",
  "lchown",
  "link",
  "lutimes",
  "mkdtemp",
  "open",
  "realpath",
  "rename",
  "rmdir",
  "statfs",
  "truncate",
  "unlink",
  "utimes",
] as const;

/**
 * `hot.promises` methods proxied over async RPC as `vfs.hot.promises.<m>`.
 * Excluded: `open`/`opendir`/`watch`/`glob` (FileHandle/Dir/AsyncIterator
 * results cannot cross) and `constants`/`FileHandle` (not callable).
 */
export const HOT_PROMISE_METHODS = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "lchmod",
  "lchown",
  "link",
  "lutimes",
  "mkdtemp",
  "realpath",
  "rename",
  "rmdir",
  "statfs",
  "truncate",
  "unlink",
  "utimes",
] as const;

/**
 * `Volume` methods the memfs `IFs` facade does not carry (`vfs.vol.<m>`,
 * sync channel). `statfsSync`/`cpSync` live only on the Volume.
 */
export const VOL_SYNC_METHODS = ["cpSync", "statfsSync"] as const;

/**
 * `hot` methods whose result is a memfs `Stats` object. Stats cross the wire
 * as plain JSON; the facade re-derives the `isFile()`/… predicates from
 * `st_mode`. Applies to both sync and async-RPC variants.
 */
export const HOT_STAT_METHODS: ReadonlySet<string> = new Set([
  "statSync",
  "lstatSync",
  "fstatSync",
  "fstat",
]);
