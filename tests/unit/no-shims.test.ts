import { build } from "esbuild";
import { describe, it, expect } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const resolveDir = dirname(fileURLToPath(import.meta.url));

/**
 * Web-Standard libraries should bundle with zero node:* references, proving
 * they run in the browser without any Node.js shims injected.
 *
 * This is the B2a no-shims validation — the credibility anchor for the
 * dashboard's "Web-Standard" tier claim.
 */
const WEB_STANDARD_LIBS = ["hono", "itty-router", "elysia"] as const;

const bundleLib = async (specifier: string): Promise<string> => {
  const result = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(specifier)}`,
      resolveDir,
      sourcefile: "entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
};

describe("no-shims validation (B2a)", () => {
  for (const lib of WEB_STANDARD_LIBS) {
    it(`${lib} bundle has zero node:* references`, async () => {
      const code = await bundleLib(lib);
      const nodeRefs = code.match(/\bnode:[a-z_/]+/g) ?? [];
      expect(nodeRefs, `expected zero node:* refs, found: ${nodeRefs.join(", ")}`).toEqual([]);
    });
  }
});
