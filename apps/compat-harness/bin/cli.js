#!/usr/bin/env node
import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureBoloLogging, getLogger } from "@bolojs/log";
import { toNodeCompatReport } from "./node-compat-report.js";
import {
  appendPartial,
  classifyHeartbeat,
  completedNames,
  DEFAULT_GRACE_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PROBE,
  mergeResults,
  partialPathFor,
  pendingPackages,
  readPartialFile,
} from "./progress-report.js";

/**
 * Where the harness page publishes the name of its incremental-result
 * channel (src/partial-channel.ts). The CLI reads it at runtime instead of
 * hardcoding the channel name: the page side is TypeScript and this file is
 * plain JavaScript (Node 20 in CI), so they cannot share an import, and two
 * independently maintained literals is exactly how the channel silently
 * broke before.
 */
const PARTIAL_CHANNEL_NAME_GLOBAL = "__partialChannelName";

/** The Playwright binding the CLI exposes; the page forwards results to it. */
const PARTIAL_BINDING = "__boloPartialPushBinding";

const logger = getLogger(["bolo", "compat-harness", "cli"]);

const defaultSourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "package-matrix.json",
);

/** Per-package deadline, mirroring the in-page runner's own 60s cap. */
const PACKAGE_TIMEOUT_MS = 60_000;
const LOAD_TIMEOUT = 120_000;

/**
 * The matrix is imported as a static JSON module by the harness page
 * (`import packageMatrix from "./package-matrix.json" with { type: "json" }`).
 * Vite serves that import as `/src/package-matrix.json?import`, so a route
 * registered for the bare path never matches and every filter flag
 * (`--source`, `--packages`, `--shard-*`) was silently ignored. The glob must
 * tolerate the query suffix Vite appends.
 */
const MATRIX_ROUTE_GLOB = "**/src/package-matrix.json*";

const usage = () =>
  `Usage: compat-harness [options]\n\n` +
  `Options:\n` +
  `  --mode <m>          packages (default) | node-tests | canaries\n` +
  `  --json              Print JSON to stdout\n` +
  `  --url <url>         Harness URL (default: http://localhost:5173)\n` +
  `  --output <path>     Write JSON result to a file (site-consumable shape)\n` +
  `  --raw-output <path> Also write the detailed per-test run record to a file\n` +
  `  --source <path>     Path to package-matrix.json source to override\n` +
  `  --packages <names>  Comma-separated or JSON-array package names to filter\n` +
  `  --tests <regex>     node-tests mode: only run test files matching this regex\n` +
  `  --shard-index <n>   Zero-based shard index for parallel runs\n` +
  `  --shard-total <n>   Total number of shards\n` +
  `  --resume            Skip packages already recorded in <output>.partial.jsonl\n` +
  `                      (timeouts are retried; the partial file is kept until the\n` +
  `                      run completes, so a killed run loses nothing)\n`;
const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    json: false,
    mode: process.env.HARNESS_MODE || "packages",
    url: process.env.HARNESS_URL || "http://localhost:5173",
    output: process.env.OUTPUT_PATH,
    rawOutput: process.env.RAW_OUTPUT_PATH,
    source: process.env.SOURCE_MATRIX,
    packages: process.env.PACKAGE_NAMES,
    shardIndex: parseInt(process.env.SHARD_INDEX || "0", 10),
    shardTotal: parseInt(process.env.SHARD_TOTAL || "1", 10),
    resume: false,
    tests: process.env.NODE_TESTS_FILTER,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--mode") {
      options.mode = args[++i];
    } else if (arg === "--url" || arg === "-u") {
      options.url = args[++i];
    } else if (arg === "--output" || arg === "-o") {
      options.output = args[++i];
    } else if (arg === "--raw-output") {
      options.rawOutput = args[++i];
    } else if (arg === "--source" || arg === "-s") {
      options.source = args[++i];
    } else if (arg === "--tests") {
      options.tests = args[++i];
    } else if (arg === "--packages" || arg === "-p") {
      options.packages = args[++i];
    } else if (arg === "--shard-index") {
      options.shardIndex = parseInt(args[++i], 10);
    } else if (arg === "--shard-total") {
      options.shardTotal = parseInt(args[++i], 10);
    } else if (arg === "--resume") {
      options.resume = true;
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

const readNodeVersion = async () => {
  const manifest = JSON.parse(
    await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "manifest.json"),
      "utf8",
    ),
  );
  return manifest.nodeVersion;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a page probe with a hard ceiling. A page whose main thread is wedged
 * never answers the evaluate, so the promise must be raced against a timer
 * rather than awaited directly.
 */
const probeWithDeadline = async (page, fn, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(fn),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("probe-hang"), timeoutMs);
      }),
    ]);
  } catch {
    return "probe-hang";
  } finally {
    clearTimeout(timer);
  }
};

/**
 * One in-page result pushed out through the exposed binding: dedupe by name,
 * keep insertion order, forward to the caller's sink.
 */
const makeSink = (results, seen, onResult) => async (result) => {
  if (!result || typeof result.name !== "string" || seen.has(result.name)) return;
  seen.add(result.name);
  results.push(result);
  await onResult(result);
};

/**
 * Attaches the observability hooks every harness page gets (console,
 * pageerror, requestfailed). Pages are recreated after a renderer crash, so
 * the wiring lives here instead of inline at the first page's creation.
 */
const attachPageHooks = (page) => {
  page.on("console", (msg) => logger.info(`browser:${msg.type()}`, { text: msg.text() }));
  page.on("pageerror", (err) => logger.error("browser pageerror", { error: err.message }));
  page.on("requestfailed", (req) =>
    logger.error("browser requestfailed", { url: req.url(), error: req.failure()?.errorText }),
  );
};

/**
 * Brings the harness page up and starts the matrix run.
 *
 * The same page is reused across recoveries (a reload is `page.goto` again)
 * unless the renderer crashed — then the caller swaps in a fresh page first.
 * The filtered-matrix route is registered on the context, so it applies to
 * both.
 *
 * Every page gets the same observability hooks (console, pageerror,
 * requestfailed). The hooks are attached once, on the page that is reused.
 */
const startMatrixRun = async (page, url, skip, log, { reload = true } = {}) => {
  if (reload) {
    await page.goto(url, { timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof window.__compatHarness !== "undefined", undefined, {
      timeout: LOAD_TIMEOUT,
    });
    await page.click("#bootBtn");
    await page.waitForFunction(
      () => document.getElementById("status")?.textContent === "ready",
      undefined,
      { timeout: LOAD_TIMEOUT },
    );
  }
  // The page publishes its incremental-result channel name under
  // __partialChannelName (see src/partial-channel.ts). Reading it here, as
  // late as possible, keeps the CLI honest about the name it must install:
  // when the page calls that global, results stream out per package.
  const channel = await page.evaluate(
    (global) => window[global] ?? null,
    PARTIAL_CHANNEL_NAME_GLOBAL,
  );
  if (!channel) throw new Error("harness page did not publish its partial-result channel name");
  await page.evaluate(
    ({ name, binding }) => {
      window[name] = (result) => window[binding](result);
    },
    { name: channel, binding: PARTIAL_BINDING },
  );
  await page.evaluate((names) => {
    window.__packageSkip = names;
  }, skip);
  await page.click("#pkgBtn");
  log.info("package matrix started");
};

/**
 * Runs the package matrix, streaming every finished package out as it
 * completes and recovering from a wedged page.
 *
 * The in-page runner's 60s deadline is a setTimeout on the page's main
 * thread, so it never fires when that thread is stuck (observed in the wild:
 * oxc-transform's @napi-rs/wasm-runtime throwing "Atomics.wait cannot be
 * called in this context" from a spin loop on the main thread). The watchdog
 * below lives in the CLI process: it probes the page while a package is
 * running, and when the page stops answering past the deadline it records
 * the package as a TIMEOUT failure, reloads the page and carries on.
 */
const runPackageMatrix = async ({ page, context, url, skip, onResult, log }) => {
  const results = [];
  const seen = new Set();
  const sink = makeSink(results, seen, onResult);
  // exposeBinding installs window.__boloPartialPushBinding on every page of
  // the context, so a reloaded or recreated page keeps the same channel.
  await context.exposeBinding("__boloPartialPushBinding", async (_source, result) => {
    await sink(result);
  });

  // A wedged page is recovered by reload, but a *crashed* renderer cannot be
  // re-navigated (every call on it rejects with "Page crashed") — it must be
  // replaced with a fresh page in the same context. The context-scoped route
  // and exposed binding both carry over.
  let currentPage = page;
  let crashed = false;
  const watchForCrash = (p) => {
    p.on("crash", () => {
      crashed = true;
    });
  };
  watchForCrash(currentPage);

  // The page is already booted (the canaries ran on it): start the matrix
  // without reloading, so the container that just passed the canaries is the
  // one that runs the packages.
  await startMatrixRun(currentPage, url, skip, log, { reload: false });

  let currentPackage = null;
  let packageStartedAt = Date.now();
  // Per-package deadline reported by the in-page runner (matrix timeoutMs
  // override or the 60s default) — the watchdog must not kill a package that
  // is legitimately allowed more time than the global default.
  let currentTimeoutMs = PACKAGE_TIMEOUT_MS;

  const recordTimeout = async (name, elapsed) => {
    const timedOut = {
      name,
      class: "unknown",
      status: "fail",
      error: `TIMEOUT after ${currentTimeoutMs}ms (page main thread hung)`,
      duration: elapsed,
    };
    seen.add(name);
    results.push(timedOut);
    await onResult(timedOut);
  };

  const recover = async (reason) => {
    log.error("reloading wedged harness page", { reason });
    // The reloaded page must not redo the packages that already finished:
    // they are in `seen` and would be re-run (and re-reported) otherwise.
    const doneNames = [...seen];
    if (crashed || currentPage.isClosed()) {
      // Crashed renderers are unrecoverable — goto() on them throws
      // "Page crashed". Replace the page; the context route and binding
      // apply to the new one automatically.
      crashed = false;
      const dead = currentPage;
      currentPage = await context.newPage();
      attachPageHooks(currentPage);
      watchForCrash(currentPage);
      await dead.close().catch(() => {});
      log.info("recreated harness page after renderer crash");
    }
    await startMatrixRun(currentPage, url, doneNames, log);
    currentPackage = null;
    packageStartedAt = Date.now();
  };

  for (;;) {
    const probe = await probeWithDeadline(
      currentPage,
      HEARTBEAT_PROBE,
      DEFAULT_HEARTBEAT_INTERVAL_MS * 3,
    );

    if (probe === "probe-hang") {
      const elapsed = Date.now() - packageStartedAt;
      const verdict = classifyHeartbeat({
        elapsedMs: elapsed,
        deadlineMs: currentTimeoutMs,
        probeResult: probe,
      });
      if (verdict === "hung") {
        await recordTimeout(currentPackage ?? "unknown", elapsed);
        await recover(`package ${currentPackage} wedged the page main thread`);
        continue;
      }
      await sleep(DEFAULT_HEARTBEAT_INTERVAL_MS);
      continue;
    }

    const next = probe?.current ?? null;
    if (next && next !== currentPackage) {
      currentPackage = next;
      packageStartedAt = probe.startedAt ?? Date.now();
      currentTimeoutMs = probe.timeoutMs ?? PACKAGE_TIMEOUT_MS;
    } else if (!next) {
      currentPackage = null;
      currentTimeoutMs = PACKAGE_TIMEOUT_MS;
    }

    if (!currentPackage) {
      // Idle between packages, or the run is over.
      const finished = await probeWithDeadline(
        currentPage,
        () => window.__packageResults,
        DEFAULT_HEARTBEAT_INTERVAL_MS * 5,
      );
      if (Array.isArray(finished)) {
        for (const r of finished) await sink(r);
        break;
      }
      await sleep(DEFAULT_HEARTBEAT_INTERVAL_MS);
      continue;
    }

    // A package is running: wait for it to finish or for the page to wedge.
    const elapsed = Date.now() - packageStartedAt;
    const verdict = classifyHeartbeat({
      elapsedMs: elapsed,
      deadlineMs: currentTimeoutMs,
      graceMs: DEFAULT_GRACE_MS,
      probeResult: probe,
    });
    if (verdict === "hung") {
      await recordTimeout(currentPackage, elapsed);
      await recover(`package ${currentPackage} wedged the page main thread`);
      continue;
    }
    await sleep(DEFAULT_HEARTBEAT_INTERVAL_MS);
  }

  return results;
};

const main = async () => {
  await configureBoloLogging();
  const options = parseArgs();
  const allowed = parsePackages(options.packages);
  const sourcePath = options.source || defaultSourcePath;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME || undefined,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  attachPageHooks(page);

  const matrix = JSON.parse(await readFile(sourcePath, "utf8"));
  let packages = matrix.packages;
  if (allowed) {
    const set = new Set(allowed);
    packages = packages.filter((p) => set.has(p.name));
  }
  if (options.shardTotal > 1) {
    const shardSize = Math.ceil(packages.length / options.shardTotal);
    packages = packages.slice(options.shardIndex * shardSize, (options.shardIndex + 1) * shardSize);
  }
  if (options.source || allowed || options.shardTotal > 1) {
    // Context-scoped (not page.route): the harness page is replaced after a
    // renderer crash, and only a context route follows the new page.
    await context.route(MATRIX_ROUTE_GLOB, async (route) => {
      const filtered = { ...matrix, packages };
      // Vite turns the page's static JSON import into a JS module request
      // (`?import`, `Content-Type: application/javascript`): fulfilling with
      // raw JSON fails the module fetch, so the page would fall back to its
      // own bundled copy and the filter would be ignored again.
      if (route.request().url().includes("?import")) {
        await route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: `export default ${JSON.stringify(filtered)};`,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(filtered),
      });
    });
  }

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
    // A scorer that passes any canary is lying: the whole run is invalid.
    const canaries = await page.evaluate(() => window.__runCanaries());
    const leaked = canaries.filter((c) => !c.failedAsExpected);
    if (leaked.length > 0 || options.mode === "canaries") {
      console.log(JSON.stringify(canaries, null, 2));
      if (leaked.length > 0) {
        throw new Error(`INVALID RUN: canaries passed: ${leaked.map((c) => c.name).join(", ")}`);
      }
    }
    if (options.mode === "canaries") return;

    let output;
    if (options.mode === "node-tests") {
      const modules = await page.evaluate((f) => window.__runNodeTests(f), options.tests);
      output = toNodeCompatReport(modules, { nodeVersion: await readNodeVersion() });
      if (options.rawOutput) {
        await writeFile(options.rawOutput, JSON.stringify(modules, null, 2) + "\n");
      }
    } else {
      const partialPath = options.output ? partialPathFor(options.output) : null;
      let resumed = [];
      let runPackages = packages;
      if (options.resume && partialPath) {
        const previous = await readPartialFile(partialPath);
        const done = completedNames(previous);
        resumed = previous.filter((r) => done.has(r.name));
        runPackages = pendingPackages(packages, done);
        logger.info("resume: skipping already-completed packages", {
          skipped: packages.length - runPackages.length,
          remaining: runPackages.length,
        });
      }

      const pendingNames = new Set(runPackages.map((p) => p.name));
      const fresh = await runPackageMatrix({
        page,
        context,
        url: options.url,
        skip: packages.filter((p) => !pendingNames.has(p.name)).map((p) => p.name),
        onResult: async (result) => {
          if (partialPath) await appendPartial(partialPath, result);
          const duration = result.duration ? `${Math.round(result.duration)}ms` : "n/a";
          console.log(`[progress] ${result.status.padEnd(4)} ${result.name} ${duration}`);
        },
        log: logger,
      });

      const ordered = mergeResults(
        resumed,
        fresh,
        packages.map((p) => p.name),
      );
      for (const r of ordered) {
        if (r.status === "fail") {
          r.error = `${r.error ?? ""}\n(bolo diagnostics: .logs/latest.jsonl)`.trim();
        }
      }
      output = {
        generatedAt: new Date().toISOString(),
        validated: true,
        packages: ordered,
      };
    }

    if (options.output) {
      await writeFile(options.output, JSON.stringify(output, null, 2) + "\n");
    }

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else if (!options.output) {
      const results = output.packages ?? [];
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
  console.error(err instanceof Error ? err.stack : String(err));
  logger.fatal("compat-harness cli failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
