import "./client-globals";
import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { configureBrowserLogging } from "@bolojs/log/browser";

await configureBrowserLogging();

// No <StrictMode>: boot() is a process-wide container singleton (see
// packages/runtime/src/boot.ts) and StrictMode's dev-only double-invoke of
// effects races two overlapping boot/teardown cycles against it.
createRoot(document.getElementById("root")!).render(<App />);
