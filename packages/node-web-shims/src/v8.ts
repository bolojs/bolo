import _v8 from "unenv/node/v8";
import { Buffer as _BufferCtor } from "unenv/node/buffer";

export * from "unenv/node/v8";

const v8 = _v8 as unknown as Record<string, unknown>;

type BufferLike = { from: (v: string, enc: string) => Uint8Array };
const BufferCtor = _BufferCtor as unknown as BufferLike;
type BufferInstance = Uint8Array;

/**
 * `v8.serialize` returns a `Buffer` whose contents are opaque to callers —
 * the only hard contract is the `deserialize(serialize(v))` round-trip. Node
 * uses V8's structured-serialization format; there is no WASM serializer in
 * the runtime, so the payload here is a JSON body when the value admits one
 * (keeps the buffer inspectable) plus a WeakMap side-table keyed by the
 * returned buffer object carrying a `structuredClone` of the value. The
 * side-table path covers what JSON cannot (cycles, Map/Set, typed arrays);
 * `deserialize` on a foreign buffer throws a Node-coded error instead of
 * silently returning garbage.
 */
export const createV8Shim = (): typeof v8 & {
  serialize: (v: unknown) => BufferInstance;
  deserialize: (b: unknown) => unknown;
} => {
  const serializedValues = new WeakMap<object, unknown>();

  const serialize = (value: unknown): BufferInstance => {
    let payload = "";
    try {
      payload = JSON.stringify(value) ?? "";
    } catch {
      // Cyclic / unserializable-to-JSON values still round-trip through the
      // side-table; the byte payload is best-effort only.
    }
    const buf = BufferCtor.from(payload, "utf8") as BufferInstance;
    serializedValues.set(buf as unknown as object, value);
    return buf;
  };

  const deserialize = (buf: unknown): unknown => {
    if (buf && typeof buf === "object" && serializedValues.has(buf)) {
      const value = serializedValues.get(buf);
      return typeof structuredClone === "function" ? structuredClone(value) : value;
    }
    // Best-effort decode for a payload produced elsewhere in this realm.
    if (
      buf &&
      (buf instanceof Uint8Array ||
        (typeof buf === "object" && typeof (buf as { toString?: unknown }).toString === "function"))
    ) {
      const text = (buf as Uint8Array).toString();
      try {
        return JSON.parse(text);
      } catch {
        // fall through to the coded error
      }
    }
    throw Object.assign(
      new Error(
        "v8.deserialize: unable to deserialize the buffer — it was not produced by v8.serialize in this realm.",
      ),
      { code: "ERR_INVALID_ARG_VALUE" },
    );
  };

  return { ...v8, serialize, deserialize };
};

export const serialize = (value: unknown): BufferInstance => defaultShim.serialize(value);
export const deserialize = (buf: unknown): unknown => defaultShim.deserialize(buf);

const defaultShim = createV8Shim();

export default defaultShim;
