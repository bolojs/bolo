import type { VfsBus } from "@bolojs/vfs-bus";
import type { FileSystemTree } from "./container-types.js";

export interface MountAPI {
  mountTree(tree: FileSystemTree, basePath?: string): Promise<void>;
}

export function createMount(vfs: VfsBus): MountAPI {
  async function mountTree(tree: FileSystemTree, basePath = ""): Promise<void> {
    for (const [name, node] of Object.entries(tree)) {
      const path = basePath ? `${basePath}/${name}` : `/${name}`;
      if ("file" in node) {
        const { contents } = node.file;
        if (contents instanceof ReadableStream) {
          const reader = contents.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const merged = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          await vfs.writeFile(path, merged);
        } else {
          await vfs.writeFile(path, contents);
        }
      } else if ("directory" in node) {
        await vfs.mkdir(path, { recursive: true });
        await mountTree(node.directory, path);
      }
    }
  }

  return { mountTree };
}
