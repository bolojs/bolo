// Single-scope global install. Must stay the first import in Demo.tsx: node-polyfills'
// per-module Buffer banner is disabled in astro.config.mjs (it collided during hydration),
// so this is the only place globalThis.Buffer gets set for client-executed code.
import { Buffer } from "buffer";

globalThis.Buffer ??= Buffer;
