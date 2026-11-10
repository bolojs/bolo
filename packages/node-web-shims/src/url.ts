import querystringDefault from "./querystring.js";
import punycodeDefault from "./punycode.js";
import { posix as posixPath, win32 as win32Path } from "./path-node.js";

// unenv types its default exports as `{}` — assert the real module shapes.
const querystring = querystringDefault as unknown as typeof import("node:querystring");
const punycode = punycodeDefault as unknown as typeof import("node:punycode");

// This module is deliberately self-contained: unenv's `node:url` does
// `import * as querystring from "node:querystring"` at module scope, which
// lands as a dead `browser_external_node_querystring` namespace in consumer
// bundles and breaks `url.parse`/`url.format` with
// `.parse/.stringify is not a function`. Importing our own querystring,
// punycode and path shims via relative paths avoids the `node:` specifier
// entirely.

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

const PROTOCOL_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/;
const HOSTLESS_PROTOCOLS = new Set(["javascript:", "javascript"]);
const SLASHED_PROTOCOLS = new Set(["http:", "https:", "ftp:", "gopher:", "file:", "ws:", "wss:"]);
// Characters that can terminate the authority section of a URL.
const AUTHORITY_END = /[/\\?#;]/;
// Node only probes for an authority in `//…` input without a protocol or
// slashesDenoteHost when it contains an auth marker (`//user@host`).
const HOST_PATTERN = /^\/\/[^/@]+@[^/@]+/;

const codedError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

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

const parseHost = (
  authority: string,
): { auth: string | null; host: string; hostname: string; port: string | null } => {
  let auth: string | null = null;
  let host = authority;
  const at = host.lastIndexOf("@");
  if (at !== -1) {
    auth = decodeURIComponentSafe(host.slice(0, at));
    host = host.slice(at + 1);
  }
  let hostname = host;
  let port: string | null = null;
  if (host.startsWith("[")) {
    // IPv6 literal — port follows the closing bracket.
    const close = host.indexOf("]");
    if (close !== -1) {
      hostname = host.slice(0, close + 1);
      if (host[close + 1] === ":") port = host.slice(close + 2) || null;
    }
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1) {
      hostname = host.slice(0, colon);
      port = host.slice(colon + 1) || null;
    }
  }
  return { auth, host, hostname: hostname.toLowerCase(), port };
};

const decodeURIComponentSafe = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Legacy `url.parse` — returns a `Url`-shaped object like Node's. Tolerates
 * relative and protocol-relative input (unlike WHATWG `URL`), matching Node's
 * permissive behaviour.
 */
export class Url implements UrlObject {
  protocol: string | null = null;
  slashes: boolean | null = null;
  auth: string | null = null;
  host: string | null = null;
  port: string | null = null;
  hostname: string | null = null;
  hash: string | null = null;
  search: string | null = null;
  query: string | Record<string, unknown> | null = null;
  pathname: string | null = null;
  path: string | null = null;
  href: string | null = null;

  parse(urlString: string, parseQueryString = false, slashesDenoteHost = false): this {
    if (typeof urlString !== "string") {
      throw codedError("ERR_INVALID_ARG_TYPE", 'The "url" argument must be of type string');
    }
    let rest = urlString;

    // Fragment — everything after the first '#'.
    const hashIdx = rest.indexOf("#");
    if (hashIdx !== -1) {
      this.hash = rest.slice(hashIdx);
      rest = rest.slice(0, hashIdx);
    }

    // Protocol.
    const protoMatch = PROTOCOL_PATTERN.exec(rest);
    if (protoMatch) {
      this.protocol = protoMatch[1].toLowerCase();
      rest = rest.slice(protoMatch[1].length);
    }

    // Slashes — consumed only when denoted, a protocol was given, or the
    // input clearly carries an authority (`//auth@host`).
    if (slashesDenoteHost || this.protocol !== null || HOST_PATTERN.test(rest)) {
      if (rest.startsWith("//") && !HOSTLESS_PROTOCOLS.has(this.protocol ?? "")) {
        this.slashes = true;
        rest = rest.slice(2);
      }
    }
    // Authority — taken when slashes were consumed, or the protocol is one
    // that doesn't conventionally write `//` (`foo:host/path`).
    if (
      !HOSTLESS_PROTOCOLS.has(this.protocol ?? "") &&
      (this.slashes === true || (this.protocol !== null && !SLASHED_PROTOCOLS.has(this.protocol)))
    ) {
      const end = rest.search(AUTHORITY_END);
      const authority = end === -1 ? rest : rest.slice(0, end);
      rest = end === -1 ? "" : rest.slice(end);
      const { auth, host, hostname, port } = parseHost(authority);
      this.auth = auth;
      this.host = host || null;
      this.hostname = hostname || null;
      this.port = port;
    }

    // Query string — everything after the first '?' in what remains.
    const qIdx = rest.indexOf("?");
    if (qIdx !== -1) {
      this.search = rest.slice(qIdx);
      const queryStr = rest.slice(qIdx + 1);
      this.query = parseQueryString ? querystring.parse(queryStr) : queryStr;
      rest = rest.slice(0, qIdx);
    } else if (parseQueryString) {
      this.query = {};
    }

    this.pathname = rest;
    this.path = rest + (this.search ?? "");
    this.href = this.format();
    return this;
  }

  format(): string {
    return urlFormat(this);
  }

  resolve(to: string): string {
    return urlResolve(this.href ?? this.format(), to);
  }

  resolveObject(to: string): Url {
    return urlParse(urlResolve(this.href ?? this.format(), to));
  }
}

const urlParse = (urlString: string, parseQueryString = false, slashesDenoteHost = false): Url =>
  new Url().parse(urlString, parseQueryString, slashesDenoteHost);

const isWhatwgUrl = (v: unknown): v is URL =>
  v instanceof URL ||
  (typeof v === "object" && v !== null && typeof (v as URL).origin === "string");

/**
 * Legacy `url.format` — accepts Url-like objects and WHATWG URL instances.
 */
const urlFormat = (urlObject: UrlObject | URL | string): string => {
  if (typeof urlObject === "string") return urlFormat(urlParse(urlObject));
  if (isWhatwgUrl(urlObject)) return urlObject.href;

  let auth = urlObject.auth || "";
  if (auth) {
    auth = encodeURIComponent(auth).replace(/%3A/gi, ":");
    auth += "@";
  }

  let protocol = urlObject.protocol || "";
  let pathname = urlObject.pathname || "";
  let hash = urlObject.hash || "";
  let host: string | false = false;
  let query = "";

  if (typeof urlObject.host === "string" && urlObject.host.length > 0) {
    host = auth + urlObject.host;
  } else if (typeof urlObject.hostname === "string" && urlObject.hostname.length > 0) {
    host = auth + urlObject.hostname + (urlObject.port ? `:${urlObject.port}` : "");
  }

  if (urlObject.query != null && typeof urlObject.query === "object") {
    query = querystring.stringify(urlObject.query as Parameters<typeof querystring.stringify>[0]);
  }

  let search = urlObject.search || (query ? `?${query}` : "");

  if (protocol && !protocol.endsWith(":")) protocol += ":";

  // `//` is emitted when slashes were written, or the protocol always takes
  // them and there's a host to attach them to.
  if (urlObject.slashes || ((!protocol || SLASHED_PROTOCOLS.has(protocol)) && host !== false)) {
    host = `//${host || ""}`;
    if (pathname && !pathname.startsWith("/")) pathname = `/${pathname}`;
  } else if (host === false) {
    host = "";
  }

  if (hash && !hash.startsWith("#")) hash = `#${hash}`;
  if (search && !search.startsWith("?")) search = `?${search}`;

  pathname = pathname.replace(/[?#]/g, (c) => encodeURIComponent(c));
  search = search.replace(/#/g, "%23");

  return protocol + host + pathname + search + hash;
};

const DUMMY_ORIGIN = "http://__url_resolve__";

/**
 * Legacy `url.resolve(from, to)`. Uses WHATWG resolution against a synthetic
 * origin when `from` has no scheme so relative inputs still resolve.
 */
const urlResolve = (from: string, to: string): string => {
  const toStr = String(to);
  const fromStr = String(from);
  if (PROTOCOL_PATTERN.test(toStr)) {
    try {
      return new URL(toStr).href;
    } catch {
      return toStr;
    }
  }
  const fromHasProto = PROTOCOL_PATTERN.test(fromStr);
  const base = fromHasProto
    ? fromStr
    : `${DUMMY_ORIGIN}${fromStr.startsWith("/") ? "" : "/"}${fromStr}`;
  try {
    const resolved = new URL(toStr, base).href;
    return fromHasProto ? resolved : resolved.slice(DUMMY_ORIGIN.length);
  } catch {
    return toStr;
  }
};

const urlResolveObject = (from: string, to: string): Url => urlParse(urlResolve(from, to));

export {
  urlParse as parse,
  urlResolve as resolve,
  urlResolveObject as resolveObject,
  urlFormat as format,
};

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
  parse: urlParse,
  resolve: urlResolve,
  resolveObject: urlResolveObject,
  format: urlFormat,
  URL,
  URLSearchParams,
  domainToASCII,
  domainToUnicode,
  pathToFileURL,
  fileURLToPath,
  urlToHttpOptions,
};

/**
 * Creates a node:url shim — a self-contained legacy `Url`/`parse`/`format`/
 * `resolve` implementation wired to the package's own querystring and
 * punycode shims (unenv's version breaks because it imports
 * `node:querystring` internally).
 */
export const createUrlShim = (): typeof url => {
  return url;
};

export default createUrlShim();
