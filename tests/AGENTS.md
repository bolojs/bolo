# Agent QA tooling

Interactive browser QA uses `playwright-cli` (project-local devDependency, invoked via `pnpm exec playwright-cli`). Same engine as the E2E suite under `tests/e2e/`.

Before diagnosing any preview, container, worker, or service-worker failure, install the observability harness (page console + pageerror + requestfailed + worker/SW lifecycle hooks). Debugging browser-runtime failures with only the page console is debugging blind. See `examples/app-builder/scripts/pw-observe.js` for a reference implementation.

Known gaps vs the previous agent-browser tool, with workarounds:

| Gap | Workaround |
|-----|-----------|
| No `wait-for-element` / `wait --fn` | `eval` + `waitForTimeout` polling, or `eval "await page.waitForSelector(...)"` |
| Snapshot is file-based (2 calls vs 1) | Read the returned YAML path in the next call; acceptable cost |
| No annotated screenshots | Use `show --annotate` for interactive sessions; for CI artifacts rely on the E2E suite's `@CustomScreenshotWriter` |
| No visual diff | Out of scope for QA tool; visual regression belongs in E2E |
| Worker/SW console + async worker errors not captured by `playwright-cli console` | Install an in-process event tap via `run-code --filename=<observe.js>`; drain the buffer with a second `run-code` call. Reference impl: `examples/app-builder/scripts/pw-observe.js` |

Revisit upstream in 2-3 months; if `wait-for-element` lands, drop the documented workarounds.

## Layout

```
tests/
  unit/              Vitest, no browser
  integration/       Vitest + happy-dom
  e2e/               Gauge + Playwright specs. Use `playwright-cli` skill for QA, Gauge for suite work
```
