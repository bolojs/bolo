// Load @rolldown/browser as a bundled (same-origin) module so its WASI worker
// isn't spawned cross-origin (issue #12). oxc-transform stays on CDN — see bundle.ts.
declare global {
  var __preferLocalRolldown: boolean | undefined;
}
globalThis.__preferLocalRolldown = true;

import { render } from "solid-js/web";
import App from "./App";
import "./style.css";

if (typeof globalThis.process !== "undefined") {
  const proc = globalThis.process as any;
  if (!proc.stdin) {
    proc.stdin = {
      on: () => {},
      pipe: () => {},
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
      isTTY: false,
    };
  }
  if (!proc.stdout) {
    proc.stdout = {
      write: () => {},
      on: () => {},
      once: () => {},
      emit: () => {},
      isTTY: false,
    };
  }
  if (!proc.stderr) {
    proc.stderr = {
      write: () => {},
      on: () => {},
      once: () => {},
      emit: () => {},
      isTTY: false,
    };
  }
}

render(() => <App />, document.getElementById("root")!);
