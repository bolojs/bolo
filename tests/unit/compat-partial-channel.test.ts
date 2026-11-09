// Regression: the CLI and the page named the incremental-result channel
// differently (the CLI installed `window.__boloPartialPush`, the page invoked
// `window.__packagePartial?.()`), so per-package results never reached the
// CLI: the partial JSONL stayed empty until the final drain, a recovered run
// re-ran every package its page had already finished, and run1 of the
// 2026-11-07 matrix produced zero `[progress]` lines.
//
// The page side is TypeScript and the CLI side is plain JavaScript (the CLI
// runs on Node 20 in CI, which cannot import TypeScript), so the two sides
// cannot share an import. The shared artifact is the name of the discovery
// global, which both sides spell literally; the channel name itself travels
// at runtime, published by the page and installed by the CLI.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PARTIAL_CHANNEL,
  PARTIAL_CHANNEL_NAME_GLOBAL,
} from "../../apps/compat-harness/src/partial-channel.ts";

/** The Playwright binding the CLI exposes; the page forwards results to it. */
const PARTIAL_BINDING = "__boloPartialPushBinding";

const read = (relativePath: string) =>
  readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const mainSource = await read("../../apps/compat-harness/src/main.ts");
const cliSource = await read("../../apps/compat-harness/bin/cli.js");
const channelSource = await read("../../apps/compat-harness/src/partial-channel.ts");

describe("partial-result channel wiring", () => {
  it("owns the shared names in one module", () => {
    expect(channelSource).toContain(
      `export const PARTIAL_CHANNEL = ${JSON.stringify(PARTIAL_CHANNEL)};`,
    );
    expect(channelSource).toContain(
      `export const PARTIAL_CHANNEL_NAME_GLOBAL = ${JSON.stringify(PARTIAL_CHANNEL_NAME_GLOBAL)};`,
    );
  });

  it("the page publishes and invokes the channel through the shared constants", () => {
    // The page must not spell the channel name itself: the old call site,
    // `window.__packagePartial?.(result)`, is what broke the channel.
    expect(mainSource).not.toMatch(/window\.__packagePartial\b/);
    expect(mainSource).toContain(`window[PARTIAL_CHANNEL_NAME_GLOBAL] = PARTIAL_CHANNEL;`);
    expect(mainSource).toContain(`window[PARTIAL_CHANNEL]?.(result)`);
  });

  it("the CLI spells the discovery global the page publishes", () => {
    expect(cliSource).toContain(
      `const PARTIAL_CHANNEL_NAME_GLOBAL = ${JSON.stringify(PARTIAL_CHANNEL_NAME_GLOBAL)};`,
    );
    // The old hardcoded channel name would bypass the discovery contract.
    expect(cliSource).not.toMatch(/window\.__boloPartialPush\s*=/);
  });

  it("the CLI installs the channel via the discovered name, forwarding to the binding", () => {
    expect(cliSource).toContain(`window[name] = (result) => window[binding](result);`);
    expect(cliSource).toContain(`const PARTIAL_BINDING = ${JSON.stringify(PARTIAL_BINDING)};`);
  });

  it("the CLI refuses to run a page that does not publish the channel name", () => {
    expect(cliSource).toContain("did not publish its partial-result channel name");
  });
});
