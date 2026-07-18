# Agent QA tooling

Interactive browser QA uses `playwright-cli` (project-local devDependency, invoked via `pnpm exec playwright-cli`). Same engine as the E2E suite under `tests/e2e/`.

Known gaps vs the previous agent-browser tool, with workarounds:

| Gap | Workaround |
|-----|-----------|
| No `wait-for-element` / `wait --fn` | `eval` + `waitForTimeout` polling, or `eval "await page.waitForSelector(...)"` |
| Snapshot is file-based (2 calls vs 1) | Read the returned YAML path in the next call; acceptable cost |
| No annotated screenshots | Use `show --annotate` for interactive sessions; for CI artifacts rely on the E2E suite's `@CustomScreenshotWriter` |
| No visual diff | Out of scope for QA tool; visual regression belongs in E2E |

Revisit upstream in 2-3 months; if `wait-for-element` lands, drop the documented workarounds.

## Layout

```
tests/
  unit/              Vitest, no browser
  integration/       Vitest + happy-dom
  e2e/               Gauge + Playwright specs. Use `playwright-cli` skill for QA, Gauge for suite work
```
