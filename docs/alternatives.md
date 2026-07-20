---
title: Alternatives Comparison
description: How bolo compares to Node.js, WebContainers, AlmostNode, and Nodebox.
---

## Overview

bolo runs Node.js code in the browser: no server, no VM. This page compares it against the
closest reference point (Node.js itself) and the two closest browser-runtime alternatives,
so you can pick the right tool.

## Comparison table

|                        | **bolo**                  | **Node.js**       | **[WebContainers](https://webcontainers.io/)** | **[AlmostNode](https://almostnode.dev/)** | **[Nodebox](https://www.npmjs.com/package/@codesandbox/nodebox)** |
| ---------------------- | -------------------------- | ------------------ | ------------------- | ------------------ | ------------------ |
| **Where it runs**       | Browser                    | Server / CLI        | Browser              | Browser             | Browser             |
| **License**             | Apache 2.0                 | MIT                 | Proprietary          | MIT                 | MIT                 |
| **npm published**       | Yes                        | n/a                 | Yes                  | Yes                 | Yes                 |
| **Boot time**            | ~100ms (QuickJS) / ~500ms (V8 worker) | Instant (native) | 2 to 5s          | Instant             | ~1–2s               |
| **Node.js compat**       | Partial (shims)             | Full (it is Node)  | Full (via WASM)      | Partial (40+ shims) | Partial (polyfills)  |
| **Native packages (NAPI)** | No                       | Yes                 | Yes                  | No                  | No                  |
| **VFS + persistence**    | Yes (memfs + OPFS)          | Native filesystem   | Yes                  | Yes                 | Yes                 |
| **AI agent sandbox**     | Yes (QuickJS, C-level caps) | No                  | No                   | Cross-origin sandbox only | No                  |
| **`boot()`-style API**   | Yes                         | n/a                 | Yes                  | Yes                 | Yes                 |

## When to choose bolo

- You need to **sandbox untrusted AI-generated code** with hard memory/CPU caps that cannot be
  bypassed from JavaScript. The QuickJS tier (via `SandboxPool`) imposes C-level limits on every
  execution.
- You want an **Apache 2.0 licensed** runtime with no proprietary lock-in.
- You need a **client-side bundler** (rolldown + oxc-transform, wired in) with a
  `registerWasmTool()` seam for adding more native-binary-to-WASM tools, or want to run arbitrary
  `wasm32-wasip1` CLI binaries (Rust/C/Zig tools compiled to WASI) through that same seam.
- You are building a platform where the **trusted runtime tier** (V8 in Chromium-based browsers,
  SpiderMonkey in Firefox, JavaScriptCore in Safari) runs user tooling and the **QuickJS untrusted
  tier** runs user-submitted or AI-generated code separately.
- You need **OPFS-backed VFS persistence** across sessions.

## When to choose an alternative

**Node.js** (nodejs.org): if you don't need browser embedding at all. bolo trades full Node.js
compatibility for running client-side; if your workload runs server-side anyway, plain Node.js
has no compatibility gaps to work around.

**[WebContainers](https://webcontainers.io/)**: if you need a production-grade, npm-published API
today with full Node.js compatibility (including native packages), enterprise support, and a
battle-tested embedding story. The `@webcontainer/api` package is well-documented and used in
production by StackBlitz and major framework docs sites.

**[AlmostNode](https://almostnode.dev/)** ([source](https://github.com/macaly/almostnode)): if
you want a small (~250KB gzipped), MIT-licensed runtime with broad shim coverage and built-in
Vite/Next.js dev servers, and don't need a hardened untrusted-code sandbox.

**[Nodebox](https://www.npmjs.com/package/@codesandbox/nodebox)** ([source](https://github.com/codesandbox/nodebox)):
if you need a simple, iframe-based runtime with a clean shell API and are OK with less
flexibility than bolo offers (no OPFS persistence, no hardened AI sandbox, no bundled bundler).

## Current limitations

- **No raw TCP/IP sockets**: HTTP only, via the ServiceWorker proxy
- **No TLS / `https.createServer`**: no inbound TLS termination
- **No `fork()` / `cluster`**: multi-process Node.js patterns are out of scope
- **No native npm packages (NAPI)**: only pure-JS and WASM packages work
- **Webpack / Next.js**: explicitly out of scope
- **ServiceWorker required for preview**: HTTPS or localhost only

The full scope and non-goals are documented in the project.
