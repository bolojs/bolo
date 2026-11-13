import { EventEmitter } from "./events.js";

/** Instance type — `events.ts` re-exports the class as a `const`, not a type. */
type AnyEmitter = InstanceType<typeof EventEmitter>;

/**
 * `node:domain` — deprecated, but still load-bearing for older code. A
 * faithful single-process port of Node's lib/domain.js: a domain stack kept
 * in sync with `process.domain` (when a process object exists), `'error'`
 * routing for member emitters, and error capture in `run`/`bind`/`intercept`.
 *
 * Deliberately not ported: the async_hooks pairing (no per-tick async
 * tracking in the browser), the `uncaughtExceptionCaptureCallback`
 * machinery, and the global `EventEmitter.prototype.emit` patch — member
 * emitters get a per-instance `emit` wrapper in `add()` instead, so merely
 * importing this module (unlike Node) has no effect on other emitters or on
 * `process.nextTick`.
 */

interface ProcessLike {
  domain?: Domain | null;
}

interface BrowserContainersLike {
  shims?: { process?: ProcessLike };
  process?: ProcessLike;
}

// Inside a process worker the live `process` is the container's process shim
// on `__browserContainers.shims.process` — there is no global `process` in
// that realm, so reading only `globalThis.process` would leave
// `process.domain` permanently unsynced.
const getProcess = (): ProcessLike | undefined => {
  const bc = (globalThis as { __browserContainers?: BrowserContainersLike })
    .__browserContainers;
  return bc?.shims?.process ?? bc?.process ?? (globalThis as { process?: ProcessLike }).process;
};

const setProcessDomain = (domain: Domain | null | undefined): void => {
  const proc = getProcess();
  if (proc) proc.domain = domain;
};

// It's possible to enter one domain while already inside another one. The
// stack is each entered domain.
const stack: Domain[] = [];

/** The active domain is always the one that we're currently in. */
export let active: Domain | null | undefined = null;

/** The domain stack, exported for introspection like Node's `domain._stack`. */
export const _stack = stack;

const originalEmits = new WeakMap<object, AnyEmitter["emit"]>();

const unhandledError = (): Error =>
  Object.assign(new Error("Unhandled error."), { code: "ERR_UNHANDLED_ERROR" });

const defineDomain = (target: object, domain: Domain | null): void => {
  Object.defineProperty(target, "domain", {
    configurable: true,
    enumerable: false,
    value: domain,
    writable: true,
  });
};

export class Domain extends EventEmitter {
  /** An array of event emitters that have been explicitly added to the domain. */
  members: AnyEmitter[] = [];

  /** Set when this domain is itself added to another domain. */
  domain?: Domain | null;

  enter(): void {
    active = this;
    setProcessDomain(this);
    stack.push(this);
  }

  exit(): void {
    // Don't do anything if this domain is not on the stack.
    const index = stack.lastIndexOf(this);
    if (index === -1) return;

    // Exit all domains until this one.
    stack.splice(index);

    active = stack.length === 0 ? undefined : stack[stack.length - 1];
    setProcessDomain(active);
  }

  run<T>(fn: (...args: any[]) => T, ...args: any[]): T {
    this.enter();
    try {
      return fn.apply(this, args);
    } catch (er) {
      // Route the error to the domain's 'error' event, like Node's
      // uncaughtException machinery would. Without a handler the error
      // keeps propagating.
      if (!this._errorHandler(er)) throw er;
      return undefined as T;
    } finally {
      this.exit();
    }
  }

  bind<T extends Function>(cb: T): T {
    // Unbound functions are not bound.
    if (typeof cb !== "function") return cb;

    const self = this;
    const runBound = function (this: unknown, ...args: unknown[]) {
      self.enter();
      try {
        return cb.apply(this, args);
      } catch (er) {
        if (!self._errorHandler(er)) throw er;
        return undefined;
      } finally {
        self.exit();
      }
    };

    defineDomain(runBound, this);
    return runBound as unknown as T;
  }

  intercept<T extends Function>(cb: T): T {
    const self = this;
    const runIntercepted = function (this: unknown, ...args: unknown[]) {
      if (args[0] instanceof Error) {
        const er = args[0];
        (er as { domainBound?: unknown }).domainBound = cb;
        (er as { domainThrown?: boolean }).domainThrown = false;
        defineDomain(er, self);
        self.emit("error", er);
        return;
      }

      self.enter();
      try {
        return cb.apply(this, args.slice(1));
      } catch (er) {
        if (!self._errorHandler(er)) throw er;
        return undefined;
      } finally {
        self.exit();
      }
    };

    return runIntercepted as unknown as T;
  }

  add(ee: AnyEmitter): void {
    const emitter = ee as AnyEmitter & { domain?: Domain | null };
    // If the domain is already added, then nothing left to do.
    if (emitter.domain === this) return;

    // Has a domain already - remove it first.
    if (emitter.domain) emitter.domain.remove(ee);

    // Check for circular Domain->Domain links. They cause big issues
    // (RangeError, stack overflow on `e.emit('error', er)`).
    if (this.domain && ee instanceof Domain) {
      for (let d: Domain | null | undefined = this.domain; d; d = d.domain) {
        if (ee === d) return;
      }
    }

    defineDomain(emitter, this);
    this.members.push(ee);
    this._interceptEmitter(ee);
  }

  remove(ee: AnyEmitter): void {
    (ee as AnyEmitter & { domain?: Domain | null }).domain = null;
    const index = this.members.indexOf(ee);
    if (index !== -1) this.members.splice(index, 1);

    const originalEmit = originalEmits.get(ee);
    if (originalEmit) {
      (ee as { emit: AnyEmitter["emit"] }).emit = originalEmit;
      originalEmits.delete(ee);
    }
  }

  /**
   * Called when an error was thrown inside this domain. Mirrors Node's
   * `Domain.prototype._errorHandler`: tags the error with the domain, pops
   * the domain off the stack so the handler runs outside of its own
   * context, and emits `'error'`. Returns whether the error was caught.
   */
  _errorHandler(er: unknown): boolean {
    let caught = false;

    if ((typeof er === "object" && er !== null) || typeof er === "function") {
      defineDomain(er, this);
      (er as { domainThrown?: boolean }).domainThrown = true;
    }
    // Pop all adjacent duplicates of the currently active domain from the
    // stack, so the error handler does not run within its own context.
    while (active === this) this.exit();

    if (stack.length === 0) {
      // If there's no error handler, do not emit an 'error' event as this
      // would throw and mask the original error.
      if (this.listenerCount("error") > 0) {
        caught = this.emit("error", er);
      }
    } else {
      try {
        caught = this.emit("error", er);
      } catch (er2) {
        // The domain error handler threw. See if another domain can catch
        // this error, or else rethrow.
        const parent = stack[stack.length - 1];
        active = parent;
        setProcessDomain(parent);
        caught = parent._errorHandler(er2);
      }
    }

    // Exit all domains on the stack. Uncaught exceptions end the current
    // tick and no domains should be left on the stack between ticks.
    stack.length = 0;
    active = null;
    setProcessDomain(null);

    return caught;
  }

  /**
   * Routes `'error'` events on a member emitter to this domain, mirroring
   * the effect of Node's global `EventEmitter.prototype.emit` patch without
   * mutating other emitters.
   */
  private _interceptEmitter(ee: AnyEmitter): void {
    if (originalEmits.has(ee)) return;
    const originalEmit = ee.emit;
    originalEmits.set(ee, originalEmit);
    const emitter = ee as AnyEmitter & { domain?: Domain | null };

    emitter.emit = (type: string | symbol, ...args: unknown[]): boolean => {
      const domain = emitter.domain;
      const shouldEmitError = type === "error" && emitter.listenerCount("error") > 0;

      // Just call the original `emit` if the emitter has an 'error'
      // handler or there's no domain.
      if (shouldEmitError || domain === null || domain === undefined) {
        return originalEmit.call(emitter, type, ...args);
      }

      if (type === "error") {
        const er = args.length > 0 && args[0] ? args[0] : unhandledError();
        if (typeof er === "object" && er !== null) {
          (er as { domainEmitter?: unknown }).domainEmitter = emitter;
          defineDomain(er, domain);
          (er as { domainThrown?: boolean }).domainThrown = false;
        }

        // Remove the current domain (and its duplicates) from the stack so
        // the domain's error handler doesn't run in its own context, then
        // restore the stack once it has completed.
        const origStack = stack.slice();
        const origActive = active;

        let idx = stack.length - 1;
        while (idx > -1 && active === stack[idx]) --idx;
        if (idx < 0) {
          stack.length = 0;
        } else {
          stack.splice(idx + 1);
        }
        active = stack.length === 0 ? null : stack[stack.length - 1];
        setProcessDomain(active);

        domain.emit("error", er);

        stack.length = 0;
        stack.push(...origStack);
        active = origActive;
        setProcessDomain(origActive);

        return false;
      }

      domain.enter();
      try {
        return originalEmit.call(emitter, type, ...args);
      } finally {
        domain.exit();
      }
    };
  }
}

export const createDomain = (): Domain => new Domain();
export const create = createDomain;

export interface DomainModule {
  create: typeof create;
  createDomain: typeof createDomain;
  Domain: typeof Domain;
  readonly active: Domain | null | undefined;
  readonly _stack: readonly Domain[];
}

export const createDomainShim = (): DomainModule => ({
  create,
  createDomain,
  Domain,
  get active() {
    return active;
  },
  _stack: stack,
});

export default createDomainShim();
