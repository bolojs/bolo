import { concatU8 } from "../internal/binary.js";

/**
 * Minimal DER (X.690) codec — enough for PKCS#1/#8, SEC1 and SPKI key
 * containers plus ECDSA signature values. Parsing is strict on lengths but
 * tolerant of trailing structures we don't model (context-specific fields are
 * kept as raw content).
 */

export interface DerNode {
  /** Tag byte (class + constructed bit + number). */
  tag: number;
  /** Raw content octets (for primitives) or concatenated children encoding. */
  value: Uint8Array;
  /** Parsed children for constructed tags. */
  children: DerNode[];
  /** Total encoded length including header — internal use. */
  size: number;
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  SET: 0x31,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  CONTEXT_0: 0xa0,
  CONTEXT_1: 0xa1,
  CONTEXT_2: 0xa2,
  CONTEXT_3: 0xa3,
} as const;

const derError = (msg: string): Error =>
  Object.assign(new Error(`DER: ${msg}`), { code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE" });

export const parseDer = (bytes: Uint8Array): DerNode => {
  const { node } = readTlv(bytes, 0);
  return node;
};

const readTlv = (bytes: Uint8Array, offset: number): { node: DerNode; offset: number } => {
  if (offset >= bytes.length) throw derError("unexpected end of input");
  const tag = bytes[offset];
  if ((tag & 0x1f) === 0x1f) throw derError("multi-byte tags unsupported");
  let pos = offset + 1;
  if (pos >= bytes.length) throw derError("truncated length");
  let len = bytes[pos++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw derError("invalid length encoding");
    if (pos + n > bytes.length) throw derError("truncated length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | bytes[pos + i];
    pos += n;
  }
  if (pos + len > bytes.length) throw derError("content overruns input");
  const value = bytes.subarray(pos, pos + len);
  const children: DerNode[] = [];
  if (tag & 0x20) {
    let inner = 0;
    while (inner < value.length) {
      const child = readTlv(value, inner);
      children.push(child.node);
      inner = child.offset;
    }
    if (inner !== value.length) throw derError("constructed content not exhausted");
  }
  return { node: { tag, value, children, size: pos + len - offset }, offset: pos + len };
};

/** Read all children of a constructed node (SEQUENCE/SET/context tags). */
export const derChildren = (node: DerNode): DerNode[] => node.children;

/** INTEGER content → bigint (handles sign byte). */
export const derInt = (node: DerNode): bigint => {
  if (node.tag !== TAG.INTEGER)
    throw derError(`expected INTEGER, got tag 0x${node.tag.toString(16)}`);
  let v = 0n;
  for (const b of node.value) v = (v << 8n) | BigInt(b);
  // Sign bit: only matters for negatives, which crypto keys never carry.
  return v;
};

export const derOid = (node: DerNode): string => {
  if (node.tag !== TAG.OID) throw derError(`expected OID, got tag 0x${node.tag.toString(16)}`);
  const b = node.value;
  if (b.length === 0) throw derError("empty OID");
  const parts: number[] = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = (v << 7) | (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
};

/** BIT STRING → content bytes (asserts 0 unused bits). */
export const derBitString = (node: DerNode): Uint8Array => {
  if (node.tag !== TAG.BIT_STRING)
    throw derError(`expected BIT STRING, got 0x${node.tag.toString(16)}`);
  if (node.value.length === 0 || node.value[0] !== 0)
    throw derError("unsupported non-octet-aligned BIT STRING");
  return node.value.subarray(1);
};

// ---- encoding ----

const encodeLen = (len: number): Uint8Array => {
  if (len < 0x80) return new Uint8Array([len]);
  const tmp: number[] = [];
  let l = len;
  while (l > 0) {
    tmp.unshift(l & 0xff);
    l >>>= 8;
  }
  return new Uint8Array([0x80 | tmp.length, ...tmp]);
};

export const tlv = (tag: number, content: Uint8Array): Uint8Array =>
  concatU8([new Uint8Array([tag]), encodeLen(content.length), content]);

export const derSeq = (...items: Uint8Array[]): Uint8Array => tlv(TAG.SEQUENCE, concatU8(items));

export const derOctetString = (bytes: Uint8Array): Uint8Array => tlv(TAG.OCTET_STRING, bytes);

export const derBitStringEncode = (bytes: Uint8Array): Uint8Array =>
  tlv(TAG.BIT_STRING, concatU8([new Uint8Array([0]), bytes]));

export const derNull = (): Uint8Array => new Uint8Array([TAG.NULL, 0]);

/** Unsigned bigint → INTEGER (left-pads 0x00 when the top bit would set sign). */
export const derIntEncode = (v: bigint): Uint8Array => {
  if (v < 0n) throw derError("negative INTEGER unsupported");
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes: Uint8Array = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  if (bytes.length === 0) bytes = new Uint8Array([0]);
  if (bytes[0] & 0x80) bytes = concatU8([new Uint8Array([0]), bytes]);
  return tlv(TAG.INTEGER, bytes);
};

export const derIntValue = (v: number): Uint8Array => derIntEncode(BigInt(v));

export const derOidEncode = (oid: string): Uint8Array => {
  const parts = oid.split(".").map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
    throw derError(`invalid OID "${oid}"`);
  }
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const group: number[] = [part & 0x7f];
    let v = part >>> 7;
    while (v > 0) {
      group.unshift(0x80 | (v & 0x7f));
      v >>>= 7;
    }
    out.push(...group);
  }
  return tlv(TAG.OID, new Uint8Array(out));
};

export const derContext = (n: 0 | 1 | 2 | 3, inner: Uint8Array): Uint8Array => tlv(0xa0 + n, inner);

// ---- PEM ----

const PEM_RE = /-----BEGIN ([A-Z0-9 ]+)-----([^-]*)-----END \1-----/;

export interface PemBlock {
  label: string;
  bytes: Uint8Array;
}

export const pemDecode = (pem: string): PemBlock => {
  const m = PEM_RE.exec(pem.trim());
  if (!m) throw derError("invalid PEM block");
  const b64 = m[2].replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = globalThis.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { label: m[1], bytes };
};

export const pemEncode = (label: string, der: Uint8Array): string => {
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = globalThis.btoa(bin);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};
