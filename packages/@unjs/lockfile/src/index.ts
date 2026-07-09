import { detectFormat } from "./adapters/index.js";
import { parseBunBinary } from "./adapters/bun-binary.js";
import { parseBunText } from "./adapters/bun-text.js";
import { parseNpm } from "./adapters/npm.js";
import { parsePnpm } from "./adapters/pnpm.js";
import { parseYarn } from "./adapters/yarn.js";
import { parseYarnBerry } from "./adapters/yarn-berry.js";
import type { Format, LockfileGraph } from "./graph.js";
export type * from "./graph.js";
export { resolve } from "./resolve.js";

export function parse(content: string | ArrayBuffer | Uint8Array, format?: Format): LockfileGraph {
  const detected = format ?? detectFormat(content);
  switch (detected) {
    case "npm":
      return parseNpm(content as string);
    case "yarn":
      return parseYarn(content as string);
    case "yarn-berry":
      return parseYarnBerry(content as string);
    case "pnpm":
      return parsePnpm(content as string);
    case "bun-text":
      return parseBunText(content as string);
    case "bun-binary":
      return parseBunBinary(content as ArrayBuffer | Uint8Array);
    default:
      throw new Error(`Unsupported lockfile format: ${detected}`);
  }
}

export { detectFormat };
