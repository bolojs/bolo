import { constants } from "unenv/node/vm";

export { constants };

const argTypeError = (name: string, expected: string, value: unknown): TypeError =>
  Object.assign(
    new TypeError(
      `The "${name}" argument must be of type ${expected}. Received ${
        value === null
          ? "null"
          : typeof value === "object" && value !== undefined
            ? `an instance of ${(value as { constructor?: { name?: string } }).constructor?.name ?? "Object"}`
            : `type ${typeof value} (${String(value)})`
      }`,
    ),
    { code: "ERR_INVALID_ARG_TYPE" },
  );

/** Marks a contextified sandbox; kept non-enumerable so `Object.keys` and JSON are unaffected. */
const kContextified = Symbol("bolo.vm.contextified");

interface ContextRecord {
  [kContextified]: true;
}

type ScopeProxyTarget = Record<string | symbol, unknown>;

/**
 * The scope chain object a vm script runs against: reads fall through to the
 * sandbox first, then the realm's globalThis (builtins like `Object` and
 * `JSON` resolve); writes land on the sandbox, so `var`/`this.x =` populate
 * the contextified object exactly like a Node context global.
 */
const makeScope = (sandbox: ScopeProxyTarget): ScopeProxyTarget =>
  new Proxy(sandbox, {
    has(_target, key) {
      // Symbol.unscopables must never be shadowed or `with` throws.
      return key !== Symbol.unscopables;
    },
    get(target, key, receiver) {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return Reflect.get(target, key, receiver);
      if (key in globalThis) return Reflect.get(globalThis, key);
      return undefined;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value);
    },
    defineProperty(target, key, descriptor) {
      return Reflect.defineProperty(target, key, descriptor);
    },
    deleteProperty(target, key) {
      return Reflect.deleteProperty(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
  });

/**
 * Compiles `code` as a sloppy vm script and runs it with `this` and the
 * global scope bound to `sandbox`, returning the script's completion value
 * like a real V8 script (`vm.runInContext('1+2') === 3`). Direct eval inside
 * the `with` shares the sandbox scope chain, so global reads/writes go
 * through the proxy. A "use strict" prologue in `code` is honored (strict
 * eval gets its own variable environment — matching real strict scripts,
 * where bare undeclared assignments throw).
 */
const runInSandbox = (code: string, sandbox: ScopeProxyTarget, filename?: string): unknown => {
  // sourceURL maps the eval to the script's filename in devtools stack traces.
  const source = filename ? `${code}\n//# sourceURL=${filename}` : code;
  const fn = new Function("scope", `with (scope) { return eval(${JSON.stringify(source)}); }`);
  return fn.call(sandbox, makeScope(sandbox));
};

const contextify = (sandbox: Record<string | symbol, unknown>): ContextRecord => {
  if (sandbox === null || (typeof sandbox !== "object" && typeof sandbox !== "function")) {
    throw argTypeError("sandbox", "Object", sandbox);
  }
  if (!Object.prototype.hasOwnProperty.call(sandbox, kContextified)) {
    Object.defineProperty(sandbox, kContextified, { value: true, configurable: true });
  }
  return sandbox as unknown as ContextRecord;
};

const assertContext = (contextifiedObject: unknown): ContextRecord => {
  if (!isContext(contextifiedObject)) {
    throw argTypeError("contextifiedObject", "vm.Context", contextifiedObject);
  }
  return contextifiedObject as ContextRecord;
};

const defaultFilename = "evalmachine.<anonymous>";

/**
 * A compiled vm script. The constructor converts the source with `String()`
 * up front — V8 compiles the ToString of the code, so a `toString()` that
 * throws must propagate from `new Script(code)` (test-vm-script-throw-in-tostring).
 */
export class Script {
  readonly #code: string;
  readonly #filename: string;
  #disposed = false;

  constructor(code: unknown, options?: { filename?: string }) {
    this.#code = String(code);
    this.#filename = options?.filename ?? defaultFilename;
  }

  runInContext(contextifiedObject: ContextRecord, options?: { filename?: string }): unknown {
    if (this.#disposed) {
      throw new Error("Script has already been disposed");
    }
    assertContext(contextifiedObject);
    return runInSandbox(
      this.#code,
      contextifiedObject as unknown as ScopeProxyTarget,
      options?.filename ?? this.#filename,
    );
  }

  runInNewContext(
    contextObject?: Record<string | symbol, unknown>,
    options?: { filename?: string },
  ): unknown {
    if (this.#disposed) {
      throw new Error("Script has already been disposed");
    }
    const sandbox = contextObject ?? {};
    contextify(sandbox);
    return runInSandbox(this.#code, sandbox, options?.filename ?? this.#filename);
  }

  runInThisContext(_options?: { filename?: string }): unknown {
    if (this.#disposed) {
      throw new Error("Script has already been disposed");
    }
    // Indirect eval: runs in the realm's global scope, `this` = realm global.
    return (0, eval)(this.#code);
  }

  createCachedData(): Uint8Array {
    // No code-cache machinery exists in a browser realm; an empty cache is a
    // valid (if useless) ScriptCompiler::CachedData equivalent.
    return new Uint8Array(0);
  }

  dispose(): void {
    this.#disposed = true;
  }
}

/** Contextifies `sandbox` and returns it; the sandbox becomes the context's global object. */
export const createContext = (
  sandbox?: Record<string | symbol, unknown>,
  _options?: unknown,
): ContextRecord => {
  return contextify(sandbox ?? {});
};

/** True when `sandbox` has been contextified with {@link createContext}. */
export const isContext = (sandbox: unknown): boolean => {
  return (
    sandbox !== null &&
    (typeof sandbox === "object" || typeof sandbox === "function") &&
    (sandbox as ContextRecord)[kContextified] === true
  );
};

/** Compiles and runs `code` inside the given contextified object. */
export const runInContext = (
  code: unknown,
  contextifiedObject: ContextRecord,
  options?: { filename?: string },
): unknown => {
  return new Script(code, { filename: options?.filename }).runInContext(contextifiedObject);
};

/** Contextifies `contextObject` (or a fresh object), runs `code` in it, and returns the result. */
export const runInNewContext = (
  code: unknown,
  contextObject?: Record<string | symbol, unknown>,
  options?: { filename?: string },
): unknown => {
  return new Script(code, { filename: options?.filename }).runInNewContext(contextObject);
};

/** Runs `code` in the realm's global scope, like an indirect eval. */
export const runInThisContext = (code: unknown, options?: { filename?: string }): unknown => {
  return new Script(code, { filename: options?.filename }).runInThisContext();
};

/**
 * Compiles `code` into a function with the given parameter names. The body
 * runs with the realm's builtins; a `parsingContext` option is accepted for
 * call-shape compatibility but cannot re-home the function (no cross-realm
 * compilation is available in a browser).
 */
export const compileFunction = (
  code: unknown,
  params?: string[],
  options?: { parsingContext?: ContextRecord; filename?: string },
): ((...args: unknown[]) => unknown) => {
  const paramList = Array.isArray(params) ? params.map(String) : [];
  if (options?.parsingContext !== undefined) assertContext(options.parsingContext);
  const body = String(code);
  const factory = new Function(...paramList, body);
  return (...args: unknown[]) => factory(...args);
};

/** Compatibility alias kept from Node's legacy `vm.createScript` API. */
export const createScript = (code: unknown, options?: { filename?: string }): Script => {
  return new Script(code, options);
};

export const measureMemory = () =>
  Promise.resolve({
    total: { jsMemoryEstimate: 0, jsMemoryRange: [1, 2] as [number, number] },
    WebAssembly: { code: 0, metadata: 0 },
  });

const vm = {
  Script,
  createContext,
  isContext,
  runInContext,
  runInNewContext,
  runInThisContext,
  compileFunction,
  createScript,
  measureMemory,
  constants,
};

/**
 * Creates a node:vm shim backed by realm-local contextification: the
 * sandbox object itself becomes the script's global object (`this`, global
 * var writes, and defineProperty all land on it), which preserves object
 * identity across the boundary — a WASM-heaped engine cannot.
 */
export const createVmShim = (): typeof vm => {
  return vm;
};

export default createVmShim();
