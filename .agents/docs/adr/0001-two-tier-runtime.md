# ADR-0001: Two-Tier Runtime (V8 Trusted + QuickJS Untrusted)

## Status

Accepted

## Context

The project runs user-provided JavaScript/TypeScript code inside the browser. There are two distinct trust profiles:

1. **User code** — the developer's own scripts, build tools (esbuild, tsc, Vite), and application logic. This code is trusted and needs full V8 JIT performance.
2. **AI agent code** — scripts from AI coding assistants (opencode, claude-code, pi-agent). This code is untrusted and needs hard resource caps (memory, CPU, network) that V8 Web Workers cannot provide.

A single runtime tier cannot serve both profiles. V8 has no C-level `setMemoryLimit` API available to JS. QuickJS via `quickjs-emscripten` provides `setMemoryLimit`, `setInterruptHandler`, and `setMaxStackSize` through its C host API.

## Decision

Adopt a two-tier runtime architecture:

- **Trusted V8 tier**: Native Web Worker with full JIT. Used for user scripts, Vite dev server, tsc, esbuild, ETL pipelines.
- **Untrusted QuickJS tier**: `quickjs-emscripten` WASM contexts. Used for AI agent scripts. Each agent execution gets a fresh QuickJS context with hard C-level caps applied at creation.

The performance cost of QuickJS (interpreter-only, ~2–5% overhead at N=1024 interrupt cycles) is negligible for AI agents because they are I/O-bound — LLM API latency (~seconds) dwarfs JS execution time (~milliseconds).

Sandbox policy (`@browser-containers/sandbox-policy`) is opt-in. When no policy is configured (`SandboxPresets.none`), the sandbox-policy library is not loaded — zero overhead for trusted-only usage.
