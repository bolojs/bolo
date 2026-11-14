---
"@bolojs/next-server": minor
"@bolojs/runtime": patch
---

New package `@bolojs/next-server`: `NextDevServer`, a browser-native Next.js Pages Router dev server modeled on `@bolojs/vite-server`. Filesystem routes with dynamic segments and catch-alls, `_app` bootstrap, document shell assembly, API routes through `onFetch`, `getStaticProps` at request time, full-reload HMR over BroadcastChannel, built-in `next/*` shims (head, link, router, dynamic, image, script), oxc-transform page transforms, and a `nextTemplate` create-next-app Pages tree export. The `@bolojs/runtime` `RuntimeBuilder` mounts it at `/__next/` next to the vite preview at `/__preview/`.

Known limitation: `@next/swc-wasm-web` was evaluated and rejected; its wasm build hardwires Next's client-bundle page transform (strips `getStaticProps`), so transforms are oxc-only for now.
