---
tags:
- compat
- parcel
- lane_c
- npm_interop
---
parcel (npm) cannot run in the browser — Lane C.

Why: `parcel` -> `@parcel/core` -> `@parcel/utils` -> `@parcel/rust` (napi-rs native binding).
`@parcel/rust@2.16.4` ships `browser: "src/browser.js"` (napi-wasm path), but the
`parcel_node_bindings.wasm` artifact it needs is NOT in any published tarball
(verified 2.8.0 -> 2.16.4 via jsdelivr file listing) and is only built from source
(`yarn workspace @parcel/rust wasm:build-release`). `napi-wasm` is only an optional
peerDependency. `@parcel/watcher` is native-only (no wasm build). No `@parcel/*`
wasm package exists on npm.

Symptom when bundling parcel anyway: probe prints PASS then crashes with
`Error: Cannot find module "./artifacts/index.browser-x64.node"` — that comes from
`@parcel/source-map/parcel_sourcemap_node/index.js` (`require('./artifacts/index.${platform}-${arch}.node')`),
NOT from @parcel/rust. The bundler (`packages/wasm-registry/src/bundle.ts`) does not
honour an OBJECT-form `browser` map for a package's OWN entry when imported from
outside the package (only `applyBrowserFieldRemap` for intra-package imports), so
`@parcel/source-map` resolved to `dist/node.js` instead of `dist/wasm.js`.

Convention for platform-bound packages (rspack, turbo, parcel): BOTH
`apps/compat-harness/src/package-matrix.json` probe source prints
`console.log('SKIP: <reason>'); process.exit(0);` AND a lane-C entry in
`apps/compat-harness/src/package-expectations.json`. The harness classifies
`/\bskip\b/i` as "skip"; the site maps lane C to "unsupported"
(`apps/site/compat/scripts/build-data.js`).

Harness run recipe (server must be started from the worktree's apps/compat-harness):
`node apps/compat-harness/bin/cli.js --url http://localhost:PORT --packages "parcel" --output /tmp/x.json`
