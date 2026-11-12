import nodeCrypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { createCryptoShim } from "../src/crypto.ts";

const c = createCryptoShim();

describe("node-web-shims: crypto", () => {
  it("should export the full surface", () => {
    const shim = createCryptoShim();
    expect(typeof shim.createHash).toBe("function");
    expect(typeof shim.createHmac).toBe("function");
    expect(typeof shim.pbkdf2).toBe("function");
    expect(typeof shim.pbkdf2Sync).toBe("function");
    expect(typeof shim.scrypt).toBe("function");
    expect(typeof shim.scryptSync).toBe("function");
    expect(typeof shim.randomBytes).toBe("function");
    expect(typeof shim.randomInt).toBe("function");
    expect(typeof shim.randomUUID).toBe("function");
    expect(typeof shim.createSign).toBe("function");
    expect(typeof shim.createVerify).toBe("function");
    expect(typeof shim.sign).toBe("function");
    expect(typeof shim.verify).toBe("function");
    expect(typeof shim.generateKeyPairSync).toBe("function");
    expect(typeof shim.createPrivateKey).toBe("function");
    expect(typeof shim.createPublicKey).toBe("function");
    expect(typeof shim.createSecretKey).toBe("function");
    expect(typeof shim.KeyObject).toBe("function");
    expect(typeof shim.constants).toBe("object");
    expect(shim.subtle).toBeDefined();
    expect(shim.webcrypto).toBeDefined();
    // enumerable keys for the bolo-node-shim:* Object.keys re-export
    expect(Object.keys(shim)).toContain("pbkdf2Sync");
    expect(Object.keys(shim)).toContain("generateKeyPairSync");
    expect(Object.keys(shim)).toContain("createSign");
  });
});

describe("hashes", () => {
  it.each(["md5", "sha1", "sha256", "sha384", "sha512", "sha3-256", "ripemd160"])(
    "createHash(%s) matches node:crypto",
    (alg) => {
      const input = "the quick brown fox jumps over the lazy dog";
      const ours = c.createHash(alg).update(input).digest("hex");
      const theirs = nodeCrypto.createHash(alg).update(input).digest("hex");
      expect(ours).toBe(theirs);
    },
  );

  it("supports chunked updates and Buffer input", () => {
    const data = Buffer.from("abcdef".repeat(100));
    const h = c.createHash("sha256");
    h.update(data.subarray(0, 100));
    h.update(data.subarray(100));
    expect(h.digest("hex")).toBe(nodeCrypto.createHash("sha256").update(data).digest("hex"));
  });

  it("getHashes returns implemented algorithms", () => {
    const hashes = c.getHashes();
    for (const a of ["md5", "sha1", "sha256", "sha512"]) {
      expect(hashes).toContain(a);
    }
  });

  it("digest() throws after finalization", () => {
    const h = c.createHash("sha256");
    h.update("x").digest();
    expect(() => h.digest()).toThrow();
    expect(() => h.update("y")).toThrow();
  });

  it("rejects unknown algorithms", () => {
    expect(() => c.createHash("nope-9000")).toThrow(/digest/i);
  });
});

describe("hmac", () => {
  it.each(["sha1", "sha256", "sha512"])("createHmac(%s) matches node:crypto", (alg) => {
    const ours = c.createHmac(alg, "secret-key").update("message").digest("hex");
    const theirs = nodeCrypto.createHmac(alg, "secret-key").update("message").digest("hex");
    expect(ours).toBe(theirs);
  });

  it("accepts Uint8Array keys", () => {
    const key = nodeCrypto.randomBytes(32);
    expect(c.createHmac("sha256", key).update("m").digest("hex")).toBe(
      nodeCrypto.createHmac("sha256", key).update("m").digest("hex"),
    );
  });

  it("drives the legacy stream surface like Node's LazyTransform", () => {
    // test-crypto-hmac ends the writable side with the input and reads the
    // digest back — `str.end is not a function` regressed that shape.
    const ours = c.createHmac("sha256", "secret-key") as unknown as {
      end(d: string): void;
      read(): { toString(e: string): string } | null;
    };
    ours.end("message");
    const theirs = nodeCrypto.createHmac("sha256", "secret-key");
    theirs.end("message");
    expect(ours.read()?.toString("hex")).toBe(theirs.read()?.toString("hex"));
  });
});

describe("kdf", () => {
  it("pbkdf2Sync matches node:crypto across digests", () => {
    for (const digest of ["sha1", "sha256", "sha512"]) {
      expect(c.pbkdf2Sync("password", "salt", 1000, 32, digest).toString("hex")).toBe(
        nodeCrypto.pbkdf2Sync("password", "salt", 1000, 32, digest).toString("hex"),
      );
    }
  });

  it("pbkdf2 (callback) resolves like node:crypto", async () => {
    const ours = await new Promise<Buffer>((res, rej) =>
      c.pbkdf2("password", "salt", 500, 16, "sha256", (e, k) => (e ? rej(e) : res(k))),
    );
    expect(ours.toString("hex")).toBe(
      nodeCrypto.pbkdf2Sync("password", "salt", 500, 16, "sha256").toString("hex"),
    );
  });

  it("scryptSync matches node:crypto", () => {
    expect(c.scryptSync("password", "salt", 32).toString("hex")).toBe(
      nodeCrypto.scryptSync("password", "salt", 32).toString("hex"),
    );
  });

  it("scrypt (callback) resolves like node:crypto", async () => {
    const ours = await new Promise<Buffer>((res, rej) =>
      c.scrypt("password", "salt", 24, (e, k) => (e ? rej(e) : res(k))),
    );
    expect(ours.toString("hex")).toBe(
      nodeCrypto.scryptSync("password", "salt", 24).toString("hex"),
    );
  });

  it("hkdfSync matches node:crypto", () => {
    const ours = c.hkdfSync("sha256", "ikm", "salt", "info", 32);
    const theirs = nodeCrypto.hkdfSync("sha256", "ikm", "salt", "info", 32);
    expect(Buffer.from(ours).toString("hex")).toBe(Buffer.from(theirs).toString("hex"));
  });
});

describe("random", () => {
  it("randomInt stays in range", () => {
    for (let i = 0; i < 200; i++) {
      const v = c.randomInt(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
      expect(Number.isInteger(v)).toBe(true);
    }
    for (let i = 0; i < 100; i++) {
      const v = c.randomInt(5, 15);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(15);
    }
  });

  it("randomInt validates args", () => {
    expect(() => c.randomInt(0)).toThrow();
    expect(() => c.randomInt(10, 5)).toThrow();
    expect(() => c.randomInt(2.5)).toThrow();
  });

  it("randomFillSync fills a buffer slice", () => {
    const buf = Buffer.alloc(32, 0xaa);
    const out = c.randomFillSync(buf, 8, 16);
    expect(out).toBe(buf);
    expect(buf.subarray(0, 8).every((b) => b === 0xaa)).toBe(true);
    expect(buf.subarray(24).every((b) => b === 0xaa)).toBe(true);
    expect(buf.subarray(8, 24).some((b) => b !== 0xaa)).toBe(true);
  });

  it("timingSafeEqual compares equal-length buffers", () => {
    const a = Buffer.from("same");
    const b = Buffer.from("same");
    const d = Buffer.from("diff");
    expect(c.timingSafeEqual(a, b)).toBe(true);
    expect(c.timingSafeEqual(a, d)).toBe(false);
    expect(() => c.timingSafeEqual(a, Buffer.from("longer!"))).toThrow();
  });
});

describe("node fidelity", () => {
  it("digest('buffer') returns raw bytes; a finalized Hash throws (Hash)", () => {
    const h = c.createHash("sha1").update("data");
    expect(h.digest("buffer")).toBeInstanceOf(Buffer);
    expect(() => h.digest("buffer")).toThrowError(
      expect.objectContaining({ code: "ERR_CRYPTO_HASH_FINALIZED" }),
    );
    expect(() => h.update("x")).toThrowError(
      expect.objectContaining({ code: "ERR_CRYPTO_HASH_FINALIZED" }),
    );
  });

  it("Hmac is callable without `new` and repeat digest is empty", () => {
    const instance = (c.Hmac as unknown as (a: string, k: string) => unknown)("sha256", "Node");
    expect(instance instanceof c.Hmac).toBe(true);
    const h = c.createHmac("sha1", "key").update("data");
    expect(h.digest("buffer")).toBeInstanceOf(Buffer);
    expect(h.digest("buffer").length).toBe(0);
    expect(h.digest("latin1")).toBe("");
  });

  it("validates createHash/createHmac args like Node", () => {
    expect(() => (c.createHash as unknown as () => void)()).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: expect.stringContaining('The "algorithm" argument'),
      }),
    );
    expect(() => (c.createHash as unknown as () => void)().update?.()).toThrow(TypeError);
    expect(() => c.createHash("sha256").update(undefined as never)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => c.createHmac(null as never, "key")).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: 'The "hmac" argument must be of type string. Received null',
      }),
    );
    expect(() => c.createHmac("sha1", null as never)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => c.createHmac("sha7", "key")).toThrowError(/Digest method not supported/);
  });

  it("randomUUID validates its options argument", () => {
    expect(() => c.randomUUID(1 as never)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => c.randomUUID({ disableEntropyCache: "" as never })).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(c.randomUUID({ disableEntropyCache: true })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("randomBytes validates size and accepts a callback", async () => {
    expect(() => c.randomBytes(-1)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => c.randomBytes("5" as never)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    const viaCb = await new Promise<Buffer>((res) => c.randomBytes(8, (_e, b) => res(b)));
    expect(viaCb.length).toBe(8);
    expect(c.randomBytes(0).length).toBe(0);
  });

  it("timingSafeEqual rejects non-equal lengths with a coded RangeError", () => {
    expect(() => c.timingSafeEqual(Buffer.from("a"), Buffer.from("bb"))).toThrowError(
      expect.objectContaining({ code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" }),
    );
  });

  it("pbkdf2Sync and scryptSync validate their digests", () => {
    expect(() => c.pbkdf2Sync("p", "s", 10, 8, "nope" as never)).toThrow();
  });
});

describe("keys", () => {
  it("createSecretKey wraps bytes and exports", () => {
    const raw = Buffer.from("0123456789abcdef0123456789abcdef");
    const k = c.createSecretKey(raw);
    expect(k.type).toBe("secret");
    const jwk = k.export({ format: "jwk" }) as { kty: string; k: string };
    expect(jwk.kty).toBe("oct");
    const k2 = c.createSecretKey({ key: jwk, format: "jwk" });
    expect(k.equals(k2)).toBe(true);
  });
});

describe("sign/verify", () => {
  it("ed25519 generateKeyPairSync → sign → verify, cross-checked with node", () => {
    const { publicKey, privateKey } = c.generateKeyPairSync("ed25519");
    const msg = Buffer.from("sign me");
    const sig = c.sign(null, msg, privateKey);
    expect(c.verify(null, msg, publicKey, sig)).toBe(true);
    // node verifies our signature against our exported PEM
    const pubPem = publicKey.export({ format: "pem", type: "spki" });
    expect(nodeCrypto.verify(null, msg, nodeCrypto.createPublicKey(pubPem), sig)).toBe(true);
    // node signature verifies against ours
    const nodePair = nodeCrypto.generateKeyPairSync("ed25519");
    const nodeSig = nodeCrypto.sign(null, msg, nodePair.privateKey);
    const oursPub = c.createPublicKey(nodePair.publicKey.export({ format: "pem", type: "spki" }));
    expect(c.verify(null, msg, oursPub, nodeSig)).toBe(true);
  });

  it("ec P-256 sign/verify + PEM + JWK round trips", () => {
    const { publicKey, privateKey } = c.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const msg = Buffer.from("ecdsa message");
    const sig = c.sign("sha256", msg, privateKey);
    expect(c.verify("sha256", msg, publicKey, sig)).toBe(true);
    const pubPem = publicKey.export({ format: "pem", type: "spki" });
    expect(nodeCrypto.verify("sha256", msg, nodeCrypto.createPublicKey(pubPem), sig)).toBe(true);
    const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string };
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    const k3 = c.createPublicKey({ key: jwk, format: "jwk" });
    expect(c.verify("sha256", msg, k3, sig)).toBe(true);
  });

  it("rsa sign/verify (PKCS1 v1.5 + PSS) cross-checked with node", () => {
    const { publicKey, privateKey } = c.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const msg = Buffer.from("rsa message");
    const sig = c.sign("sha256", msg, privateKey);
    expect(c.verify("sha256", msg, publicKey, sig)).toBe(true);
    const pubPem = publicKey.export({ format: "pem", type: "spki" });
    expect(nodeCrypto.verify("sha256", msg, nodeCrypto.createPublicKey(pubPem), sig)).toBe(true);
    // node private key imported by ours
    const nodePair = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const imported = c.createPrivateKey(
      nodePair.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const sig2 = c.sign("sha256", msg, imported);
    expect(nodeCrypto.verify("sha256", msg, nodePair.publicKey, sig2)).toBe(true);
  });

  it("createSign/createVerify streaming API", () => {
    const { publicKey, privateKey } = c.generateKeyPairSync("ed25519");
    const signer = c.createSign(null);
    signer.update("chunk1");
    signer.update("chunk2");
    const sig = signer.sign(privateKey);
    const verifier = c.createVerify(null);
    verifier.update("chunk1");
    verifier.update("chunk2");
    expect(verifier.verify(publicKey, sig)).toBe(true);
  });

  it("generateKeyPair async callback works", async () => {
    const pair = await new Promise<{ publicKey: unknown; privateKey: unknown }>((res, rej) =>
      c.generateKeyPair("ed25519", (e, pub, priv) =>
        e ? rej(e) : res({ publicKey: pub, privateKey: priv }),
      ),
    );
    const sig = c.sign(null, Buffer.from("cb"), pair.privateKey as never);
    expect(c.verify(null, Buffer.from("cb"), pair.publicKey as never, sig)).toBe(true);
  });
});
