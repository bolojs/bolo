import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";
import type { VfsBus } from "@browser-containers/vfs-bus";
import { transformScript } from "@browser-containers/wasm-registry";
import {
  SandboxPresets,
  createVfsAcl,
  type SandboxPolicy,
} from "@browser-containers/sandbox-policy";

export interface SandboxRunResult {
  result?: string;
  error?: string;
}

// The QuickJS sandbox always runs untrusted agent code, so — unlike
// `createSwGate`/`createVfsAcl`'s own `null` = "unrestricted" convention,
// meant for trusted paths — a policy is always in effect here; `null` isn't
// an accepted value. Callers that want looser limits pass `SandboxPresets.strict`
// or a merged policy (see `mergePolicy`/`KnownAgentPolicies`) explicitly.
const DEFAULT_POLICY: SandboxPolicy = SandboxPresets.moderate!;

export class SandboxPool {
  constructor(
    private vfs: VfsBus,
    private policy: SandboxPolicy = DEFAULT_POLICY,
  ) {}

  async run(code: string): Promise<SandboxRunResult> {
    const QuickJS = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.policy.memory.limitMb * 1024 * 1024);
    runtime.setMaxStackSize(1024 * 1024);

    // Rate-limits ops per rolling `intervalMs` window (reset on the first
    // interrupt check past the deadline) rather than a flat lifetime cap, so
    // a script within the policy's sustained-throughput budget isn't killed
    // just for running longer than one interval.
    const { maxOpsPerInterval, intervalMs } = this.policy.cpu;
    let ops = 0;
    let windowStart = Date.now();
    runtime.setInterruptHandler(() => {
      const now = Date.now();
      if (now - windowStart >= intervalMs) {
        windowStart = now;
        ops = 0;
      }
      ops++;
      return ops > maxOpsPerInterval;
    });

    const context = runtime.newContext();
    let disposed = false;

    const cleanup = () => {
      if (!disposed) {
        disposed = true;
        try {
          context.dispose();
        } catch {
          /* noop: lifetime may already be freed by QuickJS on error */
        }
        try {
          runtime.dispose();
        } catch {
          /* noop: lifetime may already be freed by QuickJS on error */
        }
      }
    };

    try {
      this.injectFsShim(context);
      const stripped = await this.stripTypes(code);
      // No manual "wrap in IIFE + return the last expression" step needed:
      // QuickJS implements spec completion-value semantics natively, so
      // `evalCode` already yields the value of the last executed statement
      // (threaded correctly through blocks/if/loops, per ECMA-262 anonymous
      // completion propagation), exactly like a real `eval()`.
      const evalResult = context.evalCode(stripped);

      if (evalResult.error) {
        let errMsg: string;
        try {
          const errHandle = evalResult.error;
          errMsg = context.getString(context.getProp(errHandle, "message"));
          errHandle.dispose();
        } catch {
          errMsg = "Unknown error";
        }
        cleanup();
        return { error: errMsg };
      }

      let result: string | undefined;
      if (evalResult.value) {
        const valHandle = evalResult.value;
        const typeTag = context.typeof(valHandle);
        if (typeTag === "string") {
          result = context.getString(valHandle);
        } else if (typeTag === "number") {
          result = String(context.getNumber(valHandle));
        } else if (typeTag === "boolean") {
          result = String(context.dump(valHandle));
        } else if (typeTag === "undefined") {
          result = "undefined";
        }
        valHandle.dispose();
      }

      cleanup();
      return { result };
    } catch (e) {
      cleanup();
      return { error: (e as Error).message ?? String(e) };
    }
  }

  /**
   * Gates every fs op through `createVfsAcl(this.policy)`: under `readOnly`
   * (the default), writes always throw same as before; under `allowPaths`,
   * ops outside the allow-list throw and ops inside it now genuinely reach
   * the VFS — the old shim always hard-blocked every write regardless of
   * policy, so `allowPaths` was previously unreachable dead configuration.
   */
  private injectFsShim(context: QuickJSContext): void {
    const fsHandle = context.newObject();
    const acl = createVfsAcl(this.policy);
    const guard = (operation: string, path: string): void => acl({ path, operation }, () => {});

    const readFileSync = context.newFunction("readFileSync", (pathHandle: QuickJSHandle) => {
      const path = context.getString(pathHandle);
      guard("readFile", path);
      const content = this.vfs.hot.readFileSync(path, "utf8");
      return context.newString(content as string);
    });
    context.setProp(fsHandle, "readFileSync", readFileSync);
    readFileSync.dispose();

    const writeFileSync = context.newFunction(
      "writeFileSync",
      (pathHandle: QuickJSHandle, dataHandle: QuickJSHandle) => {
        const path = context.getString(pathHandle);
        guard("writeFile", path);
        this.vfs.hot.writeFileSync(path, context.getString(dataHandle));
      },
    );
    context.setProp(fsHandle, "writeFileSync", writeFileSync);
    writeFileSync.dispose();

    const mkdirSync = context.newFunction("mkdirSync", (pathHandle: QuickJSHandle) => {
      const path = context.getString(pathHandle);
      guard("mkdir", path);
      this.vfs.hot.mkdirSync(path, { recursive: true });
    });
    context.setProp(fsHandle, "mkdirSync", mkdirSync);
    mkdirSync.dispose();

    const rmSync = context.newFunction("rmSync", (pathHandle: QuickJSHandle) => {
      const path = context.getString(pathHandle);
      guard("rm", path);
      this.vfs.hot.rmSync(path, { recursive: true, force: true });
    });
    context.setProp(fsHandle, "rmSync", rmSync);
    rmSync.dispose();

    context.setProp(context.global, "fs", fsHandle);
    fsHandle.dispose();
  }

  /**
   * Erases TypeScript syntax via the shared esbuild WASM instance (routed
   * through `@browser-containers/wasm-registry`'s real TS parser) instead of
   * the previous hand-rolled regex stripper, which used non-greedy
   * `[\s\S]*?\}` matches that broke on nested object types/interfaces.
   */
  private async stripTypes(code: string): Promise<string> {
    const { code: stripped } = await transformScript(code, { loader: "ts" });
    return stripped;
  }
}
