import "./client-globals";
import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { configureBrowserLogging } from "@bolojs/log/browser";
import type { BoloError } from "@bolojs/log/error-hints";
import { installMainRelay, diagnoseRuntimeAsync } from "@bolojs/runtime";

await configureBrowserLogging({
  customSink: (record) => {
    // Route logtape records through the same buffer as uncaught exceptions.
    // logtape `message` is a readonly tuple of positional args; flatten to string.
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

// No <StrictMode>: boot() is a process-wide container singleton (see
// packages/runtime/src/boot.ts) and StrictMode's dev-only double-invoke of
// effects races two overlapping boot/teardown cycles against it.
createRoot(document.getElementById("root")!).render(<App />);
