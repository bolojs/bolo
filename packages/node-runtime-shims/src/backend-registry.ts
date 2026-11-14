import type { BackendDeps, StreamBackend } from "./live.js";

/**
 * One candidate for a capability seam. Either a live backend instance, or a
 * named registration whose factory is invoked lazily (only if it wins).
 */
export interface BackendRegistration<B> {
  /** Diagnostic name — "tcp-relay", "loopback", "udp-relay", … */
  readonly name: string;
  readonly create: (deps: BackendDeps) => B;
  /** Transport protocols this registration covers, e.g. ["ws", "webtransport"]. */
  readonly protocols?: readonly string[];
}

/**
 * A seam candidate. `undefined` means "not offered" (skipped, like a rolldown
 * plugin hook returning null). Plain backend instances are treated as
 * anonymous registrations so hosts can pass either shape.
 */
export type BackendCandidate<B> = B | BackendRegistration<B> | undefined;

export const registration = <B>(
  name: string,
  create: (deps: BackendDeps) => B,
  protocols?: readonly string[],
): BackendRegistration<B> => ({ name, create, protocols });

const isRegistration = <B>(candidate: BackendCandidate<B>): candidate is BackendRegistration<B> =>
  candidate !== undefined &&
  candidate !== null &&
  typeof candidate === "object" &&
  "create" in (candidate as BackendRegistration<B>) &&
  typeof (candidate as BackendRegistration<B>).create === "function";

/**
 * Resolve an ordered candidate list for a capability seam, rolldown
 * `first`-hook semantics: the first present candidate wins; `undefined`
 * entries are skipped. Factories are invoked only for the winner (lazy —
 * transports/relays are constructed when the seam first resolves, matching
 * wasm-registry's promise-cache-on-first-resolve discipline).
 *
 * Returns the resolved backend and the winning registration's name so hosts
 * can surface which backend answered ("tcp-relay", "loopback", …).
 */
export const resolveBackend = <B>(
  candidates: readonly BackendCandidate<B>[],
  deps: BackendDeps,
): { backend: B; backendName: string } | undefined => {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (isRegistration(candidate)) {
      return { backend: candidate.create(deps), backendName: candidate.name };
    }
    return { backend: candidate, backendName: "anonymous" };
  }
  return undefined;
};
