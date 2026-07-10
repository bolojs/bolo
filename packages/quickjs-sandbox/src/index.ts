// Re-export SandboxPool + policy helpers for users who need resource caps
export { SandboxPool } from "./sandbox-pool.js";
export {
  SandboxPresets,
  KnownAgentPolicies,
  mergePolicy,
  createSwGate,
  createVfsAcl,
} from "@browser-containers/sandbox-policy";
export type { SandboxPolicy } from "@browser-containers/sandbox-policy";
export { QuickJSSandbox } from "./quickjs-sandbox.js";
export type { SandboxBackend, SandboxRunResult } from "@browser-containers/runtime";
