import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerWatchdog } from "./watchdog.js";

describe("WorkerWatchdog", () => {
  let worker: Worker;
  let terminateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    terminateSpy = vi.fn();
    worker = { terminate: terminateSpy } as unknown as Worker;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not terminate worker before 2 missed checks", () => {
    const wd = new WorkerWatchdog(worker, 5000);
    wd.start();

    vi.advanceTimersByTime(5000);
    expect(terminateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(terminateSpy).toHaveBeenCalled();
  });

  it("reset clears missed count preventing termination", () => {
    const wd = new WorkerWatchdog(worker, 5000);
    wd.start();

    vi.advanceTimersByTime(5000);
    wd.reset();

    vi.advanceTimersByTime(5000);
    expect(terminateSpy).not.toHaveBeenCalled();
  });

  it("stop clears the timer and prevents termination", () => {
    const wd = new WorkerWatchdog(worker, 5000);
    wd.start();
    wd.stop();

    vi.advanceTimersByTime(15_000);
    expect(terminateSpy).not.toHaveBeenCalled();
  });

  it("uses default interval of 5000ms", () => {
    const wd = new WorkerWatchdog(worker);
    wd.start();

    vi.advanceTimersByTime(4999);
    expect(terminateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(terminateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(terminateSpy).toHaveBeenCalled();
  });
});
