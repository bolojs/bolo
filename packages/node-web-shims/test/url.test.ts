import { describe, it, expect } from "vitest";
import { createUrlShim } from "../src/url.ts";

describe("node-web-shims: url", () => {
  it("should match node:url type shape", () => {
    const shim = createUrlShim();
    const _nodeUrl: typeof import("node:url") = shim;
    expect(_nodeUrl).toBeDefined();
  });

  it("exposes the full legacy + WHATWG surface as enumerable keys", () => {
    const shim = createUrlShim();
    for (const name of [
      "Url",
      "parse",
      "resolve",
      "resolveObject",
      "format",
      "URL",
      "URLSearchParams",
      "domainToASCII",
      "domainToUnicode",
      "pathToFileURL",
      "fileURLToPath",
      "urlToHttpOptions",
    ]) {
      expect(Object.keys(shim), `missing ${name}`).toContain(name);
    }
  });

  it("parses a bare path like Node's url.parse", () => {
    const shim = createUrlShim();
    expect(shim.parse("foo")).toMatchObject({
      protocol: null,
      slashes: null,
      host: null,
      pathname: "foo",
      path: "foo",
      href: "foo",
    });
  });

  it("parses an absolute URL with auth, port, query and hash", () => {
    const shim = createUrlShim();
    const u = shim.parse("http://user:pass@example.com:8080/p/a?x=1&y=2#frag");
    expect(u).toMatchObject({
      protocol: "http:",
      slashes: true,
      auth: "user:pass",
      hostname: "example.com",
      port: "8080",
      pathname: "/p/a",
      search: "?x=1&y=2",
      query: "x=1&y=2",
      hash: "#frag",
    });
  });

  it("wires querystring into parse(..., true)", () => {
    const shim = createUrlShim();
    const u = shim.parse("http://h/p?a=1&b=two", true);
    expect(u.query).toEqual({ a: "1", b: "two" });
  });

  it("parses //host/path when slashesDenoteHost is set", () => {
    const shim = createUrlShim();
    expect(shim.parse("//h/p", false, true)).toMatchObject({
      slashes: true,
      host: "h",
      hostname: "h",
      pathname: "/p",
    });
  });

  it("formats Url-like objects", () => {
    const shim = createUrlShim();
    expect(shim.format({ protocol: "http", host: "a.com", pathname: "/p" })).toBe(
      "http://a.com/p",
    );
    expect(
      shim.format({ protocol: "https:", hostname: "a.com", port: "8443", pathname: "/x" }),
    ).toBe("https://a.com:8443/x");
    expect(shim.format({ pathname: "/p", query: { a: "1" } })).toBe("/p?a=1");
    expect(shim.format(new URL("http://a.com/b?c=1"))).toBe("http://a.com/b?c=1");
  });

  it("resolves relative references", () => {
    const shim = createUrlShim();
    expect(shim.resolve("/a/b", "c")).toBe("/a/c");
    expect(shim.resolve("/a/b/", "c")).toBe("/a/b/c");
    expect(shim.resolve("http://x.com/a/b", "c")).toBe("http://x.com/a/c");
    expect(shim.resolve("http://x.com/a/", "http://y.com/z")).toBe("http://y.com/z");
  });

  it("round-trips file URLs", () => {
    const shim = createUrlShim();
    const fileUrl = shim.pathToFileURL("/tmp/some file.txt");
    expect(fileUrl.protocol).toBe("file:");
    expect(shim.fileURLToPath(fileUrl)).toBe("/tmp/some%20file.txt".replace(/%20/g, " "));
  });

  it("urlToHttpOptions maps a URL to request options", () => {
    const shim = createUrlShim();
    const opts = shim.urlToHttpOptions(new URL("http://u:p@h.com:8080/x?y=1#z"));
    expect(opts).toMatchObject({
      protocol: "http:",
      hostname: "h.com",
      port: 8080,
      pathname: "/x",
      search: "?y=1",
      path: "/x?y=1",
      auth: "u:p",
    });
  });

  it("domainToASCII/domainToUnicode convert IDN names", () => {
    const shim = createUrlShim();
    expect(shim.domainToASCII("bücher.de")).toBe("xn--bcher-kva.de");
    expect(shim.domainToUnicode("xn--bcher-kva.de")).toBe("bücher.de");
    expect(shim.domainToASCII("")).toBe("");
  });
});
