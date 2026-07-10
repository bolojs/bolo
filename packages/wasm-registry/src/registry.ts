export interface WasmToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WasmTool {
  run(args: string[], stdin?: string): Promise<WasmToolResult>;
}

export type WasmToolLoader = () => Promise<WasmTool>;

type ToolRegistry = Record<string, WasmToolLoader>;

const registry: ToolRegistry = {};
const promiseCache: Record<string, Promise<WasmTool | undefined>> = {};

export const registerWasmTool = (name: string, loader: WasmToolLoader): void => {
  registry[name] = loader;
};

export const resolveWasmTool = async (name: string): Promise<WasmTool | undefined> => {
  if (name in promiseCache) {
    return promiseCache[name];
  }

  const loader = registry[name];
  if (!loader) {
    return undefined;
  }

  promiseCache[name] = loader();
  return promiseCache[name];
};

export const createWasmRegistry = (): {
  dispatch(cmd: string, args: string[]): Promise<WasmToolResult>;
} => {
  return {
    async dispatch(cmd: string, args: string[]): Promise<WasmToolResult> {
      const tool = await resolveWasmTool(cmd);
      if (!tool) {
        return {
          stdout: "",
          stderr: `WASM tool not found: ${cmd}`,
          exitCode: 1,
        };
      }
      return tool.run(args);
    },
  };
};

export const clearCache = (): void => {
  Object.keys(promiseCache).forEach((key) => {
    delete promiseCache[key];
  });
};

export const getRegisteredToolNames = (): string[] => {
  return Object.keys(registry);
};
