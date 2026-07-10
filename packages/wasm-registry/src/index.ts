import {
  registerWasmTool,
  resolveWasmTool,
  createWasmRegistry,
  clearCache,
  getRegisteredToolNames,
  type WasmTool,
  type WasmToolResult,
  type WasmToolLoader,
} from "./registry";

export {
  registerWasmTool,
  resolveWasmTool,
  createWasmRegistry,
  clearCache,
  getRegisteredToolNames,
};
export { loadBinary, precacheAll, isInstalled, pruneCache, BINARY_MANIFEST } from "./binary-loader";
export type { WasmTool, WasmToolResult, WasmToolLoader };
export { createWasiTool } from "./wasi-executor.js";
export type { WasiToolOptions, WasiPreopen } from "./wasi-executor.js";
export { bundleEntry, transformScript } from "./bundle.js";
export type {
  BundleEntryOptions,
  BundleEntryResult,
  TransformScriptOptions,
  TransformScriptResult,
} from "./bundle.js";
