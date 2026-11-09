import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import nodeUrl from "node:url";
import { createUrlShim } from "../../../packages/node-web-shims/src/url.ts";
import { fcParams, outcome, expectSameOutcome } from "./fc-config.ts";

const shim = createUrlShim();

const urlPiece = fc.constantFrom(
  "http",
  "https",
  "ftp",
  "file",
  "ws",
  ":",
  "//",
  "/",
  "a",
  "b.c",
  "d/e",
  "?",
  "#",
  "@",
  "=",
  "&",
  "%",
  "%2f",
  "80",
  "..",
  "user:pass",
  "[::1]",
  " ",
  "é",
);

const messyUrl = fc.array(urlPiece, { minLength: 1, maxLength: 6 }).map((parts) => parts.join(""));

const urlStr = fc.oneof(fc.webUrl(), messyUrl);

interface UrlFields {
  href: unknown;
  protocol: unknown;
  auth: unknown;
  host: unknown;
  port: unknown;
  hostname: unknown;
  hash: unknown;
  search: unknown;
  query: unknown;
  pathname: unknown;
  path: unknown;
  slashes: unknown;
}

const fields = (u: nodeUrl.Url): UrlFields => ({
  href: u.href,
  protocol: u.protocol,
  auth: u.auth,
  host: u.host,
  port: u.port,
  hostname: u.hostname,
  hash: u.hash,
  search: u.search,
  query: typeof u.query === "object" && u.query !== null ? { ...u.query } : u.query,
  pathname: u.pathname,
  path: u.path,
  slashes: u.slashes,
});

describe("differential property: node:url vs url shim (unenv)", () => {
  // unenv's url.parse is more permissive than node's: it returns an object for
  // inputs where node throws ERR_INVALID_URL (DEP0170 class). Divergence is
  // recorded in tests/unit/regressions/url-unenv-divergences.test.ts, so we
  // only compare outputs on inputs node accepts.
  it("parse (query as string) matches node:url.parse", () => {
    fc.assert(
      fc.property(urlStr, (s) => {
        const b = outcome(() => fields(nodeUrl.parse(s)));
        fc.pre(!b.threw);
        const a = outcome(() => fields(shim.parse(s)));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("parse (query as object) matches node:url.parse", () => {
    fc.assert(
      fc.property(urlStr, (s) => {
        const b = outcome(() => fields(nodeUrl.parse(s, true)));
        fc.pre(!b.threw);
        const a = outcome(() => fields(shim.parse(s, true)));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("format matches node:url.format on identical Url objects", () => {
    fc.assert(
      fc.property(urlStr, (s) => {
        const parsed = outcome(() => nodeUrl.parse(s));
        if (parsed.threw) return;
        const a = outcome(() => shim.format(parsed.value));
        const b = outcome(() => nodeUrl.format(parsed.value));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("resolve matches node:url.resolve", () => {
    fc.assert(
      fc.property(urlStr, urlStr, (from, to) => {
        // Same leniency divergence as parse: node throws on invalid inputs
        // unenv resolves anyway — see regression file.
        const b = outcome(() => nodeUrl.resolve(from, to));
        fc.pre(!b.threw);
        const a = outcome(() => shim.resolve(from, to));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("domainToASCII / domainToUnicode match node:url", () => {
    fc.assert(
      fc.property(fc.domain(), (domain) => {
        const asciiA = outcome(() => shim.domainToASCII(domain));
        const asciiB = outcome(() => nodeUrl.domainToASCII(domain));
        expectSameOutcome(asciiA, asciiB);
        const uniA = outcome(() => shim.domainToUnicode(domain));
        const uniB = outcome(() => nodeUrl.domainToUnicode(domain));
        expectSameOutcome(uniA, uniB);
      }),
      fcParams(),
    );
  });

  it("fileURLToPath matches node:url.fileURLToPath", () => {
    const fileUrl = fc.oneof(
      fc.webUrl().map((u) => `file://${new URL(u).pathname}`),
      messyUrl.map((p) => `file:///${p}`),
      urlStr,
    );
    fc.assert(
      fc.property(fileUrl, (u) => {
        const a = outcome(() => shim.fileURLToPath(u));
        const b = outcome(() => nodeUrl.fileURLToPath(u));
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("pathToFileURL matches node:url.pathToFileURL", () => {
    fc.assert(
      fc.property(messyUrl, (p) => {
        // node %-encodes [, ] and | in the path; unenv emits them literally.
        // unenv also trims trailing whitespace off the path where node
        // encodes it as %20. See regressions file.
        fc.pre(!/[\[\]|]/.test(p) && !/\s$/.test(p));
        const a = outcome(() => shim.pathToFileURL(p).href);
        const b = outcome(() => nodeUrl.pathToFileURL(p).href);
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("URL constructor matches node:url.URL (same globalThis class)", () => {
    fc.assert(
      fc.property(urlStr, (s) => {
        const a = outcome(() => new shim.URL(s).href);
        const b = outcome(() => new nodeUrl.URL(s).href);
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });

  it("URLSearchParams matches node:url.URLSearchParams (same globalThis class)", () => {
    const queryStr = fc
      .array(
        fc.constantFrom("a=1", "b=2", "k", "=v", "a=", "x%20y=z", "a+b=c", "%E9=%C3", "k💩=v"),
        {
          maxLength: 6,
        },
      )
      .map((parts) => parts.join("&"));
    fc.assert(
      fc.property(queryStr, (q) => {
        const a = outcome(() => new shim.URLSearchParams(q).toString());
        const b = outcome(() => new nodeUrl.URLSearchParams(q).toString());
        expectSameOutcome(a, b);
      }),
      fcParams(),
    );
  });
});
