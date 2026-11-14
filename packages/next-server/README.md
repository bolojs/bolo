# @bolojs/next-server

`NextDevServer` — a Next.js Pages Router dev server that runs on the main thread
inside a bolo container, mounted by `@bolojs/runtime` at `/__next/`.

This is not the `next` CLI. It is a from-scratch, browser-native emulation of the
Next.js Pages Router dev server, modeled on `@bolojs/vite-server`:

- Filesystem routes under `pages/` with dynamic segments (`[id]`) and catch-alls
  (`[...slug]`), plus API routes under `pages/api/`
- `_app` / `_document` support (see limitations below)
- `getStaticProps` executed at request time
- Full-reload HMR over BroadcastChannel (`{ type: "full-reload" }`)
- Page transforms via oxc-transform

> Limitation: `@next/swc-wasm-web` (Next 16) was evaluated and rejected: the
> wasm build hardwires Next's client-bundle page transform (it strips
> `getStaticProps` and emits `__N_SSG`), which breaks server-side data
> fetching, and no option disables that behavior. Revisit if the wasm surface
> gains a plain transform mode.

## Scope (N1)

Pages Router only. No App Router, no SSR (pages are client-rendered into the
assembled document shell), no Turbopack, no CSS modules, no `next/image`
optimization. Custom `_document` classes are compiled and served but not rendered
server-side; the default document shell is always used.

## Usage

```ts
import { NextDevServer } from "@bolojs/next-server";

const server = new NextDevServer({ vfs, root: "/home/web", base: "/__next" });
await server.start();
const res = await server.onFetch("https://sandbox.local/__next/", new Request("https://sandbox.local/__next/"));
```

The `@bolojs/runtime` `RuntimeBuilder` mounts an instance automatically at
`/__next/` next to the vite preview server at `/__preview/`.
