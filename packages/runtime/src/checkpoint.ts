import type { VfsBus } from "@bolojs/fs";
import { supportsSnapshots, type SandboxBackend, type SandboxSnapshot } from "./sandbox-backend.js";

export const CHECKPOINT_FORMAT = "bolo-checkpoint@1";

export interface ContainerCheckpoint {
  /** VfsBus.snapshot() output (memfs volume JSON). */
  vfs: Record<string, unknown>;
  /** Backend state snapshot; present only when the backend supports it. */
  sandbox?: SandboxSnapshot;
  /** Checkpoint format tag; resume rejects any other value. */
  format: typeof CHECKPOINT_FORMAT;
  workdir: string;
  createdAt: string;
}

export const createContainerCheckpoint = async (
  vfs: VfsBus,
  sandbox: SandboxBackend | undefined,
  workdir: string,
): Promise<ContainerCheckpoint> => ({
  vfs: vfs.snapshot(),
  sandbox: sandbox && supportsSnapshots(sandbox) ? await sandbox.snapshot() : undefined,
  format: CHECKPOINT_FORMAT,
  workdir,
  createdAt: new Date().toISOString(),
});

export const validateCheckpoint = (checkpoint: ContainerCheckpoint): void => {
  if (checkpoint?.format !== CHECKPOINT_FORMAT) {
    throw new Error(
      `Unsupported checkpoint format: ${String(checkpoint?.format)} (expected ${CHECKPOINT_FORMAT})`,
    );
  }
  if (typeof checkpoint.workdir !== "string" || checkpoint.workdir.length === 0) {
    throw new Error("Invalid checkpoint: missing workdir");
  }
  if (typeof checkpoint.vfs !== "object" || checkpoint.vfs === null) {
    throw new Error("Invalid checkpoint: missing vfs snapshot");
  }
};
