import type { VfsBus, WatchHandler } from "@bolojs/vfs-bus";
import type { Watcher } from "./container-types.js";

export function createWatchAdapter(vfs: VfsBus) {
  return function watch(
    path: string,
    _options?: { recursive?: boolean },
    listener?: (event: "rename" | "change", filename: string) => void,
  ): Watcher {
    const glob = path.includes(".") ? path : `${path}/*`;

    const handler: WatchHandler = (filePath, event) => {
      if (!listener) return;
      const filename = filePath.substring(filePath.lastIndexOf("/") + 1);
      if (event === "add" || event === "unlink") {
        listener("rename", filename);
      } else if (event === "change") {
        listener("change", filename);
      }
    };

    const watcher = vfs.watch(glob, handler);
    return { close: () => watcher.close() };
  };
}
