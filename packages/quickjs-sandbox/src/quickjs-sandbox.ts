import type { SandboxBackend, SandboxRunResult } from "@browser-containers/runtime";
import type { VfsBus } from "@browser-containers/vfs-bus";
import type { SandboxPolicy } from "@browser-containers/sandbox-policy";
import { SandboxPool } from "./sandbox-pool.js";

/**
 * QuickJS-based sandbox backend providing memory/CPU caps and per-path VFS ACLs.
 * Install `@browser-containers/quickjs-sandbox` and pass an instance to `boot()`:
 *
 *   import { boot } from '@browser-containers/runtime';
 *   import { QuickJSSandbox } from '@browser-containers/quickjs-sandbox';
 *
 *   const container = await boot({
 *     sandbox: new QuickJSSandbox(vfs, { memory: { limitMb: 128 } }),
 *   });
 */
export class QuickJSSandbox implements SandboxBackend {
  private pool: SandboxPool;

  constructor(vfs: VfsBus, policy?: Partial<SandboxPolicy>) {
    this.pool = new SandboxPool(vfs, policy as any);
  }

  async run(code: string): Promise<SandboxRunResult> {
    return this.pool.run(code);
  }

  dispose(): void {
    // SandboxPool.run() is stateless (creates + disposes QuickJS instance per call)
    // so no explicit disposal needed
  }
}
