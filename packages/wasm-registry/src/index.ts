import {
  registerWasmTool,
  resolveWasmTool,
  createWasmRegistry,
  clearCache,
  getRegisteredToolNames,
  type WasmTool,
  type WasmToolResult,
  type WasmToolLoader,
} from "./registry";

// esbuild-wasm allows exactly one `initialize()` per realm — shared so both
// the `esbuild` tool below and the VFS-backed bundler can lazily init once.
let esbuildInitPromise: Promise<typeof import("esbuild-wasm")> | undefined;

export const initEsbuild = async (): Promise<typeof import("esbuild-wasm")> => {
  if (!esbuildInitPromise) {
    esbuildInitPromise = (async () => {
      const esbuild = await import("esbuild-wasm");
      try {
        const { createRequire } = await import("node:module");
        const { resolve } = await import("node:path");
        const require = createRequire(import.meta.url);
        const wasmURL = resolve(require.resolve("esbuild-wasm/package.json"), "../esbuild.wasm");
        await esbuild.initialize({ wasmURL });
      } catch (err: unknown) {
        const isNodeEnv = err instanceof Error && err.message.includes("only works in the browser");
        if (!isNodeEnv) {
          await esbuild.initialize({
            wasmURL: new URL("esbuild-wasm/esbuild.wasm", import.meta.url).href,
          });
        }
      }
      return esbuild;
    })();
  }
  return esbuildInitPromise;
};

registerWasmTool("esbuild", async (): Promise<WasmTool> => {
  const esbuild = await initEsbuild();
  return {
    async run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      try {
        const isFilePath = (arg: string) =>
          /^[\.\/]/.test(arg) || /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(arg);
        const hasFileInput = args.some((arg) => isFilePath(arg));

        if (hasFileInput) {
          const result = await esbuild.build({
            entryPoints: [args[0]],
            bundle: true,
            write: false,
          });
          return {
            stdout: result.outputFiles.map((f) => f.text).join("\n"),
            stderr: "",
            exitCode: 0,
          };
        } else {
          const { code } = await esbuild.transform(args[0], {
            loader: args[0].includes(":") ? "ts" : "js",
            minify: true,
          });
          return {
            stdout: code,
            stderr: "",
            exitCode: 0,
          };
        }
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }
    },
  };
});

registerWasmTool("tsc", async (): Promise<WasmTool> => {
  const ts = await import("typescript");
  return {
    async run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      try {
        const source = args[0];
        if (!source) {
          return {
            stdout: "",
            stderr: "No source file provided",
            exitCode: 1,
          };
        }

        const result = ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        });

        return {
          stdout: result.outputText,
          stderr: result.diagnostics?.map((d) => d.messageText).join("\n") ?? "",
          exitCode: 0,
        };
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }
    },
  };
});

registerWasmTool("sass", async (): Promise<WasmTool> => {
  const sass = await import("sass");
  return {
    async run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      try {
        const source = args[0];
        if (!source) {
          return {
            stdout: "",
            stderr: "No source file provided",
            exitCode: 1,
          };
        }

        const result = sass.compileString(source, {
          syntax: args.includes("--scss") ? "scss" : "indented",
          style: args.includes("--compressed") ? "compressed" : "expanded",
        });

        return {
          stdout: result.css,
          stderr: result.loadedUrls?.map((u) => u.toString()).join("\n") ?? "",
          exitCode: 0,
        };
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }
    },
  };
});

registerWasmTool("swc", async (): Promise<WasmTool> => {
  const swc = await import("@swc/wasm-web");
  try {
    const { readFileSync } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const { resolve } = await import("node:path");
    const require = createRequire(import.meta.url);
    const wasmPath = resolve(require.resolve("@swc/wasm-web/package.json"), "../wasm_bg.wasm");
    swc.initSync({ module: readFileSync(wasmPath) });
  } catch {
    await swc.default();
  }
  return {
    async run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      try {
        const source = args[0];
        if (!source) {
          return {
            stdout: "",
            stderr: "No source file provided",
            exitCode: 1,
          };
        }

        const result = swc.transformSync(source, {
          jsc: {
            target: "es2022",
            parser: {
              syntax: "typescript",
            },
          },
          module: {
            type: "es6",
          },
        });

        return {
          stdout: result.code,
          stderr: "",
          exitCode: 0,
        };
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }
    },
  };
});

export {
  registerWasmTool,
  resolveWasmTool,
  createWasmRegistry,
  clearCache,
  getRegisteredToolNames,
};
export type { WasmTool, WasmToolResult, WasmToolLoader };
export { createWasiTool } from "./wasi-executor.js";
export type { WasiToolOptions, WasiPreopen } from "./wasi-executor.js";
export { bundleEntry, transformScript } from "./bundle.js";
export type {
  BundleEntryOptions,
  BundleEntryResult,
  TransformScriptOptions,
  TransformScriptResult,
} from "./bundle.js";
