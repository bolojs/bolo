import type { Plugin } from "vite";

export const nodeRuntimeShims = (_options: { vfs: unknown; sandbox: unknown }): Plugin => {
  return {
    name: "node-runtime-shims",
    resolveId(id: string): string | null {
      if (
        id === "node:fs" ||
        id === "node:fs/promises" ||
        id === "node:http" ||
        id === "node:net" ||
        id === "node:child_process"
      ) {
        return id;
      }
      return null;
    },
    load(id: string): string | null {
      if (id === "node:fs") {
        return `import { createFsShim } from '@browser-containers/node-runtime-shims/dist/fs-shim.js';\nexport default createFsShim(globalThis.__vfsBus);`;
      }
      if (id === "node:fs/promises") {
        return `import { createFsShim } from '@browser-containers/node-runtime-shims/dist/fs-shim.js';\nconst fs = createFsShim(globalThis.__vfsBus);\nexport const { readFile, writeFile, mkdir, rm, readdir, exists, stat } = fs.promises;`;
      }
      if (id === "node:http" || id === "node:net") {
        return `import { createHttpShim } from '@browser-containers/node-runtime-shims/dist/http-shim.js';\nexport const { createServer } = createHttpShim(globalThis.__sandbox, globalThis.__httpShimOptions);`;
      }
      if (id === "node:child_process") {
        return `import { createChildProcessShim } from '@browser-containers/node-runtime-shims/dist/child-process-shim.js';\nexport const { spawn, exec } = createChildProcessShim(globalThis.__wasmRegistry, globalThis.__shellService);`;
      }
      return null;
    },
  };
};
