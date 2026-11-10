import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import { createPathShim } from "../../../packages/node-web-shims/src/path.ts";

const shim = createPathShim();

// Counterexamples found by tests/unit/property/path.prop.test.ts (pathe vs
// node:path). Seeds recorded per case for replay via FC_SEED. The property
// suite filters these inputs; each entry below is the minimized example.
describe("pathe vs node:path divergences (fixed by vendored lib/path.js)", () => {
  it("[seed 178856542] pathe treats backslash as a separator (join)", () => {
    expect(shim.join("\\")).toBe(nodePath.join("\\")); // shim "/", node "\\"
  });

  it("[seed 179335008] pathe treats backslash as a separator (normalize)", () => {
    expect(shim.normalize("/\\")).toBe(nodePath.normalize("/\\")); // shim "/", node "/\\"
  });

  it("[seed 1256380562] pathe treats backslash as a separator (resolve)", () => {
    expect(shim.resolve("\\")).toBe(nodePath.resolve("\\"));
  });

  it("[seed 232625762] pathe treats backslash as a separator (basename)", () => {
    expect(shim.basename("..\\")).toBe(nodePath.basename("..\\"));
  });

  it("[seed 533351835] pathe treats backslash as a separator (dirname)", () => {
    expect(shim.dirname("..\\/a")).toBe(nodePath.dirname("..\\/a"));
  });

  it("[seed -15941056] pathe treats backslash as a separator (relative)", () => {
    expect(shim.relative("/", "\\")).toBe(nodePath.relative("/", "\\"));
  });

  it("[seed -967747702] pathe treats drive letters as absolute (isAbsolute)", () => {
    expect(shim.isAbsolute("C:/a")).toBe(nodePath.isAbsolute("C:/a")); // shim true, node false on POSIX
  });

  it("[seed 318295977-adjacent] pathe keeps leading '//' (normalize)", () => {
    expect(shim.normalize("//a")).toBe(nodePath.normalize("//a")); // shim "//a", node "/a"
  });

  it("[seed 318295977-adjacent] pathe keeps leading '//' (dirname)", () => {
    expect(shim.dirname("//a")).toBe(nodePath.dirname("//a")); // shim "/", node "//"
  });

  it("[seed 318295977-adjacent] pathe keeps leading '//' (join)", () => {
    expect(shim.join("//a", "x")).toBe(nodePath.join("//a", "x")); // shim "//a/x", node "/a/x"
  });

  it("[seed 318295977-adjacent] pathe keeps leading '//' (isAbsolute)", () => {
    expect(shim.isAbsolute("//.")).toBe(nodePath.isAbsolute("//.")); // shim false, node true
  });

  it("[seed 318295977-adjacent] pathe keeps leading '//' (relative)", () => {
    expect(shim.relative("/", "//..a")).toBe(nodePath.relative("/", "//..a"));
  });

  it("[seed -477403570] pathe extname reports '.' for a '.' basename", () => {
    expect(shim.extname("a/.")).toBe(nodePath.extname("a/.")); // shim ".", node ""
  });

  it("[seed -477403570] pathe extname returns '' before trailing slashes", () => {
    expect(shim.extname("a./")).toBe(nodePath.extname("a./")); // shim "", node "."
  });

  it("[seed -1998375330] pathe parse fills dir '.' for slash-less paths", () => {
    expect({ ...shim.parse("a") }).toEqual({ ...nodePath.parse("a") });
  });

  it("[seed -1464676115] pathe format omits trailing sep for dir-only objects", () => {
    expect(shim.format({ dir: "a" })).toBe(nodePath.format({ dir: "a" })); // shim "a", node "a/"
  });

  it("[seed -1716466812] pathe format resolves root against cwd", () => {
    expect(shim.format({ root: "a", name: "n", ext: "e" })).toBe(
      nodePath.format({ root: "a", name: "n", ext: "e" }),
    ); // shim cwd+"/a/n.e", node "an.e"
  });

  it("[seed any] pathe dirname strips only one trailing slash", () => {
    expect(shim.dirname("a/b//")).toBe(nodePath.dirname("a/b//")); // shim "a/b", node "a"
  });

  it("[seed any] pathe parse computes dir on one-stripped-slash input", () => {
    expect({ ...shim.parse("/a//") }).toEqual({ ...nodePath.parse("/a//") }); // dir "/a" vs "/"
  });

  it("[seed any] pathe extname drops ext when basename has dot + trailing slash", () => {
    expect(shim.extname("x.y/")).toBe(nodePath.extname("x.y/")); // shim "", node ".y"
  });

  it("[seed any] pathe format uses empty base literally where node falls back", () => {
    expect(shim.format({ base: "", ext: "a" })).toBe(nodePath.format({ base: "", ext: "a" }));
    // shim "", node ".a"
  });

  it("[seed any] node basename two-arg form returns '/' on root", () => {
    expect(shim.basename("/", "a")).toBe(nodePath.basename("/", "a")); // shim "", node "/"
  });

  it("[seed 318295977-adjacent] pathe basename strips suffix equal to basename", () => {
    expect(shim.basename("/..", "..")).toBe(nodePath.basename("/..", "..")); // shim "", node ".."
  });

  it("[seed 5383726] node basename returns trailing-slash form on dot ext edge", () => {
    expect(shim.basename("/./", "..")).toBe(nodePath.basename("/./", "..")); // shim ".", node "./"
    expect(shim.basename("/./", "...")).toBe(nodePath.basename("/./", "..."));
    expect(shim.basename("/../", "a..")).toBe(nodePath.basename("/../", "a..")); // shim "..", node "../"
  });
});
