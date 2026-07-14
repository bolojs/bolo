---
title: Alternatives Comparison
description: How browser-containers compares to WebContainers, Nodebox, and other browser runtimes.
---

## Overview

browser-containers is one of several projects that let you run JavaScript/Node.js code
in the browser without a server. This page compares it honestly against the closest
alternatives so you can choose the right tool.

**Current status:** packages are workspace-only and not yet published to npm.
Embedding requires cloning the repo. See [getting-started.md](/docs/getting-started/).

## Comparison table

| | **browser-containers** | **WebContainers** | **Nodebox** | **OpenWebContainer** | **quickjs-emscripten** |
|---|---|---|---|---|---|
| **License** | Apache 2.0 | Proprietary | MIT + Commons Clause | MIT | MIT |
| **npm published** | No (workspace-only) | Yes | Yes | No | Yes |
| **Boot time** | ~100 ms (QuickJS) / ~500 ms (V8 worker) | 2–5 s | ~100 ms | Fast (QuickJS) | ~50 ms |
| **Bundle size** | TBD | Multi-MB | ~600 KB gzipped | Small | Small |
| **Node.js compat** | Partial (shims) | Full (via WASM) | 40+ polyfills | Shell sim only, no npm | Limited |
| **Native packages (NAPI)** | No | Yes | No | No | No |
| **VFS + persistence** | Yes (memfs + OPFS) | Yes | Yes | Yes | No |
| **Preview / live server** | Yes (SW + iframe) | Yes | Yes | No | No |
| **AI agent sandbox** | Yes (QuickJS, C-level caps) | No | No | No | Yes |
| **High-level `boot()` API** | Yes | Yes | Yes | No | No |
| **Dual execution tiers** | Yes (V8 trusted + QuickJS untrusted) | No | No | No | No |

Nodebox is dual-licensed MIT + [Commons Clause](https://commonsclause.com/), which is
**not OSI-approved** — it restricts selling or hosting the software itself as a
commercial product/service. browser-containers' plain Apache 2.0 has no such restriction.

For context, the proprietary high bar in this space is **BrowserPod** and **WebVM**
(both Leaning Technologies, built on the **CheerpX** engine — x86-to-WASM JIT + Linux
syscall emulator + block-based filesystem): real syscall emulation, unmodified native
npm packages/toolchains, multi-process concurrency, inbound networking. WebVM's own
*repo* is Apache 2.0, but that covers the demo/integration code only — the CheerpX
engine underneath requires a commercial license for any organizational use, so neither
project clears the FOSS bar and both are excluded from the comparison table above.

## When to choose browser-containers

- You need to **sandbox untrusted AI-generated code** with hard memory/CPU caps that
  cannot be bypassed from JavaScript. The QuickJS tier (via `SandboxPool`) imposes
  C-level limits on every execution.
- You want an **Apache 2.0 licensed** runtime with no proprietary lock-in.
- You need the **WASM build tool registry** (esbuild, tsc, sass, swc) running entirely
  client-side, or want to run arbitrary **`wasm32-wasip1` CLI binaries** (Rust/C/Zig
  tools compiled to WASI) via the same `registerWasmTool()` seam.
- You are building a platform where the **V8 trusted tier** runs user tooling and the
  **QuickJS untrusted tier** runs user-submitted or AI-generated code separately.
- You need **OPFS-backed VFS persistence** across sessions.

## When to choose an alternative

**WebContainers** — if you need a production-grade, npm-published API today with full
Node.js compatibility (including native C++ packages), enterprise support, and a
battle-tested embedding story. The `@webcontainer/api` package is well-documented and
used in production by StackBlitz and major framework docs sites.

**Nodebox** — if you need broad Node.js polyfill coverage (~40 modules), a fast boot
time, and can accept the Commons Clause commercial-use restriction. Sandpack 2.0 uses
Nodebox for interactive code examples. Good choice for documentation sites and tutorials.

**OpenWebContainer** — a smaller, less mature QuickJS-based peer (Web Workers, virtual
FS, shell simulation) if you want a minimal MIT-licensed starting point and don't need
npm integration, pipes, or signals yet.

**quickjs-emscripten** — if you only need sandboxed JS evaluation (no VFS, no shell,
no preview). Minimal footprint, works in Cloudflare Workers, Deno, and Node.js too.

## Current limitations

The following capabilities exist in one or more alternatives but are not yet implemented:

- **No npm publication** — must clone and build from source
- **No `fork()` / `cluster`** — multi-process Node.js patterns are out of scope
- **No native npm packages (NAPI)** — only pure-JS and WASM packages work
- **Webpack / Next.js** — explicitly out of scope (see [ADR-0003](/docs/adr/0003-no-webpack-nextjs/))
- **ServiceWorker required for preview** — HTTPS or localhost only

See [docs/prd.md](/docs/prd/) for the full scope and non-goals.
