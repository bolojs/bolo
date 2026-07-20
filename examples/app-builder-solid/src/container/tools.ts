import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { BrowserContainer, DirEnt } from "@bolojs/runtime";

// VfsBus.matchGlob (packages/vfs-bus/src/vfs-bus.ts) only matches "**", prefix*,
// *suffix, or exact-path globs — no recursive glob support. listFiles recurses
// readdir manually instead of relying on any glob-like directory listing.
export async function listFilesRecursive(container: BrowserContainer, dir: string): Promise<string[]> {
  const entries = (await container.fs.readdir(dir, { withFileTypes: true })) as DirEnt[];
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".npm-cache") continue;
    const path = `${dir}/${entry.name}`.replace(/\/+/g, "/");
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(container, path)));
    } else {
      out.push(path);
    }
  }
  return out;
}

export function createContainerTools(container: BrowserContainer, onOutput?: (line: string) => void): ToolSet {
  return {
    writeFile: tool({
      description: "Write (create or overwrite) a file at the given path relative to the project root.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path, e.g. src/App.jsx"),
        contents: z.string(),
      }),
      execute: async ({ path, contents }) => {
        const full = `${container.workdir}/${path}`.replace(/\/+/g, "/");
        const dir = full.slice(0, full.lastIndexOf("/"));
        if (dir && dir !== container.workdir) {
          await container.fs.mkdir(dir, { recursive: true });
        }
        await container.fs.writeFile(full, contents);
        return { ok: true, path };
      },
    }),
    readFile: tool({
      description: "Read the contents of a file at the given project-relative path.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const full = `${container.workdir}/${path}`.replace(/\/+/g, "/");
        const contents = await container.fs.readFile(full);
        return { path, contents };
      },
    }),
    deleteFile: tool({
      description: "Delete a file or directory (recursively) at the given project-relative path.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const full = `${container.workdir}/${path}`.replace(/\/+/g, "/");
        await container.fs.rm(full);
        return { ok: true, path };
      },
    }),
    listFiles: tool({
      description: "List all files in the project (recursively), excluding node_modules and .git.",
      inputSchema: z.object({}),
      execute: async () => {
        const files = await listFilesRecursive(container, container.workdir);
        return { files: files.map((f) => f.slice(container.workdir.length + 1)) };
      },
    }),
    runCommand: tool({
      description:
        "Run a shell command in the project root. Available runtimes: node, bun, npm " +
        "(e.g. npm install, npm run dev), plus runtime, agent, curl, nc, tcping, git — everything else " +
        "runs through a JS-only bash clone (no real OS), so python, pip, cargo, and go are not " +
        "available. git supports init, clone, status, add, commit, log, branch, checkout, fetch, " +
        "pull, push, remote, diff (no merge/rebase/stash). Waits up to 5s for the command to exit; " +
        "long-lived commands (e.g. a dev server) are left running in the background and reported as " +
        "still-running rather than blocking.",
      inputSchema: z.object({
        command: z.string(),
        args: z.array(z.string()).default([]),
      }),
      execute: async ({ command, args }) => {
        onOutput?.(`\r\n\x1b[2m~/project $ ${[command, ...args].join(" ")}\x1b[0m\r\n`);
        const proc = container.spawn(command, args);
        const reader = proc.output.getReader();
        let output = "";
        const drain = (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              output += value;
              onOutput?.(value);
            }
          } finally {
            reader.releaseLock();
          }
        })();

        const RUN_TIMEOUT_MS = 5000;
        const timeout = Symbol("timeout");
        const result = await Promise.race([
          proc.exit,
          new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), RUN_TIMEOUT_MS)),
        ]);

        if (result === timeout) {
          return {
            exitCode: null,
            output,
            note: "Still running after 5s — likely a long-lived process (e.g. a dev server). Left running in the background; not waiting further.",
          };
        }

        await drain;
        onOutput?.(`\r\n\x1b[2mexit ${result}\x1b[0m\r\n`);
        return { exitCode: result, output };
      },
    }),
  };
}
