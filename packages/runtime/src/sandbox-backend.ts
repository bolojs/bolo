export interface SandboxRunResult {
  result?: string;
  error?: string;
}

export interface SandboxSnapshot {
  /** Opaque bytes; format is backend-defined and locked to the producing build. */
  bytes: Uint8Array;
  /** Backend + format tag, e.g. "quickjs-sandbox@1". Restore must reject mismatches. */
  format: string;
}

export interface SandboxBackend {
  run(code: string): Promise<SandboxRunResult>;
  dispose(): void;
  /** Capture execution/global state at a quiescent point. Absent = unsupported. */
  snapshot?(): Promise<SandboxSnapshot>;
  /**
   * Restore a snapshot produced by this backend/build. Policy (limits,
   * interrupt handler, module loader, ACLs) is host configuration: the
   * backend re-applies it after restore. Policy is never read from the
   * snapshot, and snapshots are trusted input only — restoring bytes a
   * sandboxed party can write is equivalent to loading its bytecode.
   */
  restore?(snapshot: SandboxSnapshot): Promise<void>;
}

export const supportsSnapshots = (
  backend: SandboxBackend,
): backend is SandboxBackend & Required<Pick<SandboxBackend, "snapshot" | "restore">> =>
  typeof backend.snapshot === "function" && typeof backend.restore === "function";
