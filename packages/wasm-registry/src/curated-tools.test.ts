import { describe, it, expect, vi, beforeEach } from "vitest";
import { VfsBus } from "@bolojs/fs";
import {
  registerCuratedWasmTools,
  createCuratedWasmRegistry,
  clearCache,
  getRegisteredToolNames,
  resolveWasmTool,
} from "./index.js";

const writeFile = (vfs: VfsBus, path: string, contents: string): void => {
  const hot = vfs.hot as unknown as {
    mkdirSync: (p: string, o?: unknown) => void;
    writeFileSync: (p: string, c: string) => void;
  };
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir !== "/") hot.mkdirSync(dir, { recursive: true });
  hot.writeFileSync(path, contents);
};

const fakeEsbuild = () => ({
  version: "0.0.0-test",
  initialize: vi.fn(async () => {}),
  transform: vi.fn(async (input: string, opts?: { loader?: string }) => ({
    code: `OUT[${opts?.loader ?? "?"}]:${input}`,
  })),
});

const fakeSwc = () => ({
  transform: vi.fn(async (input: string, opts?: { jsc?: { parser?: { syntax?: string } } }) => ({
    code: `SWC[${opts?.jsc?.parser?.syntax ?? "?"}]:${input}`,
  })),
});

const stubBinary = async () => new Uint8Array([0, 97, 115, 109]);

const makeOptions = (vfs: VfsBus, esbuild = fakeEsbuild(), swc = fakeSwc()) => ({
  vfs,
  loadWasmBinary: stubBinary,
  loadModule: vi.fn(async (specifier: string) => {
    if (specifier.startsWith("esbuild-wasm")) return esbuild;
    if (specifier.startsWith("@swc/wasm-web")) return swc;
    throw new Error(`unexpected specifier ${specifier}`);
  }),
});

describe("curated wasm tools", () => {
  beforeEach(() => {
    clearCache();
  });

  it("registers esbuild and swc into the realm registry", () => {
    const vfs = new VfsBus();
    registerCuratedWasmTools(makeOptions(vfs));
    expect(getRegisteredToolNames()).toEqual(expect.arrayContaining(["esbuild", "swc"]));
  });

  it("createCuratedWasmRegistry registers then returns a dispatching registry", async () => {
    const vfs = new VfsBus();
    const registry = createCuratedWasmRegistry(makeOptions(vfs));
    const result = await registry.dispatch("esbuild", ["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("0.20.2");
  });

  it("dispatches unknown commands with the WASM-tool-not-found contract", async () => {
    const vfs = new VfsBus();
    const registry = createCuratedWasmRegistry(makeOptions(vfs));
    const result = await registry.dispatch("definitely-not-a-tool", []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("WASM tool not found: definitely-not-a-tool");
  });

  it("esbuild transforms a .ts file from the VFS to stdout", async () => {
    const vfs = new VfsBus();
    writeFile(vfs, "/app/main.ts", "const x: number = 1;");
    const esbuild = fakeEsbuild();
    const registry = createCuratedWasmRegistry(makeOptions(vfs, esbuild, fakeSwc()));

    const result = await registry.dispatch("esbuild", ["/app/main.ts"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OUT[ts]:const x: number = 1;");
    expect(esbuild.transform).toHaveBeenCalledWith(
      "const x: number = 1;",
      expect.objectContaining({ loader: "ts", sourcefile: "/app/main.ts" }),
    );
  });

  it("esbuild reads stdin with an explicit loader", async () => {
    const vfs = new VfsBus();
    const esbuild = fakeEsbuild();
    const registry = createCuratedWasmRegistry(makeOptions(vfs, esbuild, fakeSwc()));

    const tool = await resolveWasmTool("esbuild");
    const result = await tool!.run(["--loader=ts"], "let y: string = 'a';");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OUT[ts]:let y: string = 'a';");
  });

  it("esbuild writes transform output to --outfile in the VFS", async () => {
    const vfs = new VfsBus();
    writeFile(vfs, "/app/main.ts", "const x = 1;");
    const registry = createCuratedWasmRegistry(makeOptions(vfs));

    const result = await registry.dispatch("esbuild", ["/app/main.ts", "-o", "/out/bundle.js"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const hot = vfs.hot as unknown as { readFileSync: (p: string, e: string) => string };
    expect(hot.readFileSync("/out/bundle.js", "utf8")).toBe("OUT[ts]:const x = 1;");
  });

  it("esbuild rejects unsupported flags explicitly", async () => {
    const vfs = new VfsBus();
    writeFile(vfs, "/app/main.ts", "const x = 1;");
    const registry = createCuratedWasmRegistry(makeOptions(vfs));

    const result = await registry.dispatch("esbuild", ["/app/main.ts", "--bundle"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--bundle");
    expect(result.stderr).toContain("not supported");
  });

  it("esbuild surfaces transform errors as exit 1", async () => {
    const vfs = new VfsBus();
    const esbuild = fakeEsbuild();
    esbuild.transform.mockRejectedValue(new Error("bad syntax"));
    const registry = createCuratedWasmRegistry(makeOptions(vfs, esbuild, fakeSwc()));

    const result = await registry.dispatch("esbuild", ["--loader=ts"], "const = ;");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bad syntax");
  });

  it("swc transforms a .tsx file with the typescript+tsx parser", async () => {
    const vfs = new VfsBus();
    writeFile(vfs, "/app/widget.tsx", "export const C = () => <div/>;");
    const swc = fakeSwc();
    const registry = createCuratedWasmRegistry(makeOptions(vfs, fakeEsbuild(), swc));

    const result = await registry.dispatch("swc", ["/app/widget.tsx"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SWC[typescript]:export const C = () => <div/>;");
    expect(swc.transform).toHaveBeenCalledWith(
      "export const C = () => <div/>;",
      expect.objectContaining({
        jsc: expect.objectContaining({
          parser: expect.objectContaining({ syntax: "typescript", tsx: true }),
        }),
      }),
    );
  });

  it("swc rejects unsupported flags explicitly", async () => {
    const vfs = new VfsBus();
    const registry = createCuratedWasmRegistry(makeOptions(vfs));
    const result = await registry.dispatch("swc", ["--bundle", "/app/a.ts"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--bundle");
  });
});
