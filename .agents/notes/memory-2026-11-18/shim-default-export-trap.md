---
tags:
- bolo
- npm_interop
---
When replacing an unenv-backed shim module wholesale, check what unenv's own runtime modules import from it first. `unenv/dist/runtime/node/util.mjs` does `import types from "node:util/types"` — a default import. Real Node's `util/types` has no default export (CJS namespace), so a faithful rewrite that omits `default` breaks every consumer bundle (compat-harness vite/rolldown build failed with MISSING_EXPORT "default"). Rule: when a shim module is aliased onto a path unenv itself imports, keep unenv's export shape (including synthetic default) even where real Node differs. Related: `gitignore-patch-files.md` (unenv patch files must be tracked).