import type { VfsBus } from "@bolojs/vfs-bus";
import type { PromiseFsClient } from "isomorphic-git";

/** Ponytail: memfs hot promises already implements the full PromiseFsClient
 *  surface isomorphic-git needs. This factory just extracts and re-exports it. */
export const createGitFs = (vfs: VfsBus): PromiseFsClient => {
  const promises = vfs.hot.promises;
  return { promises };
};
