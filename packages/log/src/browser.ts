import { configure, getConsoleSink, withFilter, type LogLevel, type Sink } from "@logtape/logtape";
import { createConsoleFilter, parseBoloLogEnv } from "./env-filter.js";
import { boloJsonFormatter } from "./json-formatter.js";

export { getLogger } from "@logtape/logtape";
export type { LogLevel, LogRecord, Sink } from "@logtape/logtape";

export interface ConfigureBrowserLoggingOptions {
  /** Minimum level for the console sink. Defaults to `"warning"`. */
  consoleLevel?: LogLevel;
  /** Per-category level overrides, same convention as `BOLO_LOG` (see `@bolojs/log`). */
  categoryOverrides?: string;
  /** Extra sink to route records to (e.g. relaying to the host via postMessage). */
  customSink?: Sink;
}

/**
 * Configures logtape for realms that can't touch a Node fs handle (worker,
 * iframe, ServiceWorker): console sink only, emitting single-line JSON so
 * it stays greppable when relayed through `page.on('console')` or devtools.
 */
export async function configureBrowserLogging(
  options: ConfigureBrowserLoggingOptions = {},
): Promise<void> {
  const overrides = parseBoloLogEnv(options.categoryOverrides);
  const consoleLevel = options.consoleLevel ?? "warning";

  const sinks: Record<string, Sink> = {
    console: withFilter(
      getConsoleSink({ formatter: boloJsonFormatter }),
      createConsoleFilter(consoleLevel, overrides),
    ),
  };
  const sinkIds = ["console"];

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
