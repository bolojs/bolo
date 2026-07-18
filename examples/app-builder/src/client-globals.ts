// Must stay the first import in main.tsx. @bolojs/vite-preset disables
// vite-plugin-node-polyfills' per-module Buffer banner (it collides across
// hydration/HMR boundaries — "Identifier '__buffer_polyfill' has already
// been declared"), so this is the only place globalThis.Buffer gets set.
import { Buffer } from "buffer";

globalThis.Buffer ??= Buffer;

declare global {
  // eslint-disable-next-line no-var
  var __preferLocalRolldown: boolean | undefined;
}

// @rolldown/browser is not a dependency of this example (no in-browser bundling
// scenario like the landing demo's editor), so this flag is a no-op here — kept
// for parity in case a future scenario pulls it in transitively via @bolojs/runtime.
globalThis.__preferLocalRolldown = true;
