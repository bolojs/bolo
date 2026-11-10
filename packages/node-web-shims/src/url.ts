import punycodeDefault from "./punycode.js";
import { posix as posixPath, win32 as win32Path } from "./path-node.js";
import {
  Url as VendoredUrl,
  urlFormat,
  urlParse,
  urlResolve,
  urlResolveObject,
} from "./url-node.js";

// unenv types its default exports as `{}` — assert the real module shapes.
const punycode = punycodeDefault as unknown as typeof import("node:punycode");

// This module is deliberately self-contained: unenv's `node:url` does
// `import * as querystring from "node:querystring"` at module scope, which
// lands as a dead `browser_external_node_querystring` namespace in consumer
// bundles and breaks `url.parse`/`url.format` with
// `.parse/.stringify is not a function`. The legacy Url/parse/format/resolve
// surface is a vendored port of Node's own lib/url.js in ./url-node.js
// (the same approach path.ts/path-node.ts take with lib/path.js), wired to
// the package's own querystring and punycode shims via relative paths so the
// `node:` specifier is never emitted.

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export interface UrlObject {
  protocol?: string | null;
  slashes?: boolean | null;
  auth?: string | null;
  host?: string | null;
  port?: string | null;
  hostname?: string | null;
  hash?: string | null;
  search?: string | null;
  query?: string | Record<string, unknown> | null;
  pathname?: string | null;
  path?: string | null;
  href?: string | null;
}

/**
 * Legacy `Url` class — the real implementation vendored from Node's
 * lib/url.js (see ./url-node.ts).
 */
export const Url = VendoredUrl as unknown as {
  new (): import("node:url").Url;
};

const parse = urlParse as typeof import("node:url").parse;
const format = urlFormat as typeof import("node:url").format;
const resolve = urlResolve as typeof import("node:url").resolve;
const resolveObject = urlResolveObject as (from: string, to: string) => UrlObject;

export { parse, resolve, resolveObject, format };

// --- file URL helpers (posix-focused, like unenv's) ---

const encodePathChars = (p: string, windows: boolean): string =>
  p
    .replace(/%/g, "%25")
    .replace(/\\/g, windows ? "/" : "%5C")
    .replace(/\n/g, "%0A")
    .replace(/\r/g, "%0D")
    .replace(/\t/g, "%09")
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");

export const pathToFileURL = (filepath: string, options?: { windows?: boolean }): URL => {
  const windows = options?.windows === true;
  if (windows && filepath.startsWith("\\\\")) {
    // \\server\share\resource → file://server/share/resource
    const prefixLen = filepath.startsWith("\\\\?\\UNC\\") ? 8 : 2;
    const hostEnd = filepath.indexOf("\\", prefixLen);
    if (hostEnd === -1) {
      throw codedError(
        "ERR_INVALID_ARG_VALUE",
        `The argument 'path' is invalid. Received '${filepath}'`,
      );
    }
    const outURL = new URL("file://");
    outURL.hostname = punycode.toASCII(filepath.slice(prefixLen, hostEnd));
    outURL.pathname = encodePathChars(filepath.slice(hostEnd).replace(/\\/g, "/"), true);
    return outURL;
  }
  let resolved = windows ? win32Path.resolve(filepath) : posixPath.resolve(filepath);
  const last = filepath.charCodeAt(filepath.length - 1);
  if ((last === 47 /* / */ || (windows && last === 92)) && !resolved.endsWith("/")) {
    resolved += "/";
  }
  return new URL(`file://${encodePathChars(resolved, windows)}`);
};

const codedError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

export const fileURLToPath = (url: URL | string): string => {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "file:") {
    throw codedError("ERR_INVALID_URL_SCHEME", `The URL must be of scheme file`);
  }
  if (u.hostname && u.hostname !== "localhost") {
    throw codedError("ERR_INVALID_FILE_URL_HOST", `File URL host must be "localhost" or empty`);
  }
  const pathname = u.pathname;
  // Guard against encoded separators smuggling path structure.
  for (let i = 0; i < pathname.length - 2; i++) {
    if (pathname[i] === "%" && Number.parseInt(pathname.slice(i + 1, i + 3), 16) === 0x2f) {
      throw codedError(
        "ERR_INVALID_FILE_URL_PATH",
        "File URL path must not include encoded / characters",
      );
    }
  }
  return decodeURIComponent(pathname);
};

export interface HttpOptions {
  protocol?: string;
  hostname?: string;
  hash?: string;
  search?: string;
  pathname?: string;
  path?: string;
  href?: string;
  port?: number;
  auth?: string;
}

export const urlToHttpOptions = (url: URL): HttpOptions => {
  const options: HttpOptions = {
    protocol: url.protocol,
    hostname:
      url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ""}${url.search || ""}`,
    href: url.href,
  };
  if (url.port !== "") options.port = Number(url.port);
  if (url.username !== "" || url.password !== "") {
    options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  }
  return options;
};

export const domainToASCII = (domain: string): string => {
  if (domain === "" || domain === undefined || domain === null) return "";
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return "";
  }
};

export const domainToUnicode = (domain: string): string =>
  punycode.toUnicode(domainToASCII(domain));

const url = {
  Url,
  parse,
  resolve,
  resolveObject,
  format,
  URL,
  URLSearchParams,
  domainToASCII,
  domainToUnicode,
  pathToFileURL,
  fileURLToPath,
  urlToHttpOptions,
};

/**
 * Creates a node:url shim — the legacy `Url`/`parse`/`format`/`resolve`
 * surface is a faithful vendored port of Node's lib/url.js (./url-node.ts);
 * file-URL helpers, domain conversion and `urlToHttpOptions` are local
 * implementations.
 */
export const createUrlShim = (): typeof url => {
  return url;
};

export default createUrlShim();
