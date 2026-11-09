# PBT regression records

Deterministic counterexamples captured from the property tests under
`tests/unit/property/` (differential: `@bolojs/node-web-shims` / `VfsBus` +
`createFsShim` vs the real `node:*` modules) and
`packages/node-runtime-shims/src/fs-shim.model.test.ts`.

## Convention

- One file per divergence area: `<area>-<impl>-divergences.test.ts`
  (e.g. `path-pathe-divergences.test.ts`).
- Each entry is `it.fails` (Vitest expected-failure) or `it.skip`, named
  `[seed N] <one-line reason>` where N is the seed fast-check reported when
  the property failed. Replay it with `FC_SEED=N` (and optionally
  `FC_NUM_RUNS`) — see `tests/unit/property/fc-config.ts`.
- A test here failing the suite means the shim started behaving like node —
  remove the entry and un-filter the input in the corresponding property.
- Do not fix shims as a side effect of finding a divergence; record it here
  first and let the owning slice decide.
