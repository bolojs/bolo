import type { SandboxPolicy } from "./types.js";

export const mergePolicy = (
  preset: SandboxPolicy | null,
  known: Partial<SandboxPolicy> | undefined,
  override: Partial<SandboxPolicy> | undefined,
): SandboxPolicy | null => {
  if (!preset) return null;
  return {
    fetch: { ...preset.fetch, ...known?.fetch, ...override?.fetch },
    memory: { ...preset.memory, ...known?.memory, ...override?.memory },
    cpu: { ...preset.cpu, ...known?.cpu, ...override?.cpu },
    fs: { ...preset.fs, ...known?.fs, ...override?.fs },
  };
};
