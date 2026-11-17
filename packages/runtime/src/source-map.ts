/**
 * Minimal source-map v3 consumer, used to resolve a stack frame that points
 * into a *bundled* program back to the original module.
 *
 * A bundle executes from a single `blob:` URL, so every frame reports the
 * bundle's own line/column. The bundler (@rolldown/browser) can emit a
 * source map with `sourcesContent`, which is self-contained: the original
 * module texts ride along, so no filesystem access is needed to recover an
 * `assert.ok(...)` call site (see node-process-worker.ts).
 *
 * Only the lookup this runtime needs is implemented: given a generated
 * (line, column), find the closest mapping at or before that column on the
 * same generated line. Full spec fidelity (bias modes, index maps,
 * `sourceRoot` resolution) is deliberately out of scope.
 */

export interface RawSourceMap {
  version?: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
  names?: string[];
}

export interface MappedPosition {
  /** Index into `sources` for the mapping found. */
  readonly sourceIndex: number;
  /** Zero-based line in the original source. */
  readonly line: number;
  /** Zero-based column in the original source. */
  readonly column: number;
  /** The original source text, when the map carried `sourcesContent`. */
  readonly content: string | undefined;
}

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const CHAR_TO_INT = new Map<string, number>([...CHARS].map((c, i) => [c, i]));

/** Decodes one base64 VLQ value; returns the value and the next index. */
const decodeVlq = (segment: string, start: number): [number, number] => {
  let result = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    const digit = CHAR_TO_INT.get(segment[i]);
    if (digit === undefined) throw new Error(`invalid base64 VLQ character "${segment[i]}"`);
    i += 1;
    result += (digit & 31) << shift;
    if ((digit & 32) === 0) break;
    shift += 5;
  }
  // The low bit is the sign; the rest is the magnitude.
  const negative = (result & 1) === 1;
  const value = result >> 1;
  return [negative ? -value : value, i];
};

export interface MappingSegment {
  readonly generatedColumn: number;
  readonly sourceIndex: number;
  readonly line: number;
  readonly column: number;
}

/** Decodes `mappings` into per-generated-line segment lists. */
const decodeMappings = (mappings: string): Map<number, MappingSegment[]> => {
  const lines = new Map<number, MappingSegment[]>();
  let sourceIndex = 0;
  let line = 0;
  let column = 0;
  let generatedLine = 0;
  for (const rawLine of mappings.split(";")) {
    generatedLine += 1;
    let generatedColumn = 0;
    for (const rawSegment of rawLine.split(",")) {
      if (rawSegment === "") continue;
      let i = 0;
      let value: number;
      [value, i] = decodeVlq(rawSegment, i);
      generatedColumn += value;
      // A 1-field segment only carries the generated column (no source).
      if (i >= rawSegment.length) continue;
      [value, i] = decodeVlq(rawSegment, i);
      sourceIndex += value;
      [value, i] = decodeVlq(rawSegment, i);
      line += value;
      [value, i] = decodeVlq(rawSegment, i);
      column += value;
      const list = lines.get(generatedLine - 1);
      const segment: MappingSegment = { generatedColumn, sourceIndex, line, column };
      if (list) list.push(segment);
      else lines.set(generatedLine - 1, [segment]);
    }
  }
  return lines;
};

/**
 * A decoded map: resolves generated positions to original ones. Segments are
 * kept per generated line; a lookup takes the segment at or before the
 * requested column (V8 reports the column *of* the call expression, and the
 * bundler maps that column to the original expression start).
 */
export class SourceMapIndex {
  readonly #map: RawSourceMap;
  readonly #lines: Map<number, MappingSegment[]>;

  constructor(map: RawSourceMap) {
    this.#map = map;
    this.#lines = decodeMappings(map.mappings ?? "");
  }

  /** Original position for a generated (line, column), or `undefined`. */
  originalPositionFor(generatedLine: number, generatedColumn: number): MappedPosition | undefined {
    // V8 numbers lines from 1; the map is zero-based.
    const segments = this.#lines.get(generatedLine - 1);
    if (!segments || segments.length === 0) return undefined;
    let best: MappingSegment | undefined;
    for (const segment of segments) {
      if (segment.generatedColumn > generatedColumn) break;
      best = segment;
    }
    if (!best) return undefined;
    const content = this.#map.sourcesContent?.[best.sourceIndex] ?? undefined;
    return {
      sourceIndex: best.sourceIndex,
      line: best.line,
      column: best.column,
      content: content === null ? undefined : content,
    };
  }

  /** The `sources` entry for an index (path as the bundler emitted it). */
  sourceFor(sourceIndex: number): string | undefined {
    return this.#map.sources[sourceIndex];
  }
}
