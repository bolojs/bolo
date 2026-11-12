import { describe, it, expect } from "vitest";
import { createTlsShim, TLSSocket, SecureContext } from "../src/tls.ts";

// process.emitWarning delivers warnings asynchronously via the 'warning'
// event (next tick), mirroring how Node reports them.
const captureWarnings = async (fn: () => void): Promise<Error[]> => {
  const warnings: Error[] = [];
  const onWarning = (w: Error) => warnings.push(w);
  process.on("warning", onWarning);
  try {
    fn();
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off("warning", onWarning);
  }
  return warnings;
};

describe("node-web-shims: tls", () => {
  it("should match node:tls type shape", () => {
    const shim = createTlsShim();
    const _nodeTls = shim as unknown as typeof import("node:tls");
    expect(_nodeTls).toBeDefined();
  });

  it("exposes Node 22 default constants", () => {
    const tls = createTlsShim();
    expect(tls.DEFAULT_MIN_VERSION).toBe("TLSv1.2");
    expect(tls.DEFAULT_MAX_VERSION).toBe("TLSv1.3");
    expect(tls.DEFAULT_ECDH_CURVE).toBe("auto");
    expect(typeof tls.DEFAULT_CIPHERS).toBe("string");
    expect(tls.CLIENT_RENEG_LIMIT).toBe(3);
    expect(tls.CLIENT_RENEG_WINDOW).toBe(600);
    expect(Array.isArray(tls.rootCertificates)).toBe(true);
    expect(Array.isArray(tls.getCiphers())).toBe(true);
  });

  it("DEFAULT_MAX_VERSION is assignable (test-tls-ticket-12.js)", () => {
    const tls = createTlsShim();
    tls.DEFAULT_MAX_VERSION = "TLSv1.2";
    expect(tls.DEFAULT_MAX_VERSION).toBe("TLSv1.2");
    tls.DEFAULT_MAX_VERSION = "TLSv1.3";
  });

  it("createSecurePair() emits the DEP0064 deprecation warning and returns a pair", async () => {
    const tls = createTlsShim();
    let pair: { cleartext: unknown; encrypted: unknown } | undefined;
    const warnings = await captureWarnings(() => {
      pair = tls.createSecurePair();
    });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatchObject({
      name: "DeprecationWarning",
      message: "tls.createSecurePair() is deprecated. Please use tls.TLSSocket instead.",
      code: "DEP0064",
    });
    expect(pair).toBeDefined();
    expect(pair!.cleartext).toBeInstanceOf(TLSSocket);
    expect(pair!.encrypted).toBeDefined();
  });

  it("parseCertString() emits the DEP0123 deprecation warning", async () => {
    const tls = createTlsShim();
    let parsed: Record<string, string> | undefined;
    const warnings = await captureWarnings(() => {
      parsed = tls.parseCertString("CN=example.com\nO=Example");
    });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatchObject({
      name: "DeprecationWarning",
      message:
        "tls.parseCertString() is deprecated. Please use querystring.parse() instead.",
      code: "DEP0123",
    });
    expect(parsed).toEqual({ CN: "example.com", O: "Example" });
  });

  it("createSecureContext() returns a SecureContext holding the options", () => {
    const tls = createTlsShim();
    const ctx = tls.createSecureContext({ key: "k", cert: "c" });
    expect(ctx).toBeInstanceOf(SecureContext);
    expect(ctx.context).toMatchObject({ key: "k", cert: "c" });
  });

  it("convertALPNProtocols() builds the OpenSSL length-prefixed buffer", () => {
    const tls = createTlsShim();
    const out: { ALPNProtocols?: Uint8Array } = {};
    tls.convertALPNProtocols(["h2", "http/1.1"], out);
    expect(Array.from(out.ALPNProtocols ?? [])).toEqual([
      2, 0x68, 0x32, // \x02h2
      8, 0x68, 0x74, 0x74, 0x70, 0x2f, 0x31, 0x2e, 0x31, // \x08http/1.1
    ]);
  });

  it("checkServerIdentity() validates hostnames against cert altNames", () => {
    const tls = createTlsShim();
    const cert = { subjectaltname: "DNS:example.com, DNS:*.example.org" };
    expect(tls.checkServerIdentity("example.com", cert)).toBeUndefined();
    expect(tls.checkServerIdentity("www.example.org", cert)).toBeUndefined();
    const err = tls.checkServerIdentity("evil.test", cert);
    expect(err).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(err?.host).toBe("evil.test");
    expect(tls.checkServerIdentity("example.com", { subject: { CN: "example.com" } })).toBeUndefined();
  });

  it("connect() validates arguments then throws ERR_NOT_IMPLEMENTED", () => {
    const tls = createTlsShim();
    expect(() => tls.connect(443, "example.com")).toThrowError(
      expect.objectContaining({ code: "ERR_NOT_IMPLEMENTED" }) as Error,
    );
    expect(() => tls.connect(99999)).toThrowError(
      expect.objectContaining({ code: "ERR_SOCKET_BAD_PORT" }) as Error,
    );
  });

  it("createServer() returns a Server whose listen() throws ERR_NOT_IMPLEMENTED", () => {
    const tls = createTlsShim();
    const server = tls.createServer({});
    expect(server).toBeDefined();
    expect(() => server.listen(443)).toThrowError(
      expect.objectContaining({ code: "ERR_NOT_IMPLEMENTED" }) as Error,
    );
  });
});
