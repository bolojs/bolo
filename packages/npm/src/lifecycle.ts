import { getLogger } from "@bolojs/log/browser";

const logger = getLogger(["bolo", "npm", "lifecycle"]);

/**
 * npm lifecycle events run for registry dependencies, in execution order.
 * `prepare` is included because publish-time builds (e.g. codegen packages)
 * rely on it; npm itself only runs it for git/local deps, so this is a
 * harmless superset.
 */
export const LIFECYCLE_EVENTS = ["preinstall", "install", "postinstall", "prepare"] as const;

export type LifecycleScriptEvent = (typeof LIFECYCLE_EVENTS)[number];

/**
 * Opt-in gate for lifecycle script execution. Lifecycle scripts are untrusted
 * code, so they never run unless explicitly enabled:
 * - `true` — run scripts for every installed package
 * - `string[]` — allowlist of package names whose scripts may run
 * - `false`/`undefined` — scripts are skipped (a warning is emitted per script)
 */
export type RunScriptsOption = boolean | string[];

export interface LifecycleScriptContext {
  /** The raw command string from the package's `scripts` block. */
  command: string;
  /** Which lifecycle event is running. */
  event: LifecycleScriptEvent;
  packageName: string;
  packageVersion: string;
  /** Absolute VFS path of the extracted package directory — the script's cwd. */
  cwd: string;
  /** Environment the script should see (npm_* vars + PATH incl. node_modules/.bin). */
  env: Record<string, string>;
  /** Time budget hint; the runner is expected to kill the process past this. */
  timeoutMs: number;
  /** Stream callbacks wired to the installer's output. */
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export interface LifecycleScriptResult {
  /** Exit code reported by the runner, or null when the run never produced one
   * (spawn failure, timeout kill, etc.). */
  exitCode: number | null;
}

/**
 * Executes one lifecycle command in a sandboxed process. `@bolojs/pm` does not
 * ship an executor itself — the container layer injects one backed by a
 * spawned `NodeProcess` worker (see `NodeProcess` in `@bolojs/runtime`), which
 * gives real exit codes, streaming stdio, and `kill()` for runaway scripts.
 */
export type LifecycleScriptRunner = (ctx: LifecycleScriptContext) => Promise<LifecycleScriptResult>;

export interface LifecycleScriptErrorInit {
  packageName: string;
  packageVersion: string;
  event: LifecycleScriptEvent;
  command: string;
  exitCode: number | null;
  cause?: unknown;
}

/**
 * A lifecycle script exited non-zero (or the runner threw). Matches npm's
 * failure semantics: a failed install script fails the install, unless the
 * package is an optional dependency or the event is `prepare` (which npm
 * never runs for registry packages) — both degrade to a warning.
 */
export class LifecycleScriptError extends Error {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly event: LifecycleScriptEvent;
  readonly command: string;
  readonly exitCode: number | null;

  constructor(init: LifecycleScriptErrorInit) {
    const code = init.exitCode === null ? "" : ` with exit code ${init.exitCode}`;
    super(
      `${init.packageName}@${init.packageVersion} ${init.event} script failed${code}: ${init.command}`,
      { cause: init.cause },
    );
    this.name = "LifecycleScriptError";
    this.packageName = init.packageName;
    this.packageVersion = init.packageVersion;
    this.event = init.event;
    this.command = init.command;
    this.exitCode = init.exitCode;
  }
}

/** A package extracted during the current install, queued for its lifecycle pass. */
export interface QueuedLifecyclePackage {
  /** Graph node key (`name@version` or lockfile depPath) — matches
   * `resolvedDependencies` values, used to order runs dependency-first. */
  depPath: string;
  name: string;
  version: string;
  /** Absolute dir the package was extracted into (its script cwd). */
  dir: string;
  optional: boolean;
  scripts: Partial<Record<LifecycleScriptEvent, string>>;
  /** The package ships `binding.gyp` — its build is native even when no
   * explicit script declares node-gyp. */
  hasBindingGyp: boolean;
  /** depName -> graph key, copied from the resolved graph node. */
  resolvedDependencies: Record<string, string>;
}

export interface CollectLifecycleResult {
  scripts: Partial<Record<LifecycleScriptEvent, string>>;
  /** True when the extracted package ships `binding.gyp`. */
  hasBindingGyp: boolean;
}

/**
 * Pick the runnable lifecycle scripts out of a package.json `scripts` block.
 * npm synthesizes `install: "node-gyp rebuild"` for packages that ship a
 * `binding.gyp` without declaring `install`/`preinstall`, so that implicit
 * script is added here — the native-build classifier then skips it with a
 * diagnostic rather than attempting a compile the browser cannot run.
 */
export const collectLifecycleScripts = (
  pkgScripts: Record<string, string> | undefined,
  hasBindingGyp: boolean,
): CollectLifecycleResult => {
  const scripts: Partial<Record<LifecycleScriptEvent, string>> = {};
  for (const event of LIFECYCLE_EVENTS) {
    const value = pkgScripts?.[event];
    if (typeof value === "string" && value.trim() !== "") {
      scripts[event] = value;
    }
  }
  if (hasBindingGyp && scripts.install === undefined && scripts.preinstall === undefined) {
    scripts.install = "node-gyp rebuild";
  }
  return { scripts, hasBindingGyp };
};

// Commands that unambiguously invoke a native toolchain. `prebuild-install`
// is deliberately absent — it downloads prebuilt binaries and can plausibly
// run under a node-capable runner, so it is not classified native.
const NATIVE_BUILD_RE = /\b(node-gyp|node-pre-gyp|cmake-js)\b/;

/**
 * Returns a human-readable reason when `command` invokes a native build
 * toolchain that cannot run in the browser, or null when it looks runnable.
 */
export const detectNativeBuild = (command: string): string | null => {
  const match = command.match(NATIVE_BUILD_RE);
  if (!match) return null;
  return `script invokes ${match[1]} — native addon builds are not supported in the browser`;
};

/**
 * Depth-first post-order over `resolvedDependencies` so a dependency's scripts
 * run before its dependents' — matching how npm/pnpm sequence lifecycle runs.
 * Cycles are tolerated (the in-progress node is skipped). Only packages that
 * were actually extracted this install are in `queue`; deps already on disk
 * are not re-run, matching npm's no-rerun-on-existing-node_modules behavior.
 */
export const orderLifecycleQueue = (
  queue: readonly QueuedLifecyclePackage[],
): QueuedLifecyclePackage[] => {
  const byDepPath = new Map(queue.map((q) => [q.depPath, q]));
  const ordered: QueuedLifecyclePackage[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (entry: QueuedLifecyclePackage): void => {
    if (done.has(entry.depPath) || visiting.has(entry.depPath)) return;
    visiting.add(entry.depPath);
    for (const childKey of Object.values(entry.resolvedDependencies)) {
      const child = byDepPath.get(childKey);
      if (child) visit(child);
    }
    visiting.delete(entry.depPath);
    done.add(entry.depPath);
    ordered.push(entry);
  };

  for (const entry of queue) visit(entry);
  return ordered;
};

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export interface LifecycleEnvSpec {
  event: LifecycleScriptEvent;
  command: string;
  packageName: string;
  packageVersion: string;
  /** Absolute path of the package's extracted dir. */
  packageDir: string;
  /** Absolute path of the package's package.json. */
  packageJsonPath: string;
  /** The `node_modules` dir holding this package's dep `.bin` links — for the
   * virtual store that's `<store>/<name>@<ver>/node_modules`. */
  storeNodeModulesDir: string;
  /** Project root the install targets. */
  projectCwd: string;
}

/**
 * Build the npm-style environment a lifecycle script sees: the npm_*
 * introspection vars plus a PATH whose first entries are the package's
 * `node_modules/.bin` (dep bins, linked by the virtual store) and the project
 * root `.bin` — mirroring how npm prepends every ancestor .bin dir.
 */
export const buildLifecycleEnv = (spec: LifecycleEnvSpec): Record<string, string> => ({
  npm_lifecycle_event: spec.event,
  npm_lifecycle_script: spec.command,
  npm_package_name: spec.packageName,
  npm_package_version: spec.packageVersion,
  npm_package_json: spec.packageJsonPath,
  npm_node_execpath: "node",
  INIT_CWD: spec.projectCwd,
  PATH: `${spec.storeNodeModulesDir}/.bin:${spec.projectCwd}/node_modules/.bin:${DEFAULT_PATH}`,
});

export interface RunLifecycleScriptsOptions {
  queue: readonly QueuedLifecyclePackage[];
  allow: RunScriptsOption;
  runner?: LifecycleScriptRunner;
  timeoutMs: number;
  projectCwd: string;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  onWarn: (message: string) => void;
}

/**
 * Run the queued lifecycle scripts: each package in dependency-first order,
 * each event in `preinstall → install → postinstall → prepare` order. A
 * non-zero exit throws `LifecycleScriptError` (npm semantics — the install
 * fails), except for optional dependencies and `prepare` (npm never runs it
 * for registry packages), which downgrade to warnings.
 * Native-build commands and unlisted packages are skipped with diagnostics.
 */
export const runLifecycleScripts = async (options: RunLifecycleScriptsOptions): Promise<void> => {
  const { queue, allow, runner, timeoutMs, projectCwd, stdout, stderr, onWarn } = options;
  if (queue.length === 0) return;

  const enabled = allow === true || (Array.isArray(allow) && allow.length > 0);
  if (!enabled || !runner) {
    const reason = !enabled
      ? "scripts are disabled — set runScripts to opt in"
      : "no scriptRunner configured";
    for (const entry of queue) {
      for (const event of LIFECYCLE_EVENTS) {
        if (entry.scripts[event]) {
          onWarn(`${entry.name}: skipping "${event}" lifecycle script (${reason})`);
        }
      }
    }
    return;
  }

  const allowlist = Array.isArray(allow) ? new Set(allow) : null;

  for (const entry of orderLifecycleQueue(queue)) {
    if (allowlist && !allowlist.has(entry.name)) {
      logger.info("lifecycle scripts skipped — package not in runScripts allowlist", {
        package: entry.name,
        version: entry.version,
      });
      continue;
    }

    for (const event of LIFECYCLE_EVENTS) {
      const command = entry.scripts[event];
      if (!command) continue;

      const nativeReason = detectNativeBuild(command);
      if (nativeReason) {
        logger.warn("skipping native lifecycle script", {
          package: entry.name,
          version: entry.version,
          event,
          command,
          bindingGyp: entry.hasBindingGyp,
        });
        onWarn(`${entry.name}: skipping "${event}" lifecycle script — ${nativeReason}`);
        continue;
      }

      // dir is `<store>/node_modules/<name>`; strip `/<name>` to reach the
      // store-level node_modules whose .bin holds this package's dep bins.
      const storeNodeModulesDir = entry.dir.slice(0, entry.dir.length - entry.name.length - 1);
      const env = buildLifecycleEnv({
        event,
        command,
        packageName: entry.name,
        packageVersion: entry.version,
        packageDir: entry.dir,
        packageJsonPath: `${entry.dir}/package.json`,
        storeNodeModulesDir,
        projectCwd,
      });

      stdout(`\n> ${entry.name}@${entry.version} ${event}\n> ${command}\n\n`);
      logger.info("running lifecycle script", {
        package: entry.name,
        version: entry.version,
        event,
        command,
        cwd: entry.dir,
      });

      let result: LifecycleScriptResult;
      let thrown: unknown;
      try {
        result = await runner({
          command,
          event,
          packageName: entry.name,
          packageVersion: entry.version,
          cwd: entry.dir,
          env,
          timeoutMs,
          stdout,
          stderr,
        });
      } catch (error) {
        result = { exitCode: null };
        thrown = error;
      }

      if (result.exitCode !== 0) {
        logger.error("lifecycle script failed", {
          package: entry.name,
          version: entry.version,
          event,
          command,
          exitCode: result.exitCode,
          error: thrown instanceof Error ? thrown.message : thrown,
        });
        const error = new LifecycleScriptError({
          packageName: entry.name,
          packageVersion: entry.version,
          event,
          command,
          exitCode: result.exitCode,
          cause: thrown,
        });
        // npm tolerates a failed script on an optional dependency — the
        // package itself was already tolerated as skippable at resolve time.
        if (entry.optional) {
          onWarn(`${error.message}; continuing (optional dependency)`);
          continue;
        }
        // `prepare` is a superset here — npm only runs it for git/local deps,
        // never for the registry packages this queue contains. Failing the
        // whole install on it would break packages npm installs fine.
        if (event === "prepare") {
          onWarn(`${error.message}; continuing (prepare is not run by npm for registry packages)`);
          continue;
        }
        throw error;
      }

      logger.info("lifecycle script finished", {
        package: entry.name,
        version: entry.version,
        event,
        exitCode: result.exitCode,
      });
    }
  }
};
