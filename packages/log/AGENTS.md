# @bolojs/log

Internal diagnostics logging for all bolo packages, separate from guest stdout passthrough.

bolo's own internal diagnostics (runtime/sandbox/network/installer/CLI code
describing what *bolo itself* is doing) go through `@bolojs/log`, a thin
wrapper around [logtape](https://logtape.org). This is separate from **guest
passthrough** - the sandboxed user/agent code's own stdout relay
(`worker-script.ts`'s console monkey-patch, `package-runner.ts`'s probe
output) - which stays on plain `console.*` since it's product behavior, not
a bolo diagnostic.

- `getLogger(["bolo", <package>, <module?>])` - Node and browser/worker/SW
  contexts alike (import from `@bolojs/log` in Node, `@bolojs/log/browser`
  elsewhere).
- `configureBoloLogging()` (Node only - CLI, compat-harness, Vitest, the
  Gauge+Playwright driver process) opens `.logs/<run>.jsonl` capturing
  **every** level, symlinked from `.logs/latest.jsonl`, plus a
  `warning`+ pretty console sink. `.logs/` is gitignored.
- Override console verbosity per category: `BOLO_LOG=sandbox=debug,net-shim=trace`.

**Debugging entrypoint for agents**: read `.logs/latest.jsonl` instead of
re-running commands hoping for more console output. It's already full
fidelity.

```bash
# Only errors and fatals
rg '"level":"(error|fatal)"' .logs/latest.jsonl

# Everything from one category branch (e.g. the iframe sandbox)
jq 'select(.category[1]=="runtime" and .category[2]=="iframe-sandbox")' .logs/latest.jsonl
```

A failed Vitest test (`onTestFailed`), Gauge scenario (`AfterScenario`), or
compat-harness `PackageResult` (fail status) all just print/attach this
path - pull the relevant lines in with `rg`/`jq` above rather than re-running
the test for more console output.
