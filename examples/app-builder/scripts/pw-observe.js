// Observability harness for debugging app-builder preview/worker/SW failures.
// Installs Playwright event listeners in the playwright-cli daemon process
// (Node side), buffering to a closure; drain via `window.__boloObsDrain()`.
// See examples/app-builder/AGENTS.md "Observability before debugging".
//
// Usage:
//   playwright-cli -s=appdbg open --persistent
//   playwright-cli -s=appdbg run-code --filename=examples/app-builder/scripts/pw-observe.js
//   playwright-cli -s=appdbg goto http://127.0.0.1:4402/
//   ... reproduce the failure ...
//   playwright-cli -s=appdbg eval "await window.__boloObsDrain()"
async (page) => {
  const buffer = [];
  const rec = (kind, text) =>
    buffer.push(
      `${new Date().toISOString().slice(11, 19)} [${kind}] ${typeof text === "string" ? text : JSON.stringify(text)}`,
    );

  page.on("console", (m) => rec(`console.${m.type()}`, m.text()));
  page.on("pageerror", (e) => rec("pageerror", (e && e.stack) || String(e)));
  page.on("requestfailed", (r) => rec("requestfailed", `${r.url()} :: ${r.failure()?.errorText ?? "unknown"}`));
  page.on("response", (r) => {
    if (r.status() >= 400) rec(`http-${r.status()}`, r.url());
  });
  page.on("workercreated", (w) => {
    rec("workercreated", w.url());
    w.on("close", () => rec("workerclosed", w.url()));
  });
  const ctx = page.context();
  ctx.on("serviceworkercreated", (w) => rec("sw-created", w.url()));

  const swState = async () => {
    try {
      return await page.evaluate(() =>
        navigator.serviceWorker
          ? Promise.all(
              navigator.serviceWorker.getRegistrations().map(async (r) => ({
                scope: r.scope,
                active: r.active && r.active.state,
                waiting: r.waiting && r.waiting.state,
                installing: r.installing && r.installing.state,
                controller: !!navigator.serviceWorker.controller,
              })),
            )
          : "no serviceWorker API",
      );
    } catch (e) {
      return String(e);
    }
  };
  rec("sw-state", JSON.stringify(await swState()));
  setInterval(() => {
    swState().then((s) => rec("sw-state", JSON.stringify(s)));
  }, 5000);

  await page.exposeFunction("__boloObsDrain", () => buffer.splice(0).join("\n"));

  return "observability hooks installed; drain with: playwright-cli -s=appdbg eval \"await window.__boloObsDrain()\"";
}
