import { getLogger } from "@bolojs/log/browser";

const logger = getLogger(["bolo", "runtime", "diagnose"]);

export interface CheckResult {
  readonly ok: boolean;
  readonly message?: string;
}

export interface Diagnosis {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly details?: Readonly<Record<string, CheckResult>>;
  readonly checkedAt: number;
}

const hasWorker = (): boolean => typeof Worker !== "undefined";
const hasWasm = (): boolean => typeof WebAssembly !== "undefined";
const hasSW = (): boolean => typeof navigator !== "undefined" && "serviceWorker" in navigator;
const hasMessageChannel = (): boolean => typeof MessageChannel !== "undefined";
const hasBroadcast = (): boolean => typeof BroadcastChannel !== "undefined";

/** Synchronous capability checks. Cheap enough to gate UI render. */
export const diagnoseRuntime = (): Diagnosis => {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!hasWorker()) blockers.push("Web Workers unavailable");
  if (!hasWasm()) blockers.push("WebAssembly unavailable");
  if (!hasSW()) blockers.push("ServiceWorker unavailable — preview cannot be served");
  if (!hasMessageChannel()) blockers.push("MessageChannel unavailable");
  if (!hasBroadcast()) {
    warnings.push("BroadcastChannel unavailable — error relay falls back to in-page buffer");
  }

  return { ok: blockers.length === 0, blockers, warnings, checkedAt: Date.now() };
};

const checkOpfs = async (): Promise<CheckResult> => {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      return { ok: false, message: "OPFS API unavailable" };
    }
    await navigator.storage.getDirectory();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Async checks: OPFS probe only. Runs once at boot, result reported via logger.
 *
 * ponytail: WASM-tool smoke (oxc.transform on a 1-liner) was here to catch
 * the cross-origin worker failure class, but the bundling fix in
 * examples/app-builder/vite.config.ts (`noExternal` + inlineOxcTransform
 * plugin) plus the static import in packages/wasm-registry/src/bundle.ts
 * make that path guaranteed same-origin at build time. A runtime smoke adds
 * a duplicate dynamic import() literal to the runtime bundle — exactly the
 * class of literal we just spent three iterations removing. Re-add a
 * cross-package smoke check (importing the wasm-registry `_oxc` promise)
 * only when users actually hit a WASM-tool failure that's not caught by
 * the transformRequest 500 body + error hint registry.
 */
export const diagnoseRuntimeAsync = async (): Promise<Diagnosis> => {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const details: Record<string, CheckResult> = {};

  if (typeof Worker === "undefined") blockers.push("Web Workers unavailable");
  if (typeof WebAssembly === "undefined") blockers.push("WebAssembly unavailable");
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    blockers.push("ServiceWorker unavailable — preview cannot be served");
  }
  if (typeof MessageChannel === "undefined") blockers.push("MessageChannel unavailable");
  if (typeof BroadcastChannel === "undefined") {
    warnings.push("BroadcastChannel unavailable — error relay falls back to in-page buffer");
  }

  details.opfs = await checkOpfs();
  if (!details.opfs.ok) {
    warnings.push(`OPFS unavailable: ${details.opfs.message}`);
  }

  return { ok: blockers.length === 0, blockers, warnings, details, checkedAt: Date.now() };
};
