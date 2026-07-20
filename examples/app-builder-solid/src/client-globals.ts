// Must stay the first import in main.tsx. @bolojs/vite-preset disables
// vite-plugin-node-polyfills' per-module Buffer banner (it collides across
// hydration/HMR boundaries — "Identifier '__buffer_polyfill' has already
// been declared"), so this is the only place globalThis.Buffer gets set.
import { Buffer } from "buffer";

globalThis.Buffer ??= Buffer;

declare global {
  // eslint-disable-next-line no-var
  var __preferLocalBundler: boolean | undefined;
}

// Serve @rolldown/browser + oxc-transform from this dev server's node_modules
// (same-origin) instead of the esm.sh CDN. Required: under the page's COEP
// `credentialless` header, oxc-transform's WASM binding spawns workers from
// esm.sh cross-origin, which Worker construction blocks. The aggregate flag
// drives both packages (per packages/wasm-registry/src/bundle.ts).
globalThis.__preferLocalBundler = true;
