import { afterEach, describe, expect, it } from "vitest";
import cluster, { createClusterShim } from "./cluster.js";

/**
 * The cluster shim's contract, as Node's own lib/internal/cluster defines it:
 * 'fork' is emitted on the tick after fork() returns (never synchronously —
 * a handler that reads `worker` in its body would hit the temporal dead
 * zone), 'online' follows 'fork', and a cluster worker never forks.
 */

const shims = globalThis as unknown as {
  __browserContainers?: { shims?: Record<string, unknown> };
};

afterEach(() => {
  delete shims.__browserContainers;
});

describe("node:cluster shim", () => {
  it("emits 'fork' asynchronously, after fork() returns", async () => {
    const shim = createClusterShim();
    const seen: unknown[] = [];
    shim.on("fork", (worker) => seen.push(worker));

    const forked = shim.fork();

    // Synchronous emit would expose the worker before the caller has a
    // reference to it — Node emits on the next tick.
    expect(seen).toHaveLength(0);

    await Promise.resolve();
    expect(seen).toEqual([forked]);
  });

  it("emits 'fork' before 'online'", async () => {
    const shim = createClusterShim();
    const order: string[] = [];
    shim.on("fork", () => order.push("fork"));
    shim.on("online", () => order.push("online"));

    shim.fork();
    await Promise.resolve();
    await Promise.resolve();

    expect(order[0]).toBe("fork");
  });

  it("reports itself as primary outside a cluster worker realm", () => {
    const shim = createClusterShim();
    expect(shim.isPrimary).toBe(true);
    expect(shim.isWorker).toBe(false);
    expect(shim.isMaster).toBe(true);
  });

  it("exposes the Worker constructor and the scheduling constants (SCHED_NONE=1, SCHED_RR=2 as in Node)", () => {
    expect(typeof cluster.Worker).toBe("function");
    expect(cluster.SCHED_NONE).toBe(1);
    expect(cluster.SCHED_RR).toBe(2);
    expect(cluster.schedulingPolicy).toBe(2);
  });
});
