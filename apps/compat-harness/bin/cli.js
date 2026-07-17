#!/usr/bin/env node
import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureBoloLogging, getLogger } from "@bolojs/log";

const logger = getLogger(["bolo", "compat-harness", "cli"]);

const defaultSourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "package-matrix.json",
);

const usage = () =>
  `Usage: compat-harness [options]\n\n` +
  `Options:\n` +
  `  --json              Print JSON to stdout\n` +
  `  --url <url>         Harness URL (default: http://localhost:5173)\n` +
  `  --output <path>     Write JSON result to a file\n` +
  `  --source <path>     Path to package-matrix.json source to override\n` +
  `  --packages <names>  Comma-separated or JSON-array package names to filter\n` +
  `  --shard-index <n>   Zero-based shard index for parallel runs\n` +
  `  --shard-total <n>   Total number of shards\n`;
const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    json: false,
    url: process.env.HARNESS_URL || "http://localhost:5173",
    output: process.env.OUTPUT_PATH,
    source: process.env.SOURCE_MATRIX,
    packages: process.env.PACKAGE_NAMES,
    shardIndex: parseInt(process.env.SHARD_INDEX || "0", 10),
    shardTotal: parseInt(process.env.SHARD_TOTAL || "1", 10),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--url" || arg === "-u") {
      options.url = args[++i];
    } else if (arg === "--output" || arg === "-o") {
      options.output = args[++i];
    } else if (arg === "--source" || arg === "-s") {
      options.source = args[++i];
    } else if (arg === "--packages" || arg === "-p") {
      options.packages = args[++i];
    } else if (arg === "--shard-index") {
      options.shardIndex = parseInt(args[++i], 10);
    } else if (arg === "--shard-total") {
      options.shardTotal = parseInt(args[++i], 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      logger.error("unknown option", { arg });
      console.error(usage());
      process.exit(1);
    }
  }

  return options;
};

const parsePackages = (raw) => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const main = async () => {
  await configureBoloLogging();
  const options = parseArgs();
  const allowed = parsePackages(options.packages);
  const sourcePath = options.source || defaultSourcePath;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (msg) => logger.info(`browser:${msg.type()}`, { text: msg.text() }));
  page.on("pageerror", (err) => logger.error("browser pageerror", { error: err.message }));
  page.on("requestfailed", (req) =>
    logger.error("browser requestfailed", { url: req.url(), error: req.failure()?.errorText }),
  );

  if (options.source || allowed || options.shardTotal > 1) {
    const matrix = JSON.parse(await readFile(sourcePath, "utf8"));
    let packages = matrix.packages;
    if (allowed) {
      const set = new Set(allowed);
      packages = packages.filter((p) => set.has(p.name));
    }
    if (options.shardTotal > 1) {
      const shardSize = Math.ceil(packages.length / options.shardTotal);
      packages = packages.slice(
        options.shardIndex * shardSize,
        (options.shardIndex + 1) * shardSize,
      );
    }
    await page.route("**/src/package-matrix.json", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...matrix, packages }),
      });
    });
  }

  const LOAD_TIMEOUT = 120000;
  const RUN_TIMEOUT = 300000;

  try {
    logger.info("navigating to", { url: options.url });
    await page.goto(options.url, { timeout: LOAD_TIMEOUT });
    logger.info("goto done", { url: page.url() });
    await page.waitForFunction(() => typeof window.__compatHarness !== "undefined", undefined, {
      timeout: LOAD_TIMEOUT,
    });
    await page.click("#bootBtn");
    await page.waitForFunction(
      () => document.getElementById("status")?.textContent === "ready",
      undefined,
      { timeout: LOAD_TIMEOUT },
    );
    await page.click("#pkgBtn");
    await page.waitForFunction(() => window.__packageResults !== null, undefined, {
      timeout: RUN_TIMEOUT,
    });
    const results = await page.evaluate(() => window.__packageResults);
    for (const r of results) {
      if (r.status === "fail") {
        r.error = `${r.error ?? ""}\n(bolo diagnostics: .logs/latest.jsonl)`.trim();
      }
    }
    const output = { packages: results };

    if (options.output) {
      await writeFile(options.output, JSON.stringify(output, null, 2) + "\n");
    }

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else if (!options.output) {
      console.log(`Ran ${results.length} packages`);
      for (const r of results) {
        const duration = r.duration ? `${r.duration.toFixed(0)}ms` : "n/a";
        console.log(`${r.status.padEnd(4)} ${r.name} (${r.class}) ${duration}`);
      }
    }
  } finally {
    await browser.close();
  }
};

main().catch((err) => {
  logger.fatal("compat-harness cli failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
