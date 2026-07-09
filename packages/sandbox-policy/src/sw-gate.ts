import type { SandboxPolicy } from "./types.js";

export const createSwGate = (policy: SandboxPolicy | null) => {
  if (!policy) {
    return (req: Request): Response | null => null;
  }

  return (req: Request): Response | null => {
    if (policy.fetch.mode === "deny") {
      return new Response(`Blocked by sandbox policy: fetch denied for ${req.url}`, {
        status: 403,
      });
    }

    if (policy.fetch.denyList?.length) {
      const url = new URL(req.url);
      const blocked = policy.fetch.denyList.some(
        (pattern) => url.href.startsWith(pattern) || url.origin === pattern,
      );
      if (blocked) {
        return new Response(`Blocked by sandbox policy: ${req.url} is on deny list`, {
          status: 403,
        });
      }
    }

    if (policy.fetch.allowList?.length) {
      const url = new URL(req.url);
      const allowed = policy.fetch.allowList.some(
        (pattern) => url.href.startsWith(pattern) || url.origin === pattern,
      );
      if (!allowed) {
        return new Response(`Blocked by sandbox policy: ${req.url} not on allow list`, {
          status: 403,
        });
      }
    }

    return null;
  };
};
