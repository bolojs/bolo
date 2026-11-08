import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import nodePath from "node:path";
import { createPathShim } from "../../../packages/node-web-shims/src/path.ts";
import { fcParams } from "./fc-config.ts";

const shim = createPathShim();

// The segment pool deliberately avoids "\\" and drive letters ("C:"): pathe
// treats backslash as a path separator and "C:/x" as absolute, while POSIX
// node:path treats both as ordinary characters. That divergence class is
// recorded in tests/unit/regressions/path-pathe-divergences.test.ts.
const segment = fc.constantFrom(
  "a",
  "b",
  "c.d",
  "..",
  ".",
  "",
  "x y",
  "..a",
  "a..",
  "/",
  "%20",
  "é",
  "-",
  "_",
  "...",
);

const pathStr = fc.oneof(
  fc.array(segment, { maxLength: 5 }).map((parts) => parts.join("/")),
  fc.array(segment, { maxLength: 5 }).map((parts) => `/${parts.join("/")}`),
);

// pathe keeps leading "//" (UNC-style) where node:path collapses it — a wide
// divergence class across normalize/dirname/join/isAbsolute/relative, also in
// the regression file. Interior "//" is fine, so only leading is excluded.
const noUnc = pathStr.filter((p) => !p.startsWith("//"));

// pathe.extname returns "" where node keeps "." whenever a dotted basename is
// followed by trailing slashes, and returns "." for basenames of exactly
// "." / "..". See regression file.
const noDotTail = noUnc.filter((p) => {
  const stripped = p.replace(/\/+$/, "");
  const base = stripped.slice(stripped.lastIndexOf("/") + 1);
  if (base === "." || base === "..") return false;
  return !(p.endsWith("/") && base.includes("."));
});

// pathe.parse fills dir with "." for slash-less relative paths where node
// leaves it "", computes dir by stripping one trailing slash where node
// strips them all, and shares pathe.extname's "."-ext quirk on dot basenames.
const withSlash = noUnc.filter(
  (p) => p.includes("/") && !p.endsWith("/") && !/(^|\/)\.\.?$/.test(p),
);

// pathe.dirname strips one trailing slash before resolving where node strips
// them all, so paths ending in 2+ slashes diverge.
const noTrailingSlashes = noUnc.filter((p) => !/\/{2,}$/.test(p));

const optionalSegment = fc.option(segment, { nil: undefined });

// Empty-string fields have ambiguous semantics between the two
// implementations (node falls back to name+ext when base is "", pathe uses
// the empty base literally), so the format property only sees
// present-but-nonempty or absent fields.
const pathObject = fc
  .record({
    root: optionalSegment,
    dir: optionalSegment,
    base: optionalSegment,
    name: optionalSegment,
    ext: optionalSegment,
  })
  .filter((o) => Object.values(o).every((v) => v === undefined || v !== ""));

// join/resolve can only produce a leading "//" result when the raw segments
// already join to one, so filtering the input is sufficient.
const noUncJoin = (segs: string[]): boolean => !segs.join("/").startsWith("//");

describe("differential property: node:path vs path shim (unenv/pathe)", () => {
  it("join matches node:path.join", () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 5 }), (segs) => {
        fc.pre(noUncJoin(segs));
        expect(shim.join(...segs)).toBe(nodePath.join(...segs));
      }),
      fcParams(),
    );
  });

  it("normalize matches node:path.normalize", () => {
    fc.assert(
      fc.property(noUnc, (p) => {
        expect(shim.normalize(p)).toBe(nodePath.normalize(p));
      }),
      fcParams(),
    );
  });

  it("resolve matches node:path.resolve", () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 4 }), (segs) => {
        fc.pre(noUncJoin(segs));
        expect(shim.resolve(...segs)).toBe(nodePath.resolve(...segs));
      }),
      fcParams(),
    );
  });

  it("basename matches node:path.basename", () => {
    fc.assert(
      fc.property(noUnc, optionalSegment, (p, ext) => {
        // pathe strips a suffix equal to the whole basename where node keeps
        // it, treats "/" as empty where node's two-arg form returns "/", and
        // dot suffixes interact differently with node's suffix logic.
        const nodeBase = nodePath.basename(p);
        fc.pre(
          ext === undefined ||
            (nodeBase !== "" && ext !== nodeBase && !ext.endsWith(".") && !p.endsWith("/")),
        );
        const a = ext === undefined ? shim.basename(p) : shim.basename(p, ext);
        const b = ext === undefined ? nodePath.basename(p) : nodePath.basename(p, ext);
        expect(a).toBe(b);
      }),
      fcParams(),
    );
  });

  it("dirname matches node:path.dirname", () => {
    fc.assert(
      fc.property(noTrailingSlashes, (p) => {
        expect(shim.dirname(p)).toBe(nodePath.dirname(p));
      }),
      fcParams(),
    );
  });

  it("extname matches node:path.extname", () => {
    fc.assert(
      fc.property(noDotTail, (p) => {
        expect(shim.extname(p)).toBe(nodePath.extname(p));
      }),
      fcParams(),
    );
  });

  it("isAbsolute matches node:path.isAbsolute", () => {
    fc.assert(
      fc.property(noUnc, (p) => {
        expect(shim.isAbsolute(p)).toBe(nodePath.isAbsolute(p));
      }),
      fcParams(),
    );
  });

  it("parse matches node:path.parse", () => {
    fc.assert(
      fc.property(withSlash, (p) => {
        expect({ ...shim.parse(p) }).toEqual({ ...nodePath.parse(p) });
      }),
      fcParams(),
    );
  });

  it("format matches node:path.format", () => {
    fc.assert(
      fc.property(pathObject, (obj) => {
        // pathe.format resolves root against cwd and appends dir onto it
        // whenever root is present; with no basename part it also omits the
        // sep node appends after dir. See regression file.
        const noBasename = !obj.base && !(obj.name || obj.ext);
        fc.pre(!(!!obj.root || (noBasename && !!obj.dir)));
        expect(shim.format(obj)).toBe(nodePath.format(obj));
      }),
      fcParams(),
    );
  });

  it("relative matches node:path.relative", () => {
    fc.assert(
      fc.property(noUnc, noUnc, (from, to) => {
        expect(shim.relative(from, to)).toBe(nodePath.relative(from, to));
      }),
      fcParams(),
    );
  });

  it("sep and delimiter match node:path", () => {
    expect(shim.sep).toBe(nodePath.sep);
    expect(shim.delimiter).toBe(nodePath.delimiter);
  });
});
