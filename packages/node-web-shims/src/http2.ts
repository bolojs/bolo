import _http2 from "unenv/node/http2";

export * from "unenv/node/http2";

const http2 = _http2 as unknown as {
  connect: () => unknown;
  createServer: () => unknown;
  createSecureServer: () => unknown;
  performServerHandshake: () => unknown;
};

/**
 * HTTP/2 needs ALPN-negotiated TLS (h2 over cleartext TCP upgrade is not what
 * axios/undici use), and browsers expose no API for either — fetch's HTTP/2
 * is managed entirely by the network stack. Session entry points therefore
 * cannot work; they throw Node-coded "unavailable on this platform" errors
 * rather than unenv's plain not-implemented so callers that sniff
 * `err.code` behave the same as on Node.
 *
 * Everything else packages touch at import time stays resolvable:
 * `constants`, `getDefaultSettings`/`getPackedSettings`/`getUnpackedSettings`,
 * the `Http2ServerRequest`/`Http2ServerResponse` class refs, and
 * `sensitiveHeaders` — enough for conditional http2 branches (axios only
 * imports `node:http2` for its h2 detection constant).
 */
const platformGap = (name: string) => () => {
  throw Object.assign(
    new Error(
      `http2.${name} is unavailable in the browser runtime: HTTP/2 requires ` +
        "ALPN-negotiated TLS/raw sockets, which browsers do not expose.",
    ),
    { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" },
  );
};

export const connect: typeof http2.connect = platformGap("connect");
export const createServer: typeof http2.createServer = platformGap("createServer");
export const createSecureServer: typeof http2.createSecureServer =
  platformGap("createSecureServer");
export const performServerHandshake: typeof http2.performServerHandshake =
  platformGap("performServerHandshake");

export const createHttp2Shim = (): typeof http2 => ({
  ...http2,
  connect,
  createServer,
  createSecureServer,
  performServerHandshake,
});

export default createHttp2Shim();
