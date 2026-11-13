import packageMatrix from "./package-matrix.json" with { type: "json" };
import packageExpectations from "./package-expectations.json" with { type: "json" };
import type { CompatHarness } from "./main.js";
import { classifyPackageProbe } from "./classify.js";

/**
 * Structured native/WASM classification for packages that cannot run
 * as-is in the browser (src/package-expectations.json):
 * - lane A: expected to work; a failure is an interop bug to fix.
 * - lane B: needs the WASM loader tracked in #149 (or a WASM alternative).
 * - lane C: unsupported native lane; no browser/WASM story exists.
 */
export interface PackageExpectation {
  lane: "A" | "B" | "C";
  reason: string;
  remediation: string;
}

const EXPECTATIONS = packageExpectations as unknown as Record<string, PackageExpectation>;

export interface PackageResult {
  name: string;
  class: string;
  status: "pass" | "fail" | "skip";
  error?: string;
  /** Full combined stdout+stderr of the probe (and install) — kept for passes too. */
  output?: string;
  duration?: number;
  /** Native/WASM lane classification, when the package has one. */
  expectation?: PackageExpectation;
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
  /** Per-package probe deadline override (ms) — packages whose honest bundling
   * + eval budget exceeds the global 60s default (e.g. webpack's WASM bundle). */
  timeoutMs?: number;
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

export const classifyProbe = classifyPackageProbe;

export class PackageMatrixRunner {
  private matrix: PackageMatrix;
  private harness: CompatHarness;
  private readonly packageTimeoutMs: number;
  private readonly isolation: "fresh-boot" | "shared";
  private readonly onResult: ((result: PackageResult) => void) | undefined;
  private readonly onPackageStart: ((name: string, timeoutMs: number) => void) | undefined;
  private readonly skip: Set<string>;

  constructor(
    options: {
      packageTimeoutMs?: number;
      isolation?: "fresh-boot" | "shared";
      harness?: CompatHarness;
      matrix?: PackageMatrix;
      /** Called after every finished package, so the caller can persist progress incrementally. */
      onResult?: (result: PackageResult) => void;
      /** Called just before a package starts, so the caller can track liveness.
       * `timeoutMs` is the effective per-package deadline (entry override or the
       * runner default) so watchdogs don't kill long-but-honest packages early. */
      onPackageStart?: (name: string, timeoutMs: number) => void;
      /** Package names to skip: already completed by an earlier (killed) run. */
      skip?: Iterable<string>;
    } = {},
  ) {
    this.packageTimeoutMs = options.packageTimeoutMs ?? DEFAULT_PACKAGE_TIMEOUT_MS;
    this.isolation = options.isolation ?? "fresh-boot";
    this.matrix = options.matrix ?? (packageMatrix as PackageMatrix);
    this.harness = options.harness ?? window.__compatHarness;
    this.onResult = options.onResult;
    this.onPackageStart = options.onPackageStart;
    this.skip = new Set(options.skip ?? []);
  }

  async boot(): Promise<void> {
    await this.harness.boot();
  }

  async runAll(): Promise<PackageResult[]> {
    const results: PackageResult[] = [];
    for (const pkg of this.matrix.packages) {
      if (this.skip.has(pkg.name)) continue;
      this.onPackageStart?.(pkg.name, pkg.timeoutMs ?? this.packageTimeoutMs);
      const result = await this.runOne(pkg);
      const expectation = EXPECTATIONS[pkg.name];
      if (expectation) result.expectation = expectation;
      results.push(result);
      this.onResult?.(result);
    }
    return results;
  }

  private async runOne(pkg: PackageEntry): Promise<PackageResult> {
    const start = performance.now();
    const timeoutMs = pkg.timeoutMs ?? this.packageTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        this.runPackage(pkg),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
      const duration = performance.now() - start;

      if (outcome === "timeout") {
        return {
          name: pkg.name,
          class: pkg.class,
          status: "fail",
          error: `TIMEOUT after ${timeoutMs}ms`,
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

const MAX_ERROR_LENGTH = 500;
const MAX_LINE_LENGTH = 300;

// Uncaught crashes in the container print `at data:text/javascript,<encoded
// bundle>:line:col` frames — a single multi-KB line that pushes the real
// error out of a plain tail window (this is why site knownIssues used to show
// URL-encoded probe sources). Elide overlong lines first, then keep both ends
// of what remains: Node puts `ErrorName: message` at the head and
// `Node.js vX` / assertion detail at the tail.
const elideLine = (line: string): string =>
  line.length > MAX_LINE_LENGTH
    ? `${line.slice(0, 120)}… <${line.length - 120} chars elided>`
    : line;

export const tail = (output: string): string => {
  const cleaned = output.trim().split("\n").map(elideLine).join("\n");
  if (cleaned.length <= MAX_ERROR_LENGTH) return cleaned;
  const half = Math.floor((MAX_ERROR_LENGTH - 20) / 2);
  return `${cleaned.slice(0, half)}\n…\n${cleaned.slice(-half)}`;
};
