import type { SandboxPolicy } from "./types.js";

export const createVfsAcl = (policy: SandboxPolicy | null) => {
  if (!policy) {
    return (_ctx: { path: string; operation: string }, next: () => void): void => {
      next();
    };
  }

  return (ctx: { path: string; operation: string }, next: () => void): void => {
    if (policy.fs.mode === "readOnly") {
      const writeOps = new Set(["writeFile", "mkdir", "rm"]);
      if (writeOps.has(ctx.operation)) {
        throw new Error(
          `Sandbox policy: write operation "${ctx.operation}" blocked on "${ctx.path}" (readOnly)`,
        );
      }
      next();
      return;
    }

    if (policy.fs.mode === "allowPaths" && policy.fs.allowPaths?.length) {
      const allowed = policy.fs.allowPaths.some(
        (p) => ctx.path === p || ctx.path.startsWith(`${p}/`),
      );
      if (!allowed) {
        throw new Error(`Sandbox policy: access to "${ctx.path}" denied (not in allowPaths)`);
      }
    }

    next();
  };
};
