export interface SandboxPolicy {
  fetch: { mode: "allow" | "deny"; allowList?: string[]; denyList?: string[] };
  memory: { limitMb: number };
  cpu: { maxOpsPerInterval: number; intervalMs: number };
  fs: { mode: "readOnly" | "allowPaths"; allowPaths?: string[] };
}

export const SandboxPresets: Record<string, SandboxPolicy | null> = {
  none: null,
  moderate: {
    fetch: { mode: "allow" },
    memory: { limitMb: 128 },
    cpu: { maxOpsPerInterval: 1_000_000, intervalMs: 1000 },
    fs: { mode: "readOnly" },
  },
  strict: {
    fetch: { mode: "deny" },
    memory: { limitMb: 64 },
    cpu: { maxOpsPerInterval: 100_000, intervalMs: 1000 },
    fs: { mode: "readOnly" },
  },
};

export const KnownAgentPolicies: Record<string, Partial<SandboxPolicy>> = {
  opencode: {},
  "claude-code": { memory: { limitMb: 256 } },
  pi: { fetch: { mode: "allow", allowList: ["https://api.example.com"] } },
};
