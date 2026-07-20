import "./client-globals";
import "./styles.css";
import { render } from "solid-js/web";
import App from "./App";
import { configureBrowserLogging } from "@bolojs/log/browser";
import type { BoloError } from "@bolojs/log/error-hints";
import { installMainRelay, diagnoseRuntimeAsync } from "@bolojs/runtime";

await configureBrowserLogging({
  customSink: (record) => {
    const flat = Array.isArray(record.message)
      ? record.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ")
      : String(record.message ?? "");
    (globalThis as { __boloObsPush?: (r: BoloError) => void }).__boloObsPush?.({
      kind: "unknown",
      source: "main",
      message: flat,
      ts: Date.now(),
    });
  },
});

installMainRelay();
const diag = await diagnoseRuntimeAsync();
if (!diag.ok) {
  console.warn("[bolo diagnose] blockers:", diag.blockers);
}
for (const w of diag.warnings) console.warn("[bolo diagnose]", w);

// Solid has no StrictMode. boot() is a process-wide singleton in
// @bolojs/runtime, but Solid's onMount runs exactly once per component
// lifetime, so the React app-builder's StrictMode-ban rationale does not
// apply here.
const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");
render(() => <App />, root);
