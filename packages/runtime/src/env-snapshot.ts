/**
 * process.env in the worker realm is a ToString-coercion Proxy over a plain
 * backing record (process-shim.ts). Proxies are not structured-cloneable, so
 * `structuredClone(process.env)` — which works in real Node (test-process-env)
 * — throws DataCloneError here. These helpers keep the env clone-safe at the
 * runtime layer without touching the shim:
 *
 * - `snapshotEnv` — plain string-key/string-value record, safe for
 *   structuredClone/postMessage (used to hand the parent env to a spawned
 *   child when no explicit `options.env` is given, matching Node's default
 *   inherit behavior).
 * - `wrapEnv` — forwards to the coercion proxy but drops empty-name
 *   assignments, which POSIX ignores (Node test-process-env).
 * - `installStructuredCloneFallback` — wraps globalThis.structuredClone so a
 *   value native cloning rejects (e.g. the env Proxy) is deep-copied into a
 *   plain cloneable snapshot and the clone retried. Cycles are preserved;
 *   anything still un-cloneable rethrows, matching native behavior.
 */

const snapshotForClone = (value: unknown, seen: Map<object, unknown>): unknown => {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    seen.set(value, arr);
    for (const item of value) arr.push(snapshotForClone(item, seen));
    return arr;
  }
  if (value instanceof Map) {
    const map = new Map<unknown, unknown>();
    seen.set(value, map);
    for (const [key, item] of value) map.set(key, snapshotForClone(item, seen));
    return map;
  }
  if (value instanceof Set) {
    const set = new Set<unknown>();
    seen.set(value, set);
    for (const item of value) set.add(snapshotForClone(item, seen));
    return set;
  }
  const record: Record<string, unknown> = {};
  seen.set(value, record);
  for (const key of Object.keys(value)) {
    record[key] = snapshotForClone((value as Record<string, unknown>)[key], seen);
  }
  return record;
};

export const snapshotEnv = (env: unknown): Record<string, string> => {
  const record: Record<string, string> = {};
  if (env === null || typeof env !== "object") return record;
  for (const [key, value] of Object.entries(env)) {
    record[key] = String(value);
  }
  return record;
};

export const wrapEnv = (env: Record<string, string>): Record<string, string> =>
  new Proxy(env, {
    set: (target, key, value) => {
      // POSIX ignores empty-named environment assignments (test-process-env).
      if (key === "") return true;
      return Reflect.set(target, key, value);
    },
  }) as Record<string, string>;

export const installStructuredCloneFallback = (): void => {
  const native = globalThis.structuredClone;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    try {
      return native(value, options);
    } catch (err) {
      if ((err as { name?: string } | null)?.name !== "DataCloneError") throw err;
      return native(snapshotForClone(value, new Map()), options);
    }
  }) as typeof structuredClone;
};
