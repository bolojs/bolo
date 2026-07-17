import { compareLogLevel, isLogLevel, type LogLevel, type LogRecord } from "@logtape/logtape";

/**
 * Parses the `BOLO_LOG` convention, e.g. `"sandbox=debug,net-shim=trace"`,
 * into a map from category segment to minimum level.
 */
export function parseBoloLogEnv(env: string | undefined): Map<string, LogLevel> {
  const overrides = new Map<string, LogLevel>();
  if (!env) return overrides;

  for (const entry of env.split(",")) {
    const [rawCategory, rawLevel] = entry.split("=").map((part) => part.trim());
    if (!rawCategory || !rawLevel) continue;
    const level = rawLevel.toLowerCase();
    if (isLogLevel(level)) overrides.set(rawCategory, level);
  }

  return overrides;
}

/**
 * Builds a console-sink filter that honors per-category overrides from
 * `BOLO_LOG` on top of a default level. The most specific (rightmost)
 * matching category segment wins, so `["bolo", "runtime", "iframe-sandbox"]`
 * matches an override keyed `"iframe-sandbox"` over one keyed `"runtime"`.
 */
export function createConsoleFilter(
  defaultLevel: LogLevel,
  overrides: Map<string, LogLevel>,
): (record: LogRecord) => boolean {
  return (record: LogRecord): boolean => {
    let level = defaultLevel;
    for (const segment of record.category) {
      const override = overrides.get(segment);
      if (override) level = override;
    }
    return compareLogLevel(record.level, level) >= 0;
  };
}
