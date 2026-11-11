import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { p256, p384, p521 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { Buffer, bigIntToU8, toU8, u8ToBigInt, type BinaryLike } from "../internal/binary.js";
import {
  TAG,
  derBitString,
  derBitStringEncode,
  derContext,
  derInt,
  derIntEncode,
  derIntValue,
  derNull,
  derOctetString,
  derOid,
  derOidEncode,
  derSeq,
  parseDer,
  pemDecode,
  pemEncode,
  type DerNode,
} from "./der.js";

// ---- key material model ----

export type EcCurveName = "P-256" | "P-384" | "P-521" | "secp256k1";
export type OkpCurveName = "ed25519" | "x25519";

export interface PssParams {
  hashAlgorithm?: string;
  mgf1HashAlgorithm?: string;
  saltLength?: number;
}

export type KeyMaterial =
  | { kind: "secret"; bytes: Uint8Array }
  | {
      kind: "rsa";
      pss?: PssParams;
      n: bigint;
      e: bigint;
      d?: bigint;
      p?: bigint;
      q?: bigint;
      dp?: bigint;
      dq?: bigint;
      qi?: bigint;
    }
  | { kind: "ec"; curve: EcCurveName; pub?: Uint8Array; priv?: Uint8Array }
  | {
      kind: "okp";
      curve: OkpCurveName;
      pub: Uint8Array;
      priv?: Uint8Array;
    }
  | { kind: "cryptokey"; key: CryptoKey; name: string };

const OIDS = {
  rsa: "1.2.840.113549.1.1.1",
  rsaPss: "1.2.840.113549.1.1.10",
  ec: "1.2.840.10045.2.1",
  ed25519: "1.3.101.112",
  ed448: "1.3.101.113",
  x25519: "1.3.101.110",
  x448: "1.3.101.111",
} as const;

const CURVE_OIDS: Record<EcCurveName, string> = {
  "P-256": "1.2.840.10045.3.1.7",
  "P-384": "1.3.132.0.34",
  "P-521": "1.3.132.0.35",
  secp256k1: "1.3.132.0.10",
};

const OID_TO_CURVE: Record<string, EcCurveName> = {
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
  "1.3.132.0.35": "P-521",
  "1.3.132.0.10": "secp256k1",
};

/** Node `namedCurve` spellings → canonical JWK names. */
export const normalizeEcCurve = (name: string): EcCurveName => {
  const n = name.toLowerCase().replace(/[-_]/g, "");
  if (n === "p256" || n === "prime256v1" || n === "secp256r1") return "P-256";
  if (n === "p384" || n === "secp384r1") return "P-384";
  if (n === "p521" || n === "secp521r1") return "P-521";
  if (n === "secp256k1" || n === "p256k1") return "secp256k1";
  throw Object.assign(new Error(`Unsupported EC curve: "${name}"`), {
    code: "ERR_CRYPTO_UNKNOWN_CURVE",
  });
};

export const ecCurveByteSize = (curve: EcCurveName): number =>
  curve === "P-256" || curve === "secp256k1" ? 32 : curve === "P-384" ? 48 : 66;

export const nobleCurve = (
  curve: EcCurveName,
): typeof p256 | typeof p384 | typeof p521 | typeof secp256k1 =>
  curve === "P-256" ? p256 : curve === "P-384" ? p384 : curve === "P-521" ? p521 : secp256k1;

export const nobleOkp = (curve: OkpCurveName) => (curve === "ed25519" ? ed25519 : x25519);

// ---- KeyObject ----

const keyMaterials = new WeakMap<KeyObject, KeyMaterial>();

/** Internal accessor — lets sign/kdf internals reach the raw material. */
export const getKeyMaterial = (key: KeyObject): KeyMaterial => {
  const m = keyMaterials.get(key);
  if (!m) throw new TypeError("Invalid KeyObject");
  return m;
};

const keyObjectError = (msg: string): TypeError =>
  Object.assign(new TypeError(msg), {
    code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
  });

export interface KeyExportOptions {
  type?: "pkcs1" | "spki" | "pkcs8" | "sec1";
  format?: "pem" | "der" | "jwk" | "buffer";
  cipher?: string;
  passphrase?: string | Uint8Array;
}

/**
 * `crypto.KeyObject` — structured-clone-free key handle backed by raw
 * material (bigints/bytes), not `CryptoKey`, so every operation is sync.
 */
export class KeyObject {
  readonly type: "secret" | "private" | "public";

  constructor(type: "secret" | "private" | "public", material: KeyMaterial) {
    if (type === "secret" && material.kind !== "secret") {
      throw keyObjectError('type "secret" requires secret material');
    }
    if (type !== "secret" && material.kind === "secret") {
      throw keyObjectError(`type "${type}" requires asymmetric material`);
    }
    this.type = type;
    keyMaterials.set(this, material);
  }

  get asymmetricKeyType(): string | undefined {
    const m = getKeyMaterial(this);
    switch (m.kind) {
      case "rsa":
        return m.pss ? "rsa-pss" : "rsa";
      case "ec":
        return "ec";
      case "okp":
        return m.curve;
      case "cryptokey":
        return mapCryptoKeyAlg(m.key.algorithm.name);
      default:
        return undefined;
    }
  }

  get asymmetricKeyDetails(): Record<string, unknown> | undefined {
    const m = getKeyMaterial(this);
    if (m.kind === "rsa") {
      return {
        modulusLength: bitLength(m.n),
        publicExponent: Number(m.e),
        ...(m.pss
          ? {
              hashAlgorithm: m.pss.hashAlgorithm,
              mgf1HashAlgorithm: m.pss.mgf1HashAlgorithm,
              saltLength: m.pss.saltLength,
            }
          : {}),
      };
    }
    if (m.kind === "ec") return { namedCurve: nodeCurveName(m.curve) };
    if (m.kind === "cryptokey") {
      const alg = m.key.algorithm as { namedCurve?: string; modulusLength?: number };
      return alg.namedCurve
        ? { namedCurve: alg.namedCurve }
        : alg.modulusLength
          ? { modulusLength: alg.modulusLength }
          : {};
    }
    return undefined;
  }

  get symmetricKeySize(): number | undefined {
    const m = getKeyMaterial(this);
    if (m.kind === "secret") return m.bytes.length;
    if (m.kind === "cryptokey" && m.key.type === "secret") {
      return (m.key.algorithm as { length?: number }).length;
    }
    return undefined;
  }

  /**
   * `KeyObject.from(cryptoKey)` — wraps a WebCrypto key. Operations needing
   * the raw material (sign/export) reject for non-extractable keys.
   */
  static from(key: CryptoKey): KeyObject {
    const type = key.type === "secret" ? "secret" : key.type === "private" ? "private" : "public";
    return new KeyObject(type, {
      kind: "cryptokey",
      key,
      name: key.algorithm.name,
    });
  }

  export(options?: KeyExportOptions): string | Buffer | Record<string, unknown> {
    const format = options?.format;
    if (options?.cipher || options?.passphrase) {
      throw Object.assign(
        new Error("Encrypted key export is not supported by the browser crypto shim"),
        { code: "ERR_CRYPTO_UNSUPPORTED_OPERATION" },
      );
    }
    const m = getKeyMaterial(this);
    if (m.kind === "cryptokey") {
      throw Object.assign(new Error("KeyObject.export is not supported for wrapped CryptoKeys"), {
        code: "ERR_CRYPTO_UNSUPPORTED_OPERATION",
      });
    }
    if (format === "jwk") return materialToJwk(this, m);
    if (this.type === "secret") {
      if (m.kind !== "secret") throw keyObjectError("unreachable");
      if (format === "pem") throw keyObjectError("Secret keys cannot be exported as PEM");
      return Buffer.from(m.bytes);
    }
    const type = options?.type ?? (this.type === "private" ? "pkcs8" : "spki");
    const der = materialToDer(this.type, m, type);
    if (format === "der" || format === "buffer") return Buffer.from(der);
    // default: pem
    const label =
      this.type === "private"
        ? type === "sec1"
          ? "EC PRIVATE KEY"
          : type === "pkcs1"
            ? "RSA PRIVATE KEY"
            : "PRIVATE KEY"
        : type === "pkcs1"
          ? "RSA PUBLIC KEY"
          : "PUBLIC KEY";
    return pemEncode(label, der);
  }

  equals(other: KeyObject): boolean {
    if (!(other instanceof KeyObject)) {
      throw Object.assign(new TypeError("Expected a KeyObject"), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    const a = getKeyMaterial(this);
    const b = getKeyMaterial(other);
    try {
      const ea = toU8(
        this.export({
          format: "der",
          type: this.type === "private" ? "pkcs8" : "spki",
        }) as Buffer,
      );
      const eb = toU8(
        other.export({
          format: "der",
          type: other.type === "private" ? "pkcs8" : "spki",
        }) as Buffer,
      );
      return buffersEqual(ea, eb);
    } catch {
      return a === b;
    }
  }
}

const buffersEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const bitLength = (v: bigint): number => v.toString(2).length;

const mapCryptoKeyAlg = (name: string): string | undefined => {
  const n = name.toUpperCase();
  if (n.includes("RSA")) return "rsa";
  if (n.includes("EC")) return "ec";
  if (n === "ED25519") return "ed25519";
  if (n === "X25519") return "x25519";
  return undefined;
};

const nodeCurveName = (curve: EcCurveName): string =>
  curve === "P-256"
    ? "prime256v1"
    : curve === "P-384"
      ? "secp384r1"
      : curve === "P-521"
        ? "secp521r1"
        : "secp256k1";

// ---- base64url helpers (JWK) ----

const b64urlEncode = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return globalThis.btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = globalThis.atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const b64urlBigInt = (v: bigint): string => b64urlEncode(bigIntToU8(v));

// ---- parsing ----

const parseIntSeq = (node: DerNode): bigint[] => {
  if (node.tag !== TAG.SEQUENCE) throw keyObjectError("expected INTEGER sequence");
  return node.children.map(derInt);
};

const parseRsaInts = (ints: bigint[]): Required<RsaInts> => ({
  n: ints[1],
  e: ints[2],
  d: ints[3],
  p: ints[4],
  q: ints[5],
  dp: ints[6],
  dq: ints[7],
  qi: ints[8],
});

interface RsaInts {
  n?: bigint;
  e?: bigint;
  d?: bigint;
  p?: bigint;
  q?: bigint;
  dp?: bigint;
  dq?: bigint;
  qi?: bigint;
}

const keyErr = (msg: string): Error =>
  Object.assign(new Error(msg), { code: "ERR_INVALID_ARG_VALUE" });

/** PKCS#8 PrivateKeyInfo → material (private). */
const parsePkcs8 = (der: Uint8Array): KeyMaterial => {
  const top = parseDer(der);
  if (top.tag !== TAG.SEQUENCE || top.children.length < 3) {
    throw keyObjectError("malformed PKCS#8 structure");
  }
  const alg = top.children[1];
  const oid = derOid(alg.children[0]);
  const params = alg.children[1];
  const privOctets = top.children[2];
  if (privOctets.tag !== TAG.OCTET_STRING) throw keyObjectError("malformed PKCS#8 private key");
  const inner = privOctets.value;

  switch (oid) {
    case OIDS.rsa: {
      const rsa = parseRsaInts(parseIntSeq(parseDer(inner)));
      return { kind: "rsa", ...rsa };
    }
    case OIDS.rsaPss: {
      const rsa = parseRsaInts(parseIntSeq(parseDer(inner)));
      return { kind: "rsa", pss: parsePssParams(params), ...rsa };
    }
    case OIDS.ec: {
      if (!params || params.tag !== TAG.OID) throw keyObjectError("missing EC curve OID");
      const curve = OID_TO_CURVE[derOid(params)];
      if (!curve) throw keyObjectError("unsupported EC curve OID");
      return parseSec1(inner, curve);
    }
    case OIDS.ed25519:
    case OIDS.x25519:
      return {
        kind: "okp",
        curve: oid === OIDS.ed25519 ? "ed25519" : "x25519",
        priv: unwrapOkpSeed(inner),
        pub: deriveOkpPub(oid === OIDS.ed25519 ? "ed25519" : "x25519", unwrapOkpSeed(inner)),
      };
    default:
      throw keyObjectError(`unsupported private key algorithm OID ${oid}`);
  }
};

/** RFC 8410: privateKey field holds DER OCTET STRING of the seed. */
const unwrapOkpSeed = (inner: Uint8Array): Uint8Array => {
  try {
    const node = parseDer(inner);
    if (node.tag === TAG.OCTET_STRING) return node.value;
  } catch {
    /* fall through — some encoders embed the raw seed */
  }
  return inner;
};

const deriveOkpPub = (curve: OkpCurveName, seed: Uint8Array): Uint8Array =>
  nobleOkp(curve).getPublicKey(seed);

/** SEC1 ECPrivateKey → ec material. */
const parseSec1 = (der: Uint8Array, fallbackCurve?: EcCurveName): KeyMaterial => {
  const node = parseDer(der);
  if (node.tag !== TAG.SEQUENCE) throw keyObjectError("malformed SEC1 key");
  const priv = node.children[1];
  if (priv?.tag !== TAG.OCTET_STRING) throw keyObjectError("missing EC private octets");
  let curve = fallbackCurve;
  let pub: Uint8Array | undefined;
  for (const c of node.children.slice(2)) {
    if (c.tag === TAG.CONTEXT_0 && c.children[0]?.tag === TAG.OID) {
      curve = OID_TO_CURVE[derOid(c.children[0])] ?? curve;
    } else if (c.tag === TAG.CONTEXT_0 && c.children[0] === undefined && c.value[0] === TAG.OID) {
      curve = OID_TO_CURVE[derOid(parseDer(c.value))] ?? curve;
    }
    if (c.tag === TAG.CONTEXT_1) {
      pub =
        c.children[0]?.tag === TAG.BIT_STRING ? derBitString(c.children[0]) : c.value.subarray(1);
    }
  }
  if (!curve) throw keyObjectError("cannot determine EC curve");
  if (!pub) pub = nobleCurve(curve).getPublicKey(priv.value, false);
  return { kind: "ec", curve, priv: priv.value, pub };
};

const parsePssParams = (node: DerNode | undefined): PssParams => {
  const out: PssParams = {};
  if (!node || node.tag !== TAG.SEQUENCE) return out;
  for (const c of node.children) {
    if (c.tag === TAG.CONTEXT_0 && c.children[0]) {
      out.hashAlgorithm = oidToHashName(derOid(c.children[0].children[0] ?? c.children[0]));
    } else if (c.tag === TAG.CONTEXT_1 && c.children[0]) {
      // MGF1: SEQ{ mgf1Oid, hashAlgId }
      const inner = c.children[0];
      const hashId = inner.children[1]?.children[0];
      if (hashId) out.mgf1HashAlgorithm = oidToHashName(derOid(hashId));
    } else if (c.tag === TAG.CONTEXT_2 && c.children[0]) {
      out.saltLength = Number(derInt(c.children[0]));
    }
  }
  return out;
};

const HASH_OIDS: Record<string, string> = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
  "2.16.840.1.101.3.4.2.4": "sha224",
};

const oidToHashName = (oid: string): string | undefined => HASH_OIDS[oid];

const HASH_NAME_TO_OID: Record<string, string> = {
  sha1: "1.3.14.3.2.26",
  sha224: "2.16.840.1.101.3.4.2.4",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
};

/** SPKI SubjectPublicKeyInfo → material (public). */
const parseSpki = (der: Uint8Array): KeyMaterial => {
  const top = parseDer(der);
  if (top.tag !== TAG.SEQUENCE || top.children.length < 2) {
    throw keyObjectError("malformed SPKI structure");
  }
  const alg = top.children[0];
  const oid = derOid(alg.children[0]);
  const params = alg.children[1];
  const bits = derBitString(top.children[1]);
  switch (oid) {
    case OIDS.rsa:
    case OIDS.rsaPss: {
      const ints = parseIntSeq(parseDer(bits));
      const m: Extract<KeyMaterial, { kind: "rsa" }> = {
        kind: "rsa",
        n: ints[0]!,
        e: ints[1]!,
      };
      if (oid === OIDS.rsaPss) m.pss = parsePssParams(params);
      return m;
    }
    case OIDS.ec: {
      if (!params || params.tag !== TAG.OID) throw keyObjectError("missing EC curve OID");
      const curve = OID_TO_CURVE[derOid(params)];
      if (!curve) throw keyObjectError("unsupported EC curve OID");
      return { kind: "ec", curve, pub: bits };
    }
    case OIDS.ed25519:
    case OIDS.x25519:
      return {
        kind: "okp",
        curve: oid === OIDS.ed25519 ? "ed25519" : "x25519",
        pub: bits,
      };
    default:
      throw keyObjectError(`unsupported public key algorithm OID ${oid}`);
  }
};

const tryParsers = (der: Uint8Array, which: "private" | "public"): KeyMaterial => {
  const parsers: Array<(d: Uint8Array) => KeyMaterial> =
    which === "private"
      ? [
          parsePkcs8,
          (d) => ({ kind: "rsa", ...parseRsaInts(parseIntSeq(parseDer(d))) }),
          (d) => parseSec1(d),
        ]
      : [
          parseSpki,
          (d) => {
            const ints = parseIntSeq(parseDer(d));
            return { kind: "rsa", n: ints[0]!, e: ints[1]! };
          },
        ];
  let lastErr: unknown;
  for (const p of parsers) {
    try {
      const m = p(der);
      if (which === "private" && !hasPrivate(m)) {
        throw keyObjectError("key does not contain private material");
      }
      return m;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : keyObjectError("unparseable key");
};

const hasPrivate = (m: KeyMaterial): boolean =>
  (m.kind === "rsa" && m.d !== undefined) ||
  (m.kind === "ec" && m.priv !== undefined) ||
  (m.kind === "okp" && m.priv !== undefined) ||
  m.kind === "secret";

/** Derive the public half of private material. */
export const publicMaterial = (m: KeyMaterial): KeyMaterial => {
  switch (m.kind) {
    case "rsa":
      return { kind: "rsa", pss: m.pss, n: m.n, e: m.e };
    case "ec":
      return {
        kind: "ec",
        curve: m.curve,
        pub: m.pub ?? nobleCurve(m.curve).getPublicKey(m.priv!, false),
      };
    case "okp":
      return {
        kind: "okp",
        curve: m.curve,
        pub: m.priv && m.pub.length === 0 ? deriveOkpPub(m.curve, m.priv) : m.pub,
      };
    default:
      return m;
  }
};

// ---- JWK ----

export interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  n?: string;
  e?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
  k?: string;
  [key: string]: unknown;
}

const isJwk = (v: unknown): v is Jwk =>
  typeof v === "object" && v !== null && typeof (v as Jwk).kty === "string";

const jwkToMaterial = (jwk: Jwk, wantPrivate: boolean): KeyMaterial => {
  switch (jwk.kty) {
    case "oct":
      if (!jwk.k) throw keyObjectError("JWK missing 'k'");
      return { kind: "secret", bytes: b64urlDecode(jwk.k) };
    case "RSA": {
      const m: Extract<KeyMaterial, { kind: "rsa" }> = {
        kind: "rsa",
        n: u8ToBigInt(b64urlDecode(jwk.n ?? "")),
        e: u8ToBigInt(b64urlDecode(jwk.e ?? "AQAB")),
      };
      if (jwk.d) m.d = u8ToBigInt(b64urlDecode(jwk.d));
      if (jwk.p) m.p = u8ToBigInt(b64urlDecode(jwk.p));
      if (jwk.q) m.q = u8ToBigInt(b64urlDecode(jwk.q));
      if (jwk.dp) m.dp = u8ToBigInt(b64urlDecode(jwk.dp));
      if (jwk.dq) m.dq = u8ToBigInt(b64urlDecode(jwk.dq));
      if (jwk.qi) m.qi = u8ToBigInt(b64urlDecode(jwk.qi));
      return m;
    }
    case "EC": {
      const curve = normalizeEcCurve(jwk.crv ?? "");
      const size = ecCurveByteSize(curve);
      const m: Extract<KeyMaterial, { kind: "ec" }> = { kind: "ec", curve };
      if (jwk.x && jwk.y) {
        const x = b64urlDecode(jwk.x);
        const y = b64urlDecode(jwk.y);
        const point = new Uint8Array(1 + 2 * size);
        point[0] = 4;
        point.set(x.length > size ? x.slice(x.length - size) : x, 1 + size - x.length);
        point.set(y.length > size ? y.slice(y.length - size) : y, 1 + 2 * size - y.length);
        m.pub = point;
      }
      if (jwk.d) m.priv = b64urlDecode(jwk.d);
      return m;
    }
    case "OKP": {
      const crv = (jwk.crv ?? "").toLowerCase();
      if (crv !== "ed25519" && crv !== "x25519") {
        throw keyObjectError(`unsupported OKP curve "${jwk.crv}"`);
      }
      const m: Extract<KeyMaterial, { kind: "okp" }> = {
        kind: "okp",
        curve: crv,
        pub: jwk.x ? b64urlDecode(jwk.x) : new Uint8Array(0),
      };
      if (jwk.d) m.priv = b64urlDecode(jwk.d);
      if (!m.pub.length && m.priv) m.pub = deriveOkpPub(crv, m.priv);
      return m;
    }
    default:
      throw keyObjectError(`unsupported JWK kty "${jwk.kty}"`);
  }
};

const materialToJwk = (ko: KeyObject, m: KeyMaterial): Record<string, unknown> => {
  if (m.kind === "secret") return { kty: "oct", k: b64urlEncode(m.bytes) };
  if (m.kind === "rsa") {
    const jwk: Jwk = {
      kty: "RSA",
      n: b64urlBigInt(m.n),
      e: b64urlBigInt(m.e),
    };
    if (ko.type === "private" && m.d !== undefined) {
      jwk.d = b64urlBigInt(m.d);
      if (m.p !== undefined) jwk.p = b64urlBigInt(m.p);
      if (m.q !== undefined) jwk.q = b64urlBigInt(m.q);
      if (m.dp !== undefined) jwk.dp = b64urlBigInt(m.dp);
      if (m.dq !== undefined) jwk.dq = b64urlBigInt(m.dq);
      if (m.qi !== undefined) jwk.qi = b64urlBigInt(m.qi);
    }
    return jwk;
  }
  if (m.kind === "ec") {
    const pub = m.pub ?? nobleCurve(m.curve).getPublicKey(m.priv!, false);
    const size = ecCurveByteSize(m.curve);
    const jwk: Jwk = {
      kty: "EC",
      crv: m.curve,
      x: b64urlEncode(pub.slice(1, 1 + size)),
      y: b64urlEncode(pub.slice(1 + size, 1 + 2 * size)),
    };
    if (ko.type === "private" && m.priv) jwk.d = b64urlEncode(m.priv);
    return jwk;
  }
  if (m.kind === "okp") {
    const jwk: Jwk = {
      kty: "OKP",
      crv: m.curve === "ed25519" ? "Ed25519" : "X25519",
      x: b64urlEncode(m.pub),
    };
    if (ko.type === "private" && m.priv) jwk.d = b64urlEncode(m.priv);
    return jwk;
  }
  throw keyObjectError("unsupported key material");
};

// ---- DER emit ----

const rsaPrivateDer = (m: Extract<KeyMaterial, { kind: "rsa" }>): Uint8Array => {
  const { n, e, d, p, q, dp, dq, qi } = m;
  if (d === undefined || p === undefined || q === undefined) {
    throw keyObjectError(
      "RSA private key is missing CRT parameters (p/q) required for PKCS#1/PKCS#8 export",
    );
  }
  const dpv = dp ?? d % (p - 1n);
  const dqv = dq ?? d % (q - 1n);
  const qiv = qi ?? modInverse(q, p);
  return derSeq(
    derIntEncode(0n),
    derIntEncode(n),
    derIntEncode(e),
    derIntEncode(d),
    derIntEncode(p),
    derIntEncode(q),
    derIntEncode(dpv),
    derIntEncode(dqv),
    derIntEncode(qiv),
  );
};

export const modInverse = (a: bigint, m: bigint): bigint => {
  let [old_r, r] = [a % m, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
};

const algIdent = (oid: string, params?: Uint8Array): Uint8Array =>
  derSeq(derOidEncode(oid), params ?? derNull());

const ecAlgIdent = (curve: EcCurveName): Uint8Array =>
  derSeq(derOidEncode(OIDS.ec), derOidEncode(CURVE_OIDS[curve]));

const pssAlgIdent = (pss?: PssParams): Uint8Array => {
  if (!pss) return derSeq(derOidEncode(OIDS.rsaPss), derNull());
  const parts: Uint8Array[] = [];
  if (pss.hashAlgorithm && HASH_NAME_TO_OID[pss.hashAlgorithm.toLowerCase()]) {
    parts.push(derContext(0, algIdent(HASH_NAME_TO_OID[pss.hashAlgorithm.toLowerCase()])));
  }
  const mgfHash = pss.mgf1HashAlgorithm ?? pss.hashAlgorithm;
  if (mgfHash && HASH_NAME_TO_OID[mgfHash.toLowerCase()]) {
    parts.push(
      derContext(
        1,
        derSeq(
          derOidEncode("1.2.840.113549.1.1.8"),
          algIdent(HASH_NAME_TO_OID[mgfHash.toLowerCase()]),
        ),
      ),
    );
  }
  if (pss.saltLength !== undefined) {
    parts.push(derContext(2, derIntValue(pss.saltLength)));
  }
  return derSeq(derOidEncode(OIDS.rsaPss), parts.length ? derSeq(...parts) : derNull());
};

const materialToDer = (keyType: "private" | "public", m: KeyMaterial, type: string): Uint8Array => {
  if (keyType === "private") {
    if (type === "pkcs1" || type === "pkcs8") {
      if (m.kind === "rsa") {
        const inner = rsaPrivateDer(m);
        if (type === "pkcs1") return inner;
        return derSeq(
          derIntEncode(0n),
          m.pss ? pssAlgIdent(m.pss) : algIdent(OIDS.rsa),
          derOctetString(inner),
        );
      }
      if (m.kind === "ec") {
        if (type === "pkcs1") throw keyObjectError("'pkcs1' is only valid for RSA keys");
        const sec1 = derSeq(
          derIntEncode(1n),
          derOctetString(m.priv!),
          derContext(0, derOidEncode(CURVE_OIDS[m.curve])),
          derContext(
            1,
            derBitStringEncode(m.pub ?? nobleCurve(m.curve).getPublicKey(m.priv!, false)),
          ),
        );
        return derSeq(derIntEncode(0n), ecAlgIdent(m.curve), derOctetString(sec1));
      }
      if (m.kind === "okp") {
        const oid = m.curve === "ed25519" ? OIDS.ed25519 : OIDS.x25519;
        return derSeq(
          derIntEncode(0n),
          derSeq(derOidEncode(oid)),
          derOctetString(derOctetString(m.priv!)),
        );
      }
      throw keyObjectError("unsupported private key material");
    }
    if (type === "sec1") {
      if (m.kind !== "ec") throw keyObjectError("'sec1' is only valid for EC keys");
      return derSeq(
        derIntEncode(1n),
        derOctetString(m.priv!),
        derContext(0, derOidEncode(CURVE_OIDS[m.curve])),
        derContext(
          1,
          derBitStringEncode(m.pub ?? nobleCurve(m.curve).getPublicKey(m.priv!, false)),
        ),
      );
    }
    throw keyObjectError(`unsupported private key type "${type}"`);
  }

  // public
  if (type === "pkcs1") {
    if (m.kind !== "rsa") throw keyObjectError("'pkcs1' is only valid for RSA keys");
    return derSeq(derIntEncode(m.n), derIntEncode(m.e));
  }
  if (type !== "spki") throw keyObjectError(`unsupported public key type "${type}"`);
  if (m.kind === "rsa") {
    const pub = derSeq(derIntEncode(m.n), derIntEncode(m.e));
    return derSeq(m.pss ? pssAlgIdent(m.pss) : algIdent(OIDS.rsa), derBitStringEncode(pub));
  }
  if (m.kind === "ec") {
    const pub = m.pub ?? nobleCurve(m.curve).getPublicKey(m.priv!, false);
    return derSeq(ecAlgIdent(m.curve), derBitStringEncode(pub));
  }
  if (m.kind === "okp") {
    const oid = m.curve === "ed25519" ? OIDS.ed25519 : OIDS.x25519;
    return derSeq(derSeq(derOidEncode(oid)), derBitStringEncode(m.pub));
  }
  throw keyObjectError("unsupported public key material");
};

// ---- factory functions ----

export interface KeyObjectInput {
  key: BinaryLike | Jwk | KeyObject;
  format?: "pem" | "der" | "jwk";
  type?: string;
  encoding?: string;
  passphrase?: string | Uint8Array;
}

type CreateKeyArg = BinaryLike | Jwk | KeyObjectInput;

const isKeyObjectInput = (v: unknown): v is KeyObjectInput =>
  typeof v === "object" && v !== null && "key" in (v as object);

const unwrapArg = (
  arg: CreateKeyArg,
): { key: BinaryLike | Jwk; format?: string; encoding?: string; passphrase?: unknown } => {
  if (isKeyObjectInput(arg)) {
    if (arg.passphrase !== undefined) {
      throw Object.assign(
        new Error("Encrypted private keys are not supported by the browser crypto shim"),
        { code: "ERR_CRYPTO_UNSUPPORTED_OPERATION" },
      );
    }
    return {
      key: arg.key as BinaryLike | Jwk,
      format: arg.format,
      encoding: arg.encoding,
    };
  }
  return { key: arg as BinaryLike | Jwk };
};

export const createSecretKey = (
  key: BinaryLike | Jwk | KeyObjectInput,
  encoding?: BufferEncoding,
): KeyObject => {
  const arg: { key: BinaryLike | Jwk; format?: string; encoding?: string } = isKeyObjectInput(key)
    ? unwrapArg(key)
    : { key: key as BinaryLike | Jwk, format: undefined, encoding };
  const { key: raw, format } = arg;
  if (isJwk(raw) || format === "jwk") {
    const m = jwkToMaterial(raw as Jwk, false);
    if (m.kind !== "secret") throw keyObjectError("JWK is not a secret key");
    return new KeyObject("secret", m);
  }
  return new KeyObject("secret", { kind: "secret", bytes: toU8(raw as BinaryLike, encoding) });
};

export const createPrivateKey = (arg: CreateKeyArg): KeyObject => {
  if (arg instanceof KeyObject) {
    const m = getKeyMaterial(arg);
    if (m.kind === "secret") throw keyObjectError("secret keys are not asymmetric");
    return arg;
  }
  const { key, format, encoding } = unwrapArg(arg);
  if (isJwk(key) || format === "jwk") {
    const m = jwkToMaterial(key as Jwk, true);
    if (!hasPrivate(m)) throw keyObjectError("JWK does not contain private material");
    return new KeyObject("private", m);
  }
  if (typeof key === "string" || format === "pem") {
    const str =
      typeof key === "string" ? key : Buffer.from(toU8(key as BinaryLike)).toString("utf8");
    const { label, bytes } = pemDecode(str);
    const m = parsePrivatePem(label, bytes);
    return new KeyObject("private", m);
  }
  const der = toU8(key as BinaryLike, encoding as BufferEncoding | undefined);
  return new KeyObject("private", tryParsers(der, "private"));
};

const parsePrivatePem = (label: string, der: Uint8Array): KeyMaterial => {
  switch (label) {
    case "PRIVATE KEY":
      return parsePkcs8(der);
    case "RSA PRIVATE KEY": {
      const ints = parseIntSeq(parseDer(der));
      return { kind: "rsa", ...parseRsaInts(ints) };
    }
    case "EC PRIVATE KEY":
      return parseSec1(der);
    case "ENCRYPTED PRIVATE KEY":
      throw Object.assign(
        new Error("Encrypted private keys are not supported by the browser crypto shim"),
        { code: "ERR_CRYPTO_UNSUPPORTED_OPERATION" },
      );
    default:
      throw keyObjectError(`unsupported PEM label "${label}" for a private key`);
  }
};

export const createPublicKey = (arg: CreateKeyArg | KeyObject): KeyObject => {
  if (arg instanceof KeyObject) {
    const m = getKeyMaterial(arg);
    if (m.kind === "secret") throw keyObjectError("secret keys are not asymmetric");
    if (arg.type === "public") return arg;
    return new KeyObject("public", publicMaterial(m));
  }
  const { key, format, encoding } = unwrapArg(arg);
  if (key instanceof KeyObject) return createPublicKey(key);
  if (isJwk(key) || format === "jwk") {
    const m = jwkToMaterial(key as Jwk, false);
    return new KeyObject("public", publicMaterial(m));
  }
  if (typeof key === "string" || format === "pem") {
    const str =
      typeof key === "string" ? key : Buffer.from(toU8(key as BinaryLike)).toString("utf8");
    const { label, bytes } = pemDecode(str);
    switch (label) {
      case "PUBLIC KEY":
        return new KeyObject("public", parseSpki(bytes));
      case "RSA PUBLIC KEY": {
        const ints = parseIntSeq(parseDer(bytes));
        return new KeyObject("public", { kind: "rsa", n: ints[0]!, e: ints[1]! });
      }
      default:
        // Node accepts a private PEM here and derives the public half.
        return new KeyObject("public", publicMaterial(parsePrivatePem(label, bytes)));
    }
  }
  const der = toU8(key as BinaryLike, encoding as BufferEncoding | undefined);
  // DER public first, then private→derive-public like Node.
  try {
    return new KeyObject("public", tryParsers(der, "public"));
  } catch {
    return new KeyObject("public", publicMaterial(tryParsers(der, "private")));
  }
};
