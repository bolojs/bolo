// node:tls shim — behaviorally honest skeleton.
//
// Pure-JS surface (constants, ALPN protocol conversion, certificate identity
// checking, secure-context option holding, the legacy deprecated exports with
// their exact Node 22 warning codes/messages) is ported from Node 22
// lib/tls.js and lib/internal/tls/*. Anything that needs a real TLS handshake
// (connect, server listen/accept) throws ERR_BOL_UNSUPPORTED_TLS_BACKEND —
// WebSocket and fetch give the browser TLS, but there is no way to run a raw
// TLS session over an arbitrary transport without an injected tlsBackend.

import { EventEmitter } from "./events.js";
import { Buffer } from "./internal/binary.js";
import { unsupportedError } from "./coded-error.js";

interface NodeError extends Error {
  code: string;
}

const nodeError = (code: string, message: string): NodeError =>
  Object.assign(new Error(message), { code });

const notImplemented = (what: string): NodeError =>
  unsupportedError(
    "TLS_BACKEND",
    `${what} requires a TLS backend: TLS handshakes over an arbitrary transport have no ` +
      `Web API equivalent. Register one via createLiveShimRegistry({ tlsBackend })`,
  ) as NodeError;

// process.emitWarning calls go through globalThis so the module also works
// outside Node (where the warning is silently dropped).
const emitWarning = (message: string, type: string, code: string): void => {
  const proc = globalThis.process;
  if (typeof proc?.emitWarning === "function") proc.emitWarning(message, type, code);
};

const deprecate = <F extends (...fnArgs: never[]) => unknown>(
  fn: F,
  message: string,
  code: string,
): F => {
  let warned = false;
  return function (this: unknown, ...args: never[]) {
    if (!warned) {
      warned = true;
      emitWarning(message, "DeprecationWarning", code);
    }
    return fn.apply(this, args);
  } as F;
};

// --- Constants (Node 22 defaults, lib/tls.js) ---

export const CLIENT_RENEG_LIMIT = 3;
export const CLIENT_RENEG_WINDOW = 600;

// The OpenSSL 3 default cipher list Node 22 uses when --tls-cipher-list is
// not given. Kept as a plain string constant; it documents intent only —
// no handshake in the browser will ever negotiate these.
export const DEFAULT_CIPHERS =
  "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256" +
  ":ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256" +
  ":ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384" +
  ":ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-CHACHA20-POLY1305" +
  ":AES128-GCM-SHA256:AES256-GCM-SHA384";

export const DEFAULT_ECDH_CURVE = "auto";

// Mutable like in Node (test-tls-ticket-12.js assigns tls.DEFAULT_MAX_VERSION).
export let DEFAULT_MIN_VERSION = "TLSv1.2";
export let DEFAULT_MAX_VERSION = "TLSv1.3";

// No OpenSSL in the browser, so there is no bundled CA store and no cipher
// enumeration. Both are frozen empty arrays rather than faked content.
export const rootCertificates: readonly string[] = Object.freeze([]);

export const getCiphers = (): readonly string[] => Object.freeze([]);

// --- Pure-JS ports from Node 22 lib/tls.js ---

// Convert protocols array into valid OpenSSL protocols list
// ("\x06spdy/2\x08http/1.1\x08http/1.0")
const convertProtocols = (protocols: string[]): Buffer => {
  const lens: number[] = [];
  const buff = Buffer.allocUnsafe(
    protocols.reduce((p, c, i) => {
      const len = Buffer.byteLength(c);
      if (len > 255) {
        const err = nodeError(
          "ERR_OUT_OF_RANGE",
          `The byte length of the protocol at index ${i} exceeds the maximum length. It must be <= 255. Received ${len}`,
        );
        throw err;
      }
      lens[i] = len;
      return p + 1 + len;
    }, 0),
  );

  let offset = 0;
  for (let i = 0; i < protocols.length; i++) {
    buff[offset++] = lens[i];
    buff.write(protocols[i], offset);
    offset += lens[i];
  }

  return buff;
};

interface ALPNOut {
  ALPNProtocols?: Buffer;
}

export const convertALPNProtocols = (
  protocols: string[] | Uint8Array | ArrayBufferView,
  out: ALPNOut,
): void => {
  if (Array.isArray(protocols)) {
    out.ALPNProtocols = convertProtocols(protocols);
  } else if (protocols instanceof Uint8Array) {
    // Copy new buffer not to be modified by user.
    out.ALPNProtocols = Buffer.from(protocols);
  } else if (ArrayBuffer.isView(protocols)) {
    out.ALPNProtocols = Buffer.from(
      protocols.buffer.slice(protocols.byteOffset, protocols.byteOffset + protocols.byteLength),
    );
  }
};

const unfqdn = (host: string): string => host.replace(/[.]$/, "");

// String#toLowerCase() is locale-sensitive so we use a conservative version
// that only lowercases A-Z (as Node does).
const toLowerCase = (c: string): string => String.fromCharCode(32 + c.charCodeAt(0));

const splitHost = (host: string): string[] =>
  unfqdn(host).replace(/[A-Z]/g, toLowerCase).split(".");

const check = (hostParts: string[], pattern: string, wildcards: boolean): boolean => {
  if (!pattern) return false;

  const patternParts = splitHost(pattern);

  if (hostParts.length !== patternParts.length) return false;

  // Pattern has empty components, e.g. "bad..example.com".
  if (patternParts.includes("")) return false;

  // RFC 6125 allows IDNA U-labels (Unicode) in names but we have no good way
  // to detect their encoding or normalize them so we simply reject them.
  const isBad = (s: string): boolean => /[^\u0021-\u007F]/u.test(s);
  if (patternParts.some(isBad)) return false;

  // Check host parts from right to left first.
  for (let i = hostParts.length - 1; i > 0; i -= 1) {
    if (hostParts[i] !== patternParts[i]) return false;
  }

  const hostSubdomain = hostParts[0];
  const patternSubdomain = patternParts[0];
  const patternSubdomainParts = patternSubdomain.split("*");

  // Short-circuit when the subdomain does not contain a wildcard.
  if (patternSubdomainParts.length === 1 || patternSubdomain.includes("xn--"))
    return hostSubdomain === patternSubdomain;

  if (!wildcards) return false;

  // More than one wildcard is always wrong.
  if (patternSubdomainParts.length > 2) return false;

  // *.tld wildcards are not allowed.
  if (patternParts.length <= 2) return false;

  const [prefix, suffix] = patternSubdomainParts;

  if (prefix.length + suffix.length > hostSubdomain.length) return false;
  if (!hostSubdomain.startsWith(prefix)) return false;
  if (!hostSubdomain.endsWith(suffix)) return false;

  return true;
};

const netIsIP = (value: string): number => {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value))
    return value.split(".").every((o) => Number(o) <= 255) ? 4 : 0;
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":") ? 6 : 0;
};

// Minimal stand-in for internalBinding('cares_wrap').canonicalizeIP: IPv4
// stays as-is, IPv4-mapped IPv6 loses its ::ffff: prefix.
const canonicalizeIP = (ip: string): string => {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
};

export interface PeerCertificate {
  subject?: { CN?: string | string[] };
  subjectaltname?: string;
  [key: string]: unknown;
}

export interface CertificateIdentityError extends NodeError {
  reason: string;
  host: string;
  cert: PeerCertificate;
}

export const checkServerIdentity = (
  hostname: string,
  cert: PeerCertificate,
): CertificateIdentityError | undefined => {
  const subject = cert.subject;
  const altNames = cert.subjectaltname;
  const dnsNames: string[] = [];
  const ips: string[] = [];

  hostname = "" + hostname;

  if (altNames) {
    const splitAltNames = altNames.includes('"')
      ? // Escaped-sequence handling from lib/tls.js is only reachable with
        // OpenSSL-produced altName strings containing quotes; plain split
        // covers the browser case.
        altNames.split(/",?\s*|,\s*"/).map((s) => s.replace(/^"|"$/g, ""))
      : altNames.split(", ");
    for (const name of splitAltNames) {
      if (name.startsWith("DNS:")) {
        dnsNames.push(name.slice(4));
      } else if (name.startsWith("IP Address:")) {
        ips.push(canonicalizeIP(name.slice(11)));
      }
    }
  }

  let valid = false;
  let reason = "Unknown reason";

  hostname = unfqdn(hostname); // Remove trailing dot for error messages.

  if (netIsIP(hostname)) {
    valid = ips.includes(canonicalizeIP(hostname));
    if (!valid) reason = `IP: ${hostname} is not in the cert's list: ${ips.join(", ")}`;
  } else if (dnsNames.length > 0 || subject?.CN) {
    const hostParts = splitHost(hostname);
    const wildcard = (pattern: string): boolean => check(hostParts, pattern, true);

    if (dnsNames.length > 0) {
      valid = dnsNames.some(wildcard);
      if (!valid) reason = `Host: ${hostname}. is not in the cert's altnames: ${altNames}`;
    } else {
      // Match against Common Name only if no supported identifiers exist.
      const cn = subject!.CN;

      if (Array.isArray(cn)) valid = cn.some(wildcard);
      else if (cn) valid = wildcard(cn);

      if (!valid) reason = `Host: ${hostname}. is not cert's CN: ${cn}`;
    }
  } else {
    reason = "Cert does not contain a DNS name";
  }

  if (!valid) {
    const err = nodeError(
      "ERR_TLS_CERT_ALTNAME_INVALID",
      `Hostname/IP does not match certificate's altnames: ${reason}`,
    ) as CertificateIdentityError;
    err.reason = reason;
    err.host = hostname;
    err.cert = cert;
    return err;
  }
  return undefined;
};

// --- SecureContext / TLSSocket / Server ---

export interface SecureContextOptions {
  key?: unknown;
  cert?: unknown;
  ca?: unknown;
  passphrase?: string;
  [key: string]: unknown;
}

/**
 * A real context-options holder — everything passed to createSecureContext
 * is kept, but there is no backing SSL_CTX because no handshake can run
 * without a tlsBackend.
 */
export class SecureContext {
  context: SecureContextOptions;

  constructor(options?: SecureContextOptions) {
    this.context = { ...options };
  }
}

export const createSecureContext = (options?: SecureContextOptions): SecureContext =>
  new SecureContext(options);

/** Duplex-ish TLS socket shape. Any operation needing a live TLS session
 * throws ERR_BOL_UNSUPPORTED_TLS_BACKEND; the class exists so instanceof/shape checks
 * and legacy createSecurePair callers keep working. */
export class TLSSocket extends EventEmitter {
  encrypted = true;
  authorized = false;
  destroyed = false;

  constructor(_options?: unknown) {
    super();
  }

  getProtocol = (): null => null;
  getCipher = (): null => null;
  getPeerCertificate = (): Record<string, never> => ({});
  renegotiate = (): void => {
    throw notImplemented("tls.TLSSocket#renegotiate()");
  };
  destroy = (): void => {
    this.destroyed = true;
  };
}

export interface TlsServerOptions {
  [key: string]: unknown;
}

export class Server extends EventEmitter {
  constructor(options?: TlsServerOptions, listener?: (...args: unknown[]) => void) {
    super();
    if (listener) this.on("connection", listener);
    void options;
  }

  listen = (): never => {
    throw notImplemented("tls.Server.listen()");
  };

  close = (callback?: (err?: Error) => void): void => {
    if (callback) queueMicrotask(callback);
  };

  address = (): null => null;
}

export const createServer = (
  options?: TlsServerOptions,
  listener?: (...args: unknown[]) => void,
): Server => new Server(options, listener);

/**
 * tls.connect() — argument shape follows Node (port number or options
 * object), then fails honestly: opening a TLS session over an arbitrary
 * transport is impossible in the browser.
 */
export const connect = (...args: unknown[]): never => {
  const [first] = args;
  if (typeof first === "number") {
    if (!Number.isInteger(first) || first < 0 || first > 65535) {
      throw nodeError("ERR_SOCKET_BAD_PORT", `Port should be >= 0 and < 65536. Received ${first}`);
    }
  } else if (first === undefined || first === null) {
    throw nodeError("ERR_INVALID_ARG_TYPE", 'The "options" argument must be an object');
  }
  throw notImplemented("tls.connect()");
};

// --- Legacy deprecated exports (exact Node 22 codes/messages) ---

const securePairDeprecate = deprecate(
  (
    options?: unknown,
    secureConnectListener?: () => void,
  ): {
    cleartext: TLSSocket;
    encrypted: InstanceType<typeof EventEmitter>;
  } => {
    void options;
    const cleartext = new TLSSocket();
    if (secureConnectListener) cleartext.on("secureConnect", secureConnectListener);
    // The encrypted side is the raw transport stream in Node; here it is a
    // bare EventEmitter placeholder that can never carry data.
    const encrypted = new EventEmitter();
    return { cleartext, encrypted };
  },
  "tls.createSecurePair() is deprecated. Please use tls.TLSSocket instead.",
  "DEP0064",
);

export const createSecurePair = securePairDeprecate;

// lib/_tls_common.js (reachable via the legacy `tls` surface), DEP0123.
export const parseCertString = deprecate(
  (s: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of s.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  },
  "tls.parseCertString() is deprecated. Please use querystring.parse() instead.",
  "DEP0123",
);

// --- Shim assembly ---

const tls = {
  CLIENT_RENEG_LIMIT,
  CLIENT_RENEG_WINDOW,
  DEFAULT_CIPHERS,
  DEFAULT_ECDH_CURVE,
  SecureContext,
  Server,
  TLSSocket,
  checkServerIdentity,
  connect,
  convertALPNProtocols,
  createSecureContext,
  createSecurePair,
  createServer,
  getCiphers,
  parseCertString,
  rootCertificates,
};

// Live get/set so `tls.DEFAULT_MAX_VERSION = 'TLSv1.2'` (test-tls-ticket-12.js)
// round-trips like it does in Node.
Object.defineProperties(tls, {
  DEFAULT_MIN_VERSION: {
    enumerable: true,
    get: () => DEFAULT_MIN_VERSION,
    set: (v: string) => {
      DEFAULT_MIN_VERSION = v;
    },
  },
  DEFAULT_MAX_VERSION: {
    enumerable: true,
    get: () => DEFAULT_MAX_VERSION,
    set: (v: string) => {
      DEFAULT_MAX_VERSION = v;
    },
  },
});

export const createTlsShim = (): typeof tls => tls;

export default createTlsShim();
