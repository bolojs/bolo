import { zipSync, strToU8 } from "fflate";
import type { BrowserContainer, DirEnt } from "@bolojs/runtime";

async function collectFiles(
  container: BrowserContainer,
  dir: string,
): Promise<Record<string, Uint8Array>> {
  const entries = (await container.fs.readdir(dir, { withFileTypes: true })) as DirEnt[];
  const out: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".npm-cache") continue;
    const path = `${dir}/${entry.name}`.replace(/\/+/g, "/");
    if (entry.isDirectory()) {
      Object.assign(out, await collectFiles(container, path));
    } else {
      out[path.slice(container.workdir.length + 1)] = strToU8(await container.fs.readFile(path));
    }
  }
  return out;
}

export async function exportProjectZip(container: BrowserContainer): Promise<Blob> {
  const files = await collectFiles(container, container.workdir);
  return new Blob([zipSync(files)], { type: "application/zip" });
}
