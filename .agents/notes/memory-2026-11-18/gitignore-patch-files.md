---
tags:
- bolo
---
# Gotcha: global gitignore excludes *.patch files

`~/.gitignore-global` line ~289 has `*.patch`. Any new pnpm patch file under `patches/` is silently ignored by `git add` and never committed, which breaks CI with:

```
ENOENT: no such file or directory, open '.../patches/<name>.patch'
```

Fix: `git add -f patches/<file>.patch`.

This bit PR #208 (patch for `@rolldown/browser@1.3.2` was referenced in `pnpm-workspace.yaml` `patchedDependencies` but not tracked). Always verify after adding a patch: `git ls-files patches/`.

Also: `pnpm-workspace.yaml` `patchedDependencies` paths are relative to the REPO ROOT, not the package dir.
