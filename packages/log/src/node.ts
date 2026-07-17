import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configure, getConsoleSink, withFilter, type LogLevel, type Sink } from "@logtape/logtape";
import { getFileSink } from "@logtape/file";
import { getPrettyFormatter } from "@logtape/pretty";
import { createConsoleFilter, parseBoloLogEnv } from "./env-filter.js";
import { boloJsonFormatter } from "./json-formatter.js";

export { getLogger } from "@logtape/logtape";
export type { LogLevel, LogRecord, Sink } from "@logtape/logtape";

export interface ConfigureBoloLoggingOptions {
  /** Directory that holds the run's JSONL log and the `latest.jsonl` pointer. Defaults to `.logs`. */
  logsDir?: string;
  /** Identifier for this run, used in the log filename. Defaults to a timestamp + short random id. */
  runId?: string;
  /** Minimum level for the console sink. Defaults to `"warning"`. The file sink always captures every level. */
  consoleLevel?: LogLevel;
  /** Extra sink to route records to (OTel, Sentry, a UI panel, etc.), without forking this package. */
  customSink?: Sink;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Configures logtape for Node contexts (CLI, compat-harness, Vitest,
 * Playwright driver process): a JSONL file sink capturing every level at
 * `.logs/<run>.jsonl` (symlinked from `.logs/latest.jsonl`), plus a
 * pretty-printed console sink defaulting to `warning`+ so live terminal
 * output and Bash-tool-captured output stay lean. Filtering is per-sink, so
 * capture verbosity (file) is decoupled from read verbosity (console).
 *
 * Browser/worker/ServiceWorker realms can't touch a Node fs handle — use
 * `configureBrowserLogging` from `@bolojs/log/browser` there instead.
 */
export async function configureBoloLogging(
  options: ConfigureBoloLoggingOptions = {},
): Promise<void> {
  const overrides = parseBoloLogEnv(process.env.BOLO_LOG);
  const consoleLevel = options.consoleLevel ?? "warning";

  const sinks: Record<string, Sink> = {
    console: withFilter(
      getConsoleSink({ formatter: getPrettyFormatter() }),
      createConsoleFilter(consoleLevel, overrides),
    ),
  };
  const sinkIds = ["console"];

  const logsDir = options.logsDir ?? ".logs";
  mkdirSync(logsDir, { recursive: true });
  const runId = options.runId ?? `${formatTimestamp(new Date())}-${randomUUID().slice(0, 8)}`;
  const logFileName = `${runId}.jsonl`;
  const latestPath = join(logsDir, "latest.jsonl");

  sinks.file = getFileSink(join(logsDir, logFileName), { formatter: boloJsonFormatter });
  sinkIds.push("file");

  try {
    if (existsSync(latestPath)) unlinkSync(latestPath);
    symlinkSync(logFileName, latestPath);
  } catch {
    // Symlinks unsupported in this environment (e.g. some CI/Windows setups).
    // .logs/<run>.jsonl still exists; agents can find it without the pointer.
  }

  if (options.customSink) {
    sinks.custom = options.customSink;
    sinkIds.push("custom");
  }

  await configure({
    sinks,
    loggers: [
      { category: ["bolo"], sinks: sinkIds, lowestLevel: "trace" },
      { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
    ],
    reset: true,
  });
}
