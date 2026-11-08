import packageMatrix from "./package-matrix.json" with { type: "json" };
import type { CompatHarness } from "./main.js";

export interface PackageResult {
  name: string;
  class: string;
  status: "pass" | "fail" | "skip";
  error?: string;
  /** Full combined stdout+stderr of the probe (and install) — kept for passes too. */
  output?: string;
  duration?: number;
}

export interface PackageEntry {
  name: string;
  class: string;
  /** Import statement(s) prepended to a generated probe, e.g. `import _ from 'lodash'`. */
  bind?: string;
  /** Expression evaluated with `await`; must be truthy for the probe to pass. */
  probe?: string;
  /** Complete probe source; takes precedence over `bind`/`probe`. */
  source?: string;
  /** When false, no import line is generated for `probe` entries. */
  import?: boolean;
}

export interface PackageMatrix {
  version: string;
  methodology?: string;
  packages: PackageEntry[];
}

interface SpecifierParts {
  name: string;
  version?: string;
  subpath?: string;
}

const ESM_SH_URL = /https?:\/\/esm\.sh\/([^\s'"\\)]+)/g;
const IMPORT_SPECIFIER = /\b(?:from|import)\s*(?:\(\s*)?['"]([^'"\n]+)['"]/g;
const PASS_MARKER = /^PASS[ \t\r]*$/m;
const SKIP_MARKER = /\bskip\b/i;
export const DEFAULT_PACKAGE_TIMEOUT_MS = 60_000;

/** Splits `lodash@4.17.21/fp` or `@scope/name@1/sub` into name, version and subpath. */
const specifierParts = (raw: string): SpecifierParts => {
  const clean = raw.split("?")[0].split("#")[0];
  const segments = clean.split("/").filter(Boolean);
  const nameSegs = segments[0]?.startsWith("@") ? 2 : 1;
  const namePart = segments.slice(0, nameSegs).join("/");
  const subpath = segments.slice(nameSegs).join("/") || undefined;
  // A version pins onto the last name segment: `name@ver` or `@scope/name@ver`.
  const at = namePart.indexOf("@", namePart.indexOf("/") + 1);
  if (at > 0) {
    return { name: namePart.slice(0, at), version: namePart.slice(at + 1), subpath };
  }
  return { name: namePart, subpath };
};

/** esm.sh prefixes build-pinned paths with `/vNNN/` (sometimes `/stable/`); drop it. */
const stripEsmShPrefix = (path: string): string => {
  const segments = path.split("/").filter(Boolean);
  if (/^(v\d+|stable)$/.test(segments[0] ?? "")) segments.shift();
  return segments.join("/");
};

/**
 * Converts an esm.sh URL path into the bare specifier for an import statement
 * (no version) and the install spec for `npm install` (keeps any pinned version).
 */
export const esmShUrlToSpecifier = (path: string): { specifier: string; install: string } => {
  const { name, version, subpath } = specifierParts(stripEsmShPrefix(path));
  return {
    specifier: subpath ? `${name}/${subpath}` : name,
    install: version ? `${name}@${version}` : name,
  };
};

/** Rewrites every `https://esm.sh/<spec>` import in a probe source to its bare specifier. */
export const rewriteEsmImports = (source: string): string =>
  source.replace(ESM_SH_URL, (_match, path: string) => esmShUrlToSpecifier(path).specifier);

/** Maps an import specifier to an `npm install` target, or undefined when nothing is installable. */
export const bareSpecifierToInstall = (spec: string): string | undefined => {
  if (
    spec.startsWith("node:") ||
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("data:") ||
    spec.includes("://")
  ) {
    return undefined;
  }
  const { name, version } = specifierParts(spec);
  if (!name) return undefined;
  return version ? `${name}@${version}` : name;
};

/** Extracts every installable bare specifier imported by a probe source. */
export const extractInstallSpecs = (source: string): string[] => {
  const specs = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const install = bareSpecifierToInstall(match[1]);
    if (install) specs.add(install);
  }
  return [...specs];
};

const importIdentifier = (name: string): string => {
  const safe = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[a-zA-Z_$]/.test(safe) ? safe : `_${safe}`;
};

/**
 * Builds the final probe source for a matrix entry. `source` entries are used
 * verbatim except esm.sh imports are rewritten to bare specifiers; `probe`
 * entries get a generated wrapper that fails unless the expression is truthy.
 */
export const buildProbeSource = (pkg: PackageEntry): string => {
  if (pkg.source) return rewriteEsmImports(pkg.source);
  const bind =
    pkg.bind ??
    (pkg.import !== false ? `import ${importIdentifier(pkg.name)} from '${pkg.name}';` : "");
  return `${bind}
let __result;
try {
  __result = await (${pkg.probe});
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
if (!__result) {
  console.error('probe returned a falsy value');
  process.exit(1);
}
console.log('PASS');
`;
};

/**
 * A pass requires both a clean exit and the explicit PASS marker — exit 0
 * alone proved nothing under the old esm.sh matrix (falsy probes, swallowed
 * throws). A skip marker classifies a skipped probe regardless of exit code.
 */
export const classifyProbe = (exitCode: number, output: string): PackageResult["status"] => {
  if (exitCode === 0 && PASS_MARKER.test(output)) return "pass";
  if (SKIP_MARKER.test(output)) return "skip";
  return "fail";
};

export class PackageMatrixRunner {
  private matrix: PackageMatrix;
  private harness: CompatHarness;
  private readonly packageTimeoutMs: number;
  private readonly isolation: "fresh-boot" | "shared";

  constructor(
    options: {
      packageTimeoutMs?: number;
      isolation?: "fresh-boot" | "shared";
      harness?: CompatHarness;
      matrix?: PackageMatrix;
    } = {},
  ) {
    this.packageTimeoutMs = options.packageTimeoutMs ?? DEFAULT_PACKAGE_TIMEOUT_MS;
    this.isolation = options.isolation ?? "fresh-boot";
    this.matrix = options.matrix ?? (packageMatrix as PackageMatrix);
    this.harness = options.harness ?? window.__compatHarness;
  }

  async boot(): Promise<void> {
    await this.harness.boot();
  }

  async runAll(): Promise<PackageResult[]> {
    const results: PackageResult[] = [];
    for (const pkg of this.matrix.packages) {
      results.push(await this.runOne(pkg));
    }
    return results;
  }

  private async runOne(pkg: PackageEntry): Promise<PackageResult> {
    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        this.runPackage(pkg),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), this.packageTimeoutMs);
        }),
      ]);
      const duration = performance.now() - start;

      if (outcome === "timeout") {
        return {
          name: pkg.name,
          class: pkg.class,
          status: "fail",
          error: `TIMEOUT after ${this.packageTimeoutMs}ms`,
          duration,
        };
      }
      if (outcome.phase === "install") {
        return {
          name: pkg.name,
          class: pkg.class,
          status: "fail",
          error: `install failed (exit ${outcome.exitCode}): ${tail(outcome.output)}`,
          output: outcome.output,
          duration,
        };
      }
      const status = classifyProbe(outcome.exitCode, outcome.output);
      const result: PackageResult = {
        name: pkg.name,
        class: pkg.class,
        status,
        output: outcome.output,
        duration,
      };
      if (status === "fail") {
        result.error = tail(outcome.output) || "probe failed";
      }
      return result;
    } catch (err) {
      return {
        name: pkg.name,
        class: pkg.class,
        status: "fail",
        error: err instanceof Error ? err.message : String(err),
        duration: performance.now() - start,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async runPackage(
    pkg: PackageEntry,
  ): Promise<{ phase: "install" | "probe"; exitCode: number; output: string }> {
    if (this.isolation === "fresh-boot") await this.reboot();
    else if (!this.harness.ready) await this.harness.boot();

    const source = buildProbeSource(pkg);
    const specs = extractInstallSpecs(source);
    const path = `/probe/${pkg.name}.mjs`;

    if (specs.length > 0) {
      const install = await this.harness.install(specs);
      if (install.exitCode !== 0) {
        return { phase: "install", exitCode: install.exitCode, output: install.output };
      }
    }
    await this.harness.write(path, source);
    const probe = await this.harness.exec(path);
    return { phase: "probe", exitCode: probe.exitCode, output: probe.output };
  }

  private async reboot(): Promise<void> {
    // Teardown of a wedged container may itself hang; never wait on it forever.
    await Promise.race([
      this.harness.teardown().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    this.harness.ready = false;
    await this.harness.boot();
  }

  async teardown(): Promise<void> {
    await this.harness.teardown();
  }
}

const tail = (output: string): string => {
  const trimmed = output.trim();
  return trimmed.length > 500 ? `…${trimmed.slice(-500)}` : trimmed;
};
