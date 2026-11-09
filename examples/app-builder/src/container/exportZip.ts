import { zipSync, type Zippable } from "fflate";
import type { BrowserContainer } from "@bolojs/runtime";
import { listFilesRecursive } from "./tools";

export async function exportProjectZip(container: BrowserContainer): Promise<void> {
  const paths = await listFilesRecursive(container, container.workdir);
  const files: Zippable = {};
  for (const full of paths) {
    const rel = full.slice(container.workdir.length + 1);
    const contents = await container.fs.readFile(full);
    files[rel] = new TextEncoder().encode(contents);
  }

  const zipped = zipSync(files);
  const blob = new Blob([zipped], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "app-builder-project.zip";
  a.click();
  // Defer revoke: revoking synchronously can race the browser's download
  // trigger in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
