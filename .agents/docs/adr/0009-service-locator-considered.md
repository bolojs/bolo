# ADR-0009: Service-locator pattern (considered, rejected)

## Status

Accepted, 2026-07-19

## Context

A landscape comparison against [dhravya/burrow](https://github.com/dhravya/burrow) surfaced burrow's service-locator pattern as a candidate for bolo's runtime orchestration layer. burrow modules communicate exclusively through a typed registry (`src/contract/`):

- `provide<K extends keyof Services>(name, service)` — throws on double-provide.
- `use<K>(name)` — throws if not yet provided.
- `tryUse<K>(name)` — returns `undefined` for optional lookups.
- Services keyed by string-literal types (`events`, `vfs`, `gitFs`, `toolchain`, `git`, `shell`, `ai`).
- One sanctioned cross-module import exception (npm reaches into toolchain for the `bun` command).
- `resetRegistryForTests()` is required because `bun test` runs all spec files in a single process.

The question for bolo: should `packages/runtime` adopt a similar seam at the composition layer (where `boot.ts` wires together `vfs-bus`, `sw-sandbox`, `node-runtime-shims`, `node-web-shims`, `wasm-registry`, `npm`, `vite-server`)?

A deep audit of `packages/runtime/src/boot.ts` found:

- `doBoot()` is a single 165-line function (`boot.ts:48-212`) that instantiates nine siblings in dependency order.
- Coupling is **wide but shallow**: each sibling is constructed once with a plain-object deps bag (`BrowserContainerDeps`, `ShellServiceDeps`, `ProcessDeps`). No hidden singletons. No import cycles.
- bolo already has factory injection where it matters:
  - `createLiveShimRegistry` (`node-runtime-shims/src/live.ts:89`) injects `netBackend`, `dgramBackend`, `tlsBackend`, `workerThreadsBackend`, `nativeAddonLoader`.
  - `SandboxBackend` is injectable via `BootOptions.sandbox` (`runtime/src/sandbox-backend.ts`).
  - `registerWasmTool(name, loader)` (`wasm-registry/src/registry.ts:18`) is a true global tool registry for the bundler.
- `globalThis.__browserContainers` (`shell-service.ts:234`, `boot.ts:88`) is already an untyped service locator, used by `bundle.ts:534` to wire shims at bundle time. It exists because bundler code runs in a separate realm and cannot close over local variables. Adding a typed service-locator on top would not replace this seam; it would parallel it.

## Decision

Do **not** adopt a service-locator pattern. Composition flexibility is achieved instead by:

- **B1** — Extract `doBoot()` into a `RuntimeBuilder` class with overridable per-step methods (`buildVfs`, `buildSw`, `buildSandbox`, `buildWorker`, etc.). Consumers subclass or replace individual steps without copying the entire boot sequence.
- **B2** — Expose `shellService?`, `vfsFactory?`, and (later) `packageManager?` as `BootOptions` so common swaps do not require subclassing.

This is tracked in `.agents/plans/2026-07-19-npm-rigor-runtime-builder.md` §B1 and §B2.

## Consequences

**Pros**

- No new abstraction layer in `packages/runtime`.
- Existing factory seams (`createLiveShimRegistry`, `BootOptions.sandbox`, `registerWasmTool`) remain the canonical extension points.
- Tree-shaking stays intact. burrow's pattern defeats it because every module imports the registry, which imports every service type.
- Smaller API surface for consumers embedding bolo's runtime as a library.
- No `resetRegistryForTests()` analog needed; bolo's Vitest runs each spec file in isolation by default.

**Cons**

- Until B1 + B2 ship, consumers wanting to swap `PackageManager`, `VfsBus`, `SWSandbox`, `ShellService`, `BrowserViteServer`, or `RuntimeWorker` wholesale must fork `boot.ts`. The list of forkbable components is short and stable.
- Cross-realm coordination (`bundle.ts` reaching back into the runtime) continues to use `globalThis.__browserContainers`. A typed wrapper around it is a separate future decision, not justified today.

## Alternatives considered

1. **Adopt burrow-style service-locator across the runtime layer.** Rejected. Coupling in `boot.ts` is wide-but-shallow; the registry would add a new abstraction without removing meaningful coupling. burrow's tight boot-order coupling (`initVfs → initGit → initToolchain → initAi → initShell`) is itself a cost, not a benefit. The `resetRegistryForTests()` workaround is a smell.

2. **DI container (tsyrunge, InversifyJS).** Rejected. Adds a runtime dependency, requires decorators or explicit tokens, and is heavier than the problem warrants for a library (as opposed to an application).

3. **Status quo + B1 + B2 (chosen).** The coupling that exists is the minimum needed to wire the runtime together. Where consumers need extension, prefer factory injection at the lowest possible layer (already done for shims, sandbox, wasm tools) and `BootOptions` for orchestration-level swaps. Reserve `RuntimeBuilder` subclassing for the rare case where a consumer needs to replace a fundamental step.

## Evidence

- burrow `src/contract/registry.ts` — `provide`/`use`/`tryUse`/`resetRegistryForTests`.
- burrow `src/contract/types.ts:485-493` — service keys.
- burrow `main.tsx` init order: `initVfs → initGit → initToolchain → initAi → initShell`.
- bolo `packages/runtime/src/boot.ts:48-212` — single `doBoot()` function.
- bolo `packages/node-runtime-shims/src/live.ts:89` — `LiveShimRegistryOptions` already exposes backend injection points.
- bolo `packages/runtime/src/sandbox-backend.ts` — `SandboxBackend` interface.
- bolo `packages/wasm-registry/src/registry.ts:18` — `registerWasmTool` registry seam.
- bolo `packages/runtime/src/shell-service.ts:234` + `packages/runtime/src/boot.ts:88` — existing `globalThis.__browserContainers` service locator (untyped, bundle-time only).
- bolo `packages/runtime/src/bundle.ts:534` — consumer of `__browserContainers`.

## Cross-references

- Originating comparison: `.agents/plans/2026-07-19-npm-rigor-runtime-builder.md` §B3.
- Sibling units: B1 (`RuntimeBuilder` extraction), B2 (`BootOptions` extensions).
- Related: ADR-0001 (two-tier runtime), ADR-0006 (sandbox pivot to iframe).
