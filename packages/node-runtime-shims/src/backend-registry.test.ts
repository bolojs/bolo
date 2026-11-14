import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { resolveBackend, registration } from "./backend-registry.js";
import type { BackendDeps } from "./live.js";

const deps = (): BackendDeps => ({ vfs: new VfsBus() });

describe("resolveBackend", () => {
  it("returns undefined when every candidate is absent", () => {
    expect(resolveBackend([undefined, undefined], deps())).toBeUndefined();
  });

  it("skips absent candidates and picks the first present one", () => {
    const d = deps();
    const a = { id: "a" };
    const b = { id: "b" };
    const resolved = resolveBackend([undefined, a, b], d);
    expect(resolved?.backend).toBe(a);
  });

  it("honours candidate order — the first present candidate wins", () => {
    const d = deps();
    const first = { id: "first" };
    const second = { id: "second" };
    const resolved = resolveBackend(
      [registration("first", () => first), registration("second", () => second)],
      d,
    );
    expect(resolved?.backend).toBe(first);
    expect(resolved?.backendName).toBe("first");
  });

  it("invokes only the winning factory (lazy activation)", () => {
    const d = deps();
    const calls: string[] = [];
    const resolved = resolveBackend(
      [
        registration("a", () => {
          calls.push("a");
          return { id: "a" };
        }),
        registration("b", () => {
          calls.push("b");
          return { id: "b" };
        }),
      ],
      d,
    );
    expect(resolved?.backendName).toBe("a");
    expect(calls).toEqual(["a"]);
  });

  it("passes the backend deps to the factory", () => {
    const d = deps();
    let seen: BackendDeps | undefined;
    resolveBackend(
      [
        registration("a", (received) => {
          seen = received;
          return {};
        }),
      ],
      d,
    );
    expect(seen).toBe(d);
    expect(seen?.vfs).toBe(d.vfs);
  });

  it("treats a bare backend instance as an anonymous candidate", () => {
    const backend = { id: "bare" };
    const resolved = resolveBackend([backend], deps());
    expect(resolved?.backend).toBe(backend);
    expect(resolved?.backendName).toBe("anonymous");
  });

  it("surfaces a factory failure with the backend name attached", () => {
    const failure = new Error("relay unreachable");
    try {
      resolveBackend(
        [
          registration("tcp-relay", () => {
            throw failure;
          }),
        ],
        deps(),
      );
      expect.unreachable("factory should have thrown");
    } catch (err) {
      // A broken backend must not be rewritten into an "unsupported" error:
      // misconfiguration has to stay distinguishable from absence.
      expect(err).toBe(failure);
    }
  });
});
