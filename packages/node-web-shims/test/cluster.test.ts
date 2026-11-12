import { describe, it, expect } from "vitest";
import cluster, {
  fork,
  disconnect,
  setupPrimary,
  setupMaster,
  Worker,
  SCHED_NONE,
  SCHED_RR,
  isMaster,
  isPrimary,
  isWorker,
  worker,
  schedulingPolicy,
  settings,
  workers,
} from "../src/cluster.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("node-web-shims: cluster", () => {
  it("reports the primary surface", () => {
    expect(isPrimary).toBe(true);
    expect(isMaster).toBe(true);
    expect(isWorker).toBe(false);
    expect(worker).toBeUndefined();
    expect(schedulingPolicy).toBe(SCHED_RR);
    expect(SCHED_RR).toBe(2);
    expect(SCHED_NONE).toBe(1);
    expect(settings).toEqual({});
    expect(cluster.isPrimary).toBe(true);
    expect(cluster.Worker).toBe(Worker);
  });

  it("fork returns a Worker registered in workers with an incrementing id", async () => {
    const first = fork();
    const second = fork();
    expect(first).toBeInstanceOf(Worker);
    expect(second).toBeInstanceOf(Worker);
    expect(second.id).toBeGreaterThan(first.id);
    expect(workers[first.id]).toBe(first);
    expect(workers[second.id]).toBe(second);
    await flush();
    first.kill();
    second.kill();
    await flush();
  });

  it("emits fork/online asynchronously with the worker, and tracks state", async () => {
    const events: Array<{ name: string; arg: unknown }> = [];
    cluster.on("fork", (w) => events.push({ name: "fork", arg: w }));
    cluster.on("online", (w) => events.push({ name: "online", arg: w }));

    const w = fork();
    expect(w.state).toBe("none");
    expect(events).toEqual([]);

    let onlineThis: unknown;
    w.on("online", function (this: unknown) {
      onlineThis = this;
    });

    await flush();
    expect(events.map((e) => e.name)).toEqual(["fork", "online"]);
    expect(events[0].arg).toBe(w);
    expect(events[1].arg).toBe(w);
    expect(w.state).toBe("online");
    expect(onlineThis).toBe(w);

    w.kill();
    await flush();
  });

  it("exit fires with (0, null) matching worker.process, removes from workers, re-emits on cluster", async () => {
    const w = fork();
    const exitArgs: unknown[] = [];
    let clusterExitWorker: unknown;
    w.on("exit", (...args: unknown[]) => exitArgs.push(...args));
    cluster.on("exit", (cw) => {
      clusterExitWorker = cw;
    });

    await flush();
    w.kill();
    await flush();

    expect(w.isDead()).toBe(true);
    expect(w.state).toBe("dead");
    expect(exitArgs).toEqual([0, null]);
    expect(w.process.exitCode).toBe(0);
    expect(w.process.signalCode).toBeNull();
    expect(clusterExitWorker).toBe(w);
    expect(workers[w.id]).toBeUndefined();
  });

  it("invalid NODE_CLUSTER control message makes the worker exit (test-cluster-invalid-message)", async () => {
    const w = fork();
    const exitArgs: unknown[] = [];
    w.on("exit", (...args: unknown[]) => exitArgs.push(...args));

    await flush();
    let sendCallbackCalled = false;
    w.send({ cmd: "NODE_CLUSTER", ack: -1 }, () => {
      sendCallbackCalled = true;
      w.disconnect();
    });

    await flush();
    expect(sendCallbackCalled).toBe(true);
    expect(exitArgs).toEqual([0, null]);
    expect(workers[w.id]).toBeUndefined();
  });

  it("disconnect emits on worker and cluster, then destroy exits (test-cluster-call-and-destroy)", async () => {
    const w = fork();
    let disconnectEvents = 0;
    let clusterDisconnectWorker: unknown;
    w.on("disconnect", () => {
      disconnectEvents += 1;
      expect(w.isConnected()).toBe(false);
      w.destroy();
    });
    cluster.on("disconnect", (cw) => {
      clusterDisconnectWorker = cw;
    });

    await flush();
    expect(w.isConnected()).toBe(true);
    w.disconnect();
    await flush();

    expect(disconnectEvents).toBe(1);
    expect(clusterDisconnectWorker).toBe(w);
    expect(w.isDead()).toBe(true);
    expect(w.exitedAfterDisconnect).toBe(true);
  });

  it("setupPrimary/setupMaster accept settings and merge them", () => {
    setupPrimary({ execArgv: [] });
    setupMaster({ silent: true });
    expect(settings).toEqual({ execArgv: [], silent: true });
  });

  it("cluster.disconnect disconnects all workers and calls back", async () => {
    const w = fork();
    await flush();
    let called = false;
    disconnect(() => {
      called = true;
    });
    await flush();
    expect(w.isConnected()).toBe(false);
    expect(called).toBe(true);
  });
});
