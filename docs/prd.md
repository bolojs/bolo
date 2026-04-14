# @browser-containers — Product Requirements Document

## Vision

An open-source, fully client-side Node.js runtime for the browser. Run Node.js applications, AI agent code, and build tools entirely in the browser — no server, no cloud, no installation.

## Scope (v1)

- Virtual filesystem backed by memfs (hot) + OPFS (cold)
- ServiceWorker-based network proxy for virtual localhost
- Node.js API shims: `node:fs`, `node:crypto`, `node:stream`, `node:http`, `node:path`, `node:buffer`, `node:url`, `node:events`, `node:os`, `node:child_process`, `node:worker_threads`
- WASM-based tool registry (esbuild, tsc, sass, swc)
- Package installation via npm-in-browser + esm.sh CDN fallback
- Vite dev server running in the browser
- Two-tier runtime: trusted V8 (user code) + untrusted QuickJS (AI agents)
- Opt-in sandbox policy with network, memory, CPU, and filesystem restrictions
- Backend framework compatibility: Hono, Express, Koa, Fastify, tRPC, Elysia, Nitro

## Non-Goals (v1)

- Next.js, Webpack support
- Native `.node` addons without WASM builds
- Raw TCP (pg native, Redis binary protocol)
- ShadowRealm / sandboxed iframe tier
- `fork()` / `cluster`
- SSR / Server Components

## Target Users

1. **Developers** who want to try Node.js libraries in the browser without setup
2. **AI agent platforms** that need sandboxed JavaScript execution (opencode, claude-code, pi-agent)
3. **Educators** who need zero-install Node.js environments for teaching

## License

Apache 2.0 throughout.
