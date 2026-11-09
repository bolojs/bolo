/**
 * Node-style event loop for a process worker: timers phase then check phase
 * (setImmediate), one macrotask per callback, `process.nextTick` queue drained
 * after every callback, liveness from ref'd handles only.
 *
 * Why not the browser's timers directly: the browser orders equal-deadline
 * timers by wall-clock jitter, runs unref'd timers inside a "grace" window, and
 * delivers unhandled-rejection events later than Node does (before the next
 * callback). Owning the loop makes ordering deterministic: timers fire in
 * (expiry, creation-seq) order on a virtual clock that ignores scheduling
 * lateness, and every callback is followed by a real macrotask yield so the
 * browser raises `unhandledrejection` before the next callback runs.
 */

export interface LoopHandle {
  ref(): LoopHandle;
  unref(): LoopHandle;
  hasRef(): boolean;
  refresh(): LoopHandle;
}

interface Entry {
  fn: (...a: unknown[]) => void;
  args: unknown[];
  delay: number;
  repeat: boolean;
  expiry: number;
  seq: number;
  refed: boolean;
  active: boolean;
  running?: boolean;
  handle: LoopHandle;
}

export interface EventLoopDeps {
  now?: () => number;
  /** Runs the nextTick queue (called after every callback). */
  drainTicks?: () => void;
  /** Called when a callback throws. */
  onUncaught: (err: unknown) => void;
  /** True once the process has exited; the loop stops. */
  isExited: () => boolean;
}

/** Lateness above this is real (busy loop), below is our own scheduling slop. */
const LATE_MS = 20;

export const createEventLoop = (deps: EventLoopDeps) => {
  const now = deps.now ?? (() => performance.now());
  // Real realm primitives, captured before anything can shadow them.
  const realSet = globalThis.setTimeout.bind(globalThis);
  const realClear = globalThis.clearTimeout.bind(globalThis);

  let seq = 0;
  const timers = new Set<Entry>();
  let immediates: Array<{ fn: () => void; refed: boolean; active: boolean; handle: LoopHandle }> =
    [];

  // Virtual clock: vBase at the (real) moment realBase.
  let vBase = Math.floor(now());
  let realBase = now();
  const clock = () => Math.floor(vBase + (now() - realBase));
  const setClock = (v: number) => {
    vBase = v;
    realBase = now();
  };

  let wake: (() => void) | undefined;
  const poke = () => wake?.();

  const makeHandle = (state: { refed: boolean }, onRefresh?: () => void): LoopHandle => {
    const h: LoopHandle = {
      ref() {
        state.refed = true;
        return h;
      },
      unref() {
        state.refed = false;
        return h;
      },
      hasRef: () => state.refed,
      refresh() {
        onRefresh?.();
        return h;
      },
    };
    return h;
  };

  const insert = (e: Entry, start: number) => {
    e.expiry = start + e.delay;
    e.seq = seq++;
    e.active = true;
    timers.add(e);
  };

  const addTimer = (
    fn: (...a: unknown[]) => void,
    ms: number | undefined,
    args: unknown[],
    repeat: boolean,
  ) => {
    let delay = Number(ms);
    if (!(delay >= 1 && delay <= 2 ** 31 - 1)) delay = 1;
    delay = Math.trunc(delay);
    const e = { fn, args, delay, repeat, refed: true } as Entry;
    e.handle = makeHandle(e, () => {
      if (e.active) timers.delete(e);
      insert(e, clock());
      poke();
    });
    insert(e, clock());
    poke();
    return e;
  };

  const clear = (h: unknown) => {
    if (!h || typeof h !== "object") return;
    for (const e of timers) {
      if (e.handle === h) {
        e.active = false;
        timers.delete(e);
      }
    }
  };

  const setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    addTimer(fn, ms, args, false).handle;
  const setInterval = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    addTimer(fn, ms, args, true).handle;

  const setImmediate = (fn: (...a: unknown[]) => void, ...args: unknown[]) => {
    const rec = {
      fn: () => fn(...args),
      refed: true,
      active: true,
      handle: undefined as unknown as LoopHandle,
    };
    rec.handle = makeHandle(rec);
    immediates.push(rec);
    poke();
    return rec.handle;
  };
  const clearImmediate = (h: unknown) => {
    for (const r of immediates) if (r.handle === h) r.active = false;
  };

  const hasRefed = () => {
    for (const e of timers) if (e.refed) return true;
    for (const r of immediates) if (r.active && r.refed) return true;
    return false;
  };

  // A real task boundary: promise jobs and the browser's unhandledrejection
  // task must both run before this resolves. A timer alone is not enough (the
  // rejection task is posted on another task source), so hop through a
  // MessageChannel after the timer fires, as the old setImmediate did.
  const hop = (() => {
    try {
      const c = new MessageChannel();
      const q: Array<() => void> = [];
      c.port1.onmessage = () => q.shift()?.();
      return (f: () => void) => {
        q.push(f);
        c.port2.postMessage(0);
      };
    } catch {
      return (f: () => void) => void realSet(f, 0);
    }
  })();
  const yieldTask = () =>
    new Promise<void>((r) => realSet(() => hop(r), 0));

  const runCallback = async (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      deps.onUncaught(err);
    }
    try {
      deps.drainTicks?.();
    } catch (err) {
      deps.onUncaught(err);
    }
    await yieldTask();
  };

  const nextExpiry = () => {
    let min = Infinity;
    for (const e of timers) if (!e.running && e.expiry < min) min = e.expiry;
    return min;
  };

  const runTimersPhase = async () => {
    for (;;) {
      if (deps.isExited()) return;
      const t = nextExpiry();
      const real = clock();
      // Only groups the real clock has reached (Node re-checks `now` between lists).
      if (t === Infinity || t > real) return;
      setClock(real - t > LATE_MS ? real : t);
      const due = [...timers]
        .filter((e) => e.expiry === t && !e.running)
        .sort((a, b) => a.seq - b.seq);
      for (const e of due) {
        if (deps.isExited()) return;
        if (!e.active) continue;
        if (e.repeat) e.running = true;
        else {
          e.active = false;
          timers.delete(e);
        }
        await runCallback(() => e.fn(...e.args));
        if (e.repeat) {
          e.running = false;
          // Still registered (not cleared from inside its callback): re-arm.
          if (e.active && timers.has(e)) insert(e, clock());
        }
      }
    }
  };

  const runImmediatesPhase = async () => {
    const batch = immediates;
    immediates = [];
    for (const r of batch) {
      if (deps.isExited()) return;
      if (!r.active) continue;
      r.active = false;
      await runCallback(r.fn);
    }
  };

  const sleepUntilNext = () =>
    new Promise<void>((resolve) => {
      const t = nextExpiry();
      const ms = t === Infinity ? 1000 : Math.max(0, t - clock());
      const timer = realSet(() => done(), Math.min(ms, 1000));
      const done = () => {
        wake = undefined;
        realClear(timer);
        resolve();
      };
      wake = done;
    });

  /** Runs until no ref'd handle remains (or the process exits). */
  const run = async () => {
    while (!deps.isExited() && hasRefed()) {
      await runTimersPhase();
      await runImmediatesPhase();
      if (deps.isExited() || !hasRefed()) return;
      if (immediates.some((r) => r.active)) continue;
      await sleepUntilNext();
    }
  };

  return {
    setTimeout,
    setInterval,
    setImmediate,
    clearTimeout: clear,
    clearInterval: clear,
    clearImmediate,
    hasRefed,
    yieldTask,
    run,
    poke,
  };
};
