import { describe, it, expect } from "vitest";
import {
  LifecycleScriptError,
  buildLifecycleEnv,
  collectLifecycleScripts,
  detectNativeBuild,
  orderLifecycleQueue,
  runLifecycleScripts,
} from "./lifecycle.js";
import type {
  LifecycleScriptContext,
  LifecycleScriptResult,
  QueuedLifecyclePackage,
} from "./lifecycle.js";

const makeQueued = (overrides: Partial<QueuedLifecyclePackage> = {}): QueuedLifecyclePackage => ({
  depPath: "pkg@1.0.0",
  name: "pkg",
  version: "1.0.0",
  dir: "/app/node_modules/.bolo/pkg@1.0.0/node_modules/pkg",
  optional: false,
  scripts: {},
  hasBindingGyp: false,
  resolvedDependencies: {},
  ...overrides,
});

const makeRunOptions = (overrides: Partial<Parameters<typeof runLifecycleScripts>[0]> = {}) => ({
  queue: [] as QueuedLifecyclePackage[],
  allow: true as const,
  timeoutMs: 1000,
  projectCwd: "/app",
  stdout: () => {},
  stderr: () => {},
  onWarn: () => {},
  ...overrides,
});

describe("collectLifecycleScripts", () => {
  it("keeps only runnable lifecycle events, in order", () => {
    const { scripts } = collectLifecycleScripts(
      {
        preinstall: "a",
        install: "b",
        postinstall: "c",
        prepare: "d",
        test: "ignored",
        prepublishOnly: "ignored",
        "": "ignored-name",
      },
      false,
    );
    expect(scripts).toEqual({
      preinstall: "a",
      install: "b",
      postinstall: "c",
      prepare: "d",
    });
  });

  it("drops blank script strings", () => {
    const { scripts } = collectLifecycleScripts({ postinstall: "   " }, false);
    expect(scripts.postinstall).toBeUndefined();
  });

  it("synthesizes node-gyp rebuild when binding.gyp ships without install scripts", () => {
    const { scripts, hasBindingGyp } = collectLifecycleScripts(undefined, true);
    expect(hasBindingGyp).toBe(true);
    expect(scripts.install).toBe("node-gyp rebuild");
  });

  it("does not synthesize node-gyp when install or preinstall is declared", () => {
    expect(collectLifecycleScripts({ install: "make js" }, true).scripts.install).toBe("make js");
    expect(
      collectLifecycleScripts({ preinstall: "echo hi" }, true).scripts.install,
    ).toBeUndefined();
  });
});

describe("detectNativeBuild", () => {
  it("flags node-gyp, node-pre-gyp, and cmake-js invocations", () => {
    expect(detectNativeBuild("node-gyp rebuild")).toContain("node-gyp");
    expect(detectNativeBuild("node-pre-gyp install --fallback-to-build")).toContain("node-pre-gyp");
    expect(detectNativeBuild("cmake-js compile")).toContain("cmake-js");
  });

  it("treats prebuild-install and plain node scripts as runnable", () => {
    expect(detectNativeBuild("prebuild-install || node-gyp rebuild")).toContain("node-gyp");
    expect(detectNativeBuild("prebuild-install -r napi")).toBeNull();
    expect(detectNativeBuild("node scripts/postinstall.js")).toBeNull();
    expect(detectNativeBuild("tsc -p .")).toBeNull();
  });
});

describe("orderLifecycleQueue", () => {
  it("runs a dependency's scripts before its dependents'", () => {
    const dep = makeQueued({ depPath: "dep@1.0.0", name: "dep" });
    const root = makeQueued({
      depPath: "root@1.0.0",
      name: "root",
      resolvedDependencies: { dep: "dep@1.0.0" },
    });
    const ordered = orderLifecycleQueue([root, dep]);
    expect(ordered.map((q) => q.name)).toEqual(["dep", "root"]);
  });

  it("tolerates dependency cycles", () => {
    const a = makeQueued({ depPath: "a@1.0.0", name: "a", resolvedDependencies: { b: "b@1.0.0" } });
    const b = makeQueued({ depPath: "b@1.0.0", name: "b", resolvedDependencies: { a: "a@1.0.0" } });
    const ordered = orderLifecycleQueue([a, b]);
    expect(ordered).toHaveLength(2);
  });

  it("ignores edges to packages not in the queue", () => {
    const pkg = makeQueued({ resolvedDependencies: { missing: "missing@1.0.0" } });
    expect(orderLifecycleQueue([pkg]).map((q) => q.name)).toEqual(["pkg"]);
  });
});

describe("buildLifecycleEnv", () => {
  it("sets npm_* introspection vars and .bin-prefixed PATH", () => {
    const env = buildLifecycleEnv({
      event: "postinstall",
      command: "node build.js",
      packageName: "esbuild",
      packageVersion: "0.20.0",
      packageDir: "/app/node_modules/.bolo/esbuild@0.20.0/node_modules/esbuild",
      packageJsonPath: "/app/node_modules/.bolo/esbuild@0.20.0/node_modules/esbuild/package.json",
      storeNodeModulesDir: "/app/node_modules/.bolo/esbuild@0.20.0/node_modules",
      projectCwd: "/app",
    });
    expect(env.npm_lifecycle_event).toBe("postinstall");
    expect(env.npm_lifecycle_script).toBe("node build.js");
    expect(env.npm_package_name).toBe("esbuild");
    expect(env.npm_package_version).toBe("0.20.0");
    expect(env.npm_package_json).toContain("esbuild/package.json");
    expect(env.INIT_CWD).toBe("/app");
    expect(env.PATH?.startsWith("/app/node_modules/.bolo/esbuild@0.20.0/node_modules/.bin:")).toBe(
      true,
    );
    expect(env.PATH).toContain("/app/node_modules/.bin");
  });
});

describe("runLifecycleScripts", () => {
  it("warns per script and never invokes the runner when scripts are disabled", async () => {
    const warnings: string[] = [];
    let ran = 0;
    await runLifecycleScripts(
      makeRunOptions({
        allow: false,
        queue: [makeQueued({ scripts: { install: "x", postinstall: "y" } })],
        runner: async () => {
          ran++;
          return { exitCode: 0 };
        },
        onWarn: (m) => warnings.push(m),
      }),
    );
    expect(ran).toBe(0);
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.includes("disabled"))).toBe(true);
  });

  it("warns when opted in but no runner is configured", async () => {
    const warnings: string[] = [];
    await runLifecycleScripts(
      makeRunOptions({
        queue: [makeQueued({ scripts: { postinstall: "y" } })],
        onWarn: (m) => warnings.push(m),
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no scriptRunner configured");
  });

  it("passes command, package dir cwd, npm env, and timeout to the runner", async () => {
    const contexts: LifecycleScriptContext[] = [];
    await runLifecycleScripts(
      makeRunOptions({
        queue: [
          makeQueued({
            name: "@scope/pkg",
            depPath: "@scope/pkg@2.0.0",
            version: "2.0.0",
            dir: "/app/node_modules/.bolo/@scope/pkg@2.0.0/node_modules/@scope/pkg",
            scripts: { postinstall: "node build.js" },
          }),
        ],
        runner: async (ctx) => {
          contexts.push(ctx);
          return { exitCode: 0 };
        },
        timeoutMs: 5000,
      }),
    );
    expect(contexts).toHaveLength(1);
    const ctx = contexts[0]!;
    expect(ctx.command).toBe("node build.js");
    expect(ctx.event).toBe("postinstall");
    expect(ctx.cwd).toBe("/app/node_modules/.bolo/@scope/pkg@2.0.0/node_modules/@scope/pkg");
    expect(ctx.env.npm_lifecycle_event).toBe("postinstall");
    expect(ctx.env.npm_package_name).toBe("@scope/pkg");
    // Scoped name: store .bin dir is the node_modules containing @scope/.
    expect(
      ctx.env.PATH?.startsWith("/app/node_modules/.bolo/@scope/pkg@2.0.0/node_modules/.bin:"),
    ).toBe(true);
    expect(ctx.timeoutMs).toBe(5000);
  });

  it("runs events in preinstall → install → postinstall → prepare order", async () => {
    const events: string[] = [];
    await runLifecycleScripts(
      makeRunOptions({
        queue: [
          makeQueued({
            scripts: { prepare: "d", postinstall: "c", install: "b", preinstall: "a" },
          }),
        ],
        runner: async (ctx) => {
          events.push(ctx.event);
          return { exitCode: 0 };
        },
      }),
    );
    expect(events).toEqual(["preinstall", "install", "postinstall", "prepare"]);
  });

  it("runs dependencies' scripts before dependents'", async () => {
    const ran: string[] = [];
    const dep = makeQueued({
      depPath: "dep@1.0.0",
      name: "dep",
      scripts: { postinstall: "d" },
    });
    const root = makeQueued({
      depPath: "root@1.0.0",
      name: "root",
      scripts: { postinstall: "r" },
      resolvedDependencies: { dep: "dep@1.0.0" },
    });
    await runLifecycleScripts(
      makeRunOptions({
        queue: [root, dep],
        runner: async (ctx) => {
          ran.push(ctx.packageName);
          return { exitCode: 0 };
        },
      }),
    );
    expect(ran).toEqual(["dep", "root"]);
  });

  it("runs only allowlisted packages when runScripts is a name list", async () => {
    const ran: string[] = [];
    const yes = makeQueued({ depPath: "yes@1.0.0", name: "yes", scripts: { install: "y" } });
    const no = makeQueued({ depPath: "no@1.0.0", name: "no", scripts: { install: "n" } });
    await runLifecycleScripts(
      makeRunOptions({
        allow: ["yes"],
        queue: [yes, no],
        runner: async (ctx) => {
          ran.push(ctx.packageName);
          return { exitCode: 0 };
        },
      }),
    );
    expect(ran).toEqual(["yes"]);
  });

  it("throws LifecycleScriptError with the exit code on non-zero exit", async () => {
    const err = await runLifecycleScripts(
      makeRunOptions({
        queue: [makeQueued({ scripts: { postinstall: "boom" } })],
        runner: async (): Promise<LifecycleScriptResult> => ({ exitCode: 7 }),
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LifecycleScriptError);
    const le = err as LifecycleScriptError;
    expect(le.event).toBe("postinstall");
    expect(le.command).toBe("boom");
    expect(le.exitCode).toBe(7);
    expect(le.message).toContain("pkg@1.0.0");
    expect(le.message).toContain("exit code 7");
  });

  it("treats a throwing runner as exit-code-null failure", async () => {
    const err = await runLifecycleScripts(
      makeRunOptions({
        queue: [makeQueued({ scripts: { install: "boom" } })],
        runner: async () => {
          throw new Error("spawn failed");
        },
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LifecycleScriptError);
    expect((err as LifecycleScriptError).exitCode).toBeNull();
  });

  it("warns instead of throwing for optional dependencies", async () => {
    const warnings: string[] = [];
    let ran = 0;
    await runLifecycleScripts(
      makeRunOptions({
        queue: [
          makeQueued({ optional: true, scripts: { postinstall: "boom" } }),
          makeQueued({ depPath: "next@1.0.0", name: "next", scripts: { postinstall: "ok" } }),
        ],
        runner: async (ctx) => {
          ran++;
          return { exitCode: ctx.packageName === "pkg" ? 1 : 0 };
        },
        onWarn: (m) => warnings.push(m),
      }),
    );
    expect(ran).toBe(2);
    expect(warnings.some((w) => w.includes("optional dependency"))).toBe(true);
  });

  it("warns instead of throwing on a failed prepare script", async () => {
    const warnings: string[] = [];
    await runLifecycleScripts(
      makeRunOptions({
        queue: [makeQueued({ scripts: { prepare: "boom" } })],
        runner: async () => ({ exitCode: 2 }),
        onWarn: (m) => warnings.push(m),
      }),
    );
    expect(warnings.some((w) => w.includes("prepare"))).toBe(true);
  });

  it("skips native-build commands with a diagnostic, never invoking the runner", async () => {
    const warnings: string[] = [];
    let ran = 0;
    await runLifecycleScripts(
      makeRunOptions({
        queue: [
          makeQueued({
            scripts: { install: "node-gyp rebuild", postinstall: "node ok.js" },
            hasBindingGyp: true,
          }),
        ],
        runner: async () => {
          ran++;
          return { exitCode: 0 };
        },
        onWarn: (m) => warnings.push(m),
      }),
    );
    expect(ran).toBe(1);
    expect(warnings.some((w) => w.includes("node-gyp"))).toBe(true);
  });
});
