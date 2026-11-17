/**
 * Source reader for the `assert.ok` expression message that resolves stack
 * frames inside a bundled module (`data:`/`blob:` import) through the
 * bundle's inline sourcemap back to the original source text.
 *
 * bundleEntry (packages/wasm-registry) emits bundles with
 * `sourcemap: "inline"`, so every process worker can recover original
 * sources and positions without a filesystem round-trip — `sourcesContent`
 * is part of the map.
 */

import type { ResolvedSource, SourceReader } from "./ok-expression.js";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64Index = new Map([...B64].map((c, i) => [c, i]));

/** Decodes one base64-VLQ value starting at `pos`; returns [value, nextPos]. */
const decodeVlq = (str: string, pos: number): [number, number] => {
  let result = 0;
  let shift = 0;
  for (;;) {
    const digit = b64Index.get(str[pos]);
    if (digit === undefined) throw new Error(`bad VLQ digit at ${pos}`);
    pos += 1;
    result |= (digit & 31) << shift;
    if ((digit & 32) === 0) break;
    shift += 5;
  }
  const negative = result & 1;
  result >>>= 1;
  return [negative ? -result : result, pos];
};

interface SourcemapSegment {
  genColumn: number;
  source: number;
  line: number;
  column: number;
}

interface Sourcemap {
  sources: string[];
  sourcesContent?: (string | null)[];
  /** segments per generated line, sorted by generated column */
  lines: SourcemapSegment[][];
}

const parseMappings = (mappings: string): SourcemapSegment[][] => {
  const lines: SourcemapSegment[][] = [];
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const line of mappings.split(";")) {
    const segments: SourcemapSegment[] = [];
    let genCol = 0;
    if (line) {
      for (const segment of line.split(",")) {
        let pos = 0;
        let value: number;
        [value, pos] = decodeVlq(segment, pos);
        genCol += value;
        if (pos >= segment.length) continue; // unmapped segment
        [value, pos] = decodeVlq(segment, pos);
        src += value;
        [value, pos] = decodeVlq(segment, pos);
        srcLine += value;
        [value, pos] = decodeVlq(segment, pos);
        srcCol += value;
        segments.push({ genColumn: genCol, source: src, line: srcLine, column: srcCol });
      }
    }
    lines.push(segments);
  }
  return lines;
};

const lastSegmentAtOrBefore = (
  segments: SourcemapSegment[],
  column: number,
): SourcemapSegment | undefined => {
  let lo = 0;
  let hi = segments.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].genColumn <= column) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best === -1 ? undefined : segments[best];
};

const decodeInlineMap = (bundleCode: string): Sourcemap | undefined => {
  const marker = "//# sourceMappingURL=data:application/json";
  const idx = bundleCode.lastIndexOf(marker);
  if (idx === -1) return undefined;
  // `data:application/json` may carry mediatype parameters in any
  // combination (`;charset=utf-8`, `;base64`) before the `,` separator.
  const rest = bundleCode.slice(idx + marker.length).trim();
  const sep = rest.indexOf(",");
  if (sep === -1) return undefined;
  const base64 = rest.slice(0, sep).split(";").includes("base64");
  const payload = rest.slice(sep + 1);
  let json: string;
  try {
    json = base64
      ? new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
      : decodeURIComponent(payload);
  } catch {
    return undefined;
  }
  try {
    const map = JSON.parse(json) as {
      sources?: string[];
      sourcesContent?: (string | null)[];
      mappings?: string;
    };
    if (!map.sources || !map.sourcesContent || typeof map.mappings !== "string") {
      return undefined;
    }
    return {
      sources: map.sources,
      sourcesContent: map.sourcesContent,
      lines: parseMappings(map.mappings),
    };
  } catch {
    return undefined;
  }
};

/**
 * Builds a {@link SourceReader} for a bundle that carries an inline
 * sourcemap. `accept` restricts which stack filenames the reader claims —
 * pass the exact `blob:`/`data:` module URL the bundle was imported from;
 * without one, any `blob:`/`data:`/`file:` frame is accepted.
 *
 * Returns `undefined` when `bundleCode` has no inline map.
 */
export const createBundleSourcemapReader = (
  bundleCode: string,
  accept?: (filename: string) => boolean,
): SourceReader | undefined => {
  const marker = "//# sourceMappingURL=data:application/json";
  if (!bundleCode.includes(marker)) return undefined;
  let parsed: Sourcemap | undefined | null;
  return (filename, line, column): ResolvedSource | string | undefined => {
    // Async frames print as `at async <url>:line:col` in string stacks.
    const claimed = filename.startsWith("async ") ? filename.slice(6) : filename;
    const claims =
      accept?.(claimed) ?? (claimed.startsWith("blob:") || claimed.startsWith("data:"));
    if (!claims) return undefined;
    if (parsed === undefined) parsed = decodeInlineMap(bundleCode) ?? null;
    if (!parsed) return undefined;
    // Stack line/column are 1-based; mappings are 0-based.
    const segments = parsed.lines[line - 1];
    if (!segments) return undefined;
    const segment = lastSegmentAtOrBefore(segments, column - 1) ?? segments[0];
    if (!segment) return undefined;
    const code = parsed.sourcesContent?.[segment.source];
    if (typeof code !== "string") return undefined;
    return { code, line: segment.line, column: segment.column };
  };
};
