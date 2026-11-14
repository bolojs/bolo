// CommonJS source written to the container VFS at /test/common/index.js.
// Node's own test files `require('../common')`, so this must be vanilla CJS
// (no TS, no ESM). It mirrors the semantics of Node's test/common that decide
// pass/fail: call-count checks at exit, `skip` bailing out, platform timeouts.
// Faithfulness matters more than coverage: a stub that never fails scores
// false passes (see .agents/plans/2026-11-07-release-mechanics-and-verification.md).
export const commonIndexSource = String.raw`'use strict';
const assert = require('assert');
// util.inspect is partial in the web shim; degrade to String() rather than
// letting error-formatting helpers throw TypeErrors of their own.
const utilInspect = (() => {
  try {
    const { inspect } = require('util');
    return typeof inspect === 'function' ? inspect : (v) => String(v);
  } catch {
    return (v) => String(v);
  }
})();

const noop = () => {};
const mustCallChecks = [];

function runCallChecks(exitCode) {
  if (exitCode !== 0) return;
  const failed = mustCallChecks.filter((check) =>
    check.atLeast !== undefined ? check.actual < check.atLeast : check.actual !== check.exact,
  );
  if (failed.length === 0) return;
  for (const check of failed) {
    const expected = check.atLeast !== undefined ? 'at least ' + check.atLeast : check.exact;
    console.error('Mismatched ' + check.name + ' function calls. Expected ' + expected + ', actual ' + check.actual + '.');
  }
  process.exit(1);
}

function register(fn, name, exact, atLeast) {
  if (process._exiting) throw new Error('Cannot use common.mustCall*() in process exit handler');
  // Node: mustCall(n) is shorthand for mustCall(noop, n).
  if (typeof fn === 'number') {
    if (atLeast === undefined) exact = fn;
    else atLeast = fn;
    fn = noop;
  }
  if (fn === undefined) fn = noop;
  if (mustCallChecks.length === 0) process.on('exit', runCallChecks);
  const check = { name: name || fn.name || '<anonymous>', exact, atLeast, actual: 0 };
  mustCallChecks.push(check);
  return function (...args) {
    check.actual++;
    return fn.apply(this, args);
  };
}

const mustCall = (fn, exact = 1) => register(fn, undefined, exact, undefined);
const mustCallAtLeast = (fn, minimum = 1) => register(fn, undefined, undefined, minimum);
const mustNotCall = (msg) => function mustNotCall(...args) {
  const argsInfo = args.length > 0 ? '\ncalled with arguments: ' + args.map(String).join(', ') : '';
  assert.fail((msg || 'function should not have been called') + argsInfo);
};
const mustSucceed = (fn, exact = 1) =>
  mustCall(function (err, ...args) {
    assert.ifError(err);
    if (typeof fn === 'function') return fn.apply(this, args);
  }, exact);

// Node's expectsError: returns a mustCall'd checker asserting the thrown error's shape.
const expectsError = (validator, exact) =>
  mustCall((...args) => {
    const error = args.pop();
    assert.throws(() => { throw error; }, validator);
    return true;
  }, exact);

const skip = (msg) => {
  console.log('1..0 # SKIP ' + (msg || ''));
  process.exit(0);
};

// Passes only when the process ends with the given exit code.
const expectExitCode = (expected) => {
  process.on('exit', (actual) => {
    if (actual === expected) {
      process.exit(0);
    } else {
      console.error('Expected exit code ' + expected + ', got ' + actual);
      process.exit(actual === 0 ? 1 : actual);
    }
  });
};

const isWindows = process.platform === 'win32';
const isAIX = process.platform === 'aix';
const isIBMi = process.platform === 'os400';

// The helpers below mirror Node's test/common verbatim where the semantics are
// implementable in a browser container.

const _mustNotMutateObjectDeepProxies = new WeakMap();
function mustNotMutateObjectDeep(original) {
  if (original === null || typeof original !== 'object') {
    return original;
  }
  const cachedProxy = _mustNotMutateObjectDeepProxies.get(original);
  if (cachedProxy) {
    return cachedProxy;
  }
  const handler = {
    __proto__: null,
    defineProperty(target, property, descriptor) {
      assert.fail('Expected no side effects, got ' + utilInspect(property) + ' defined');
    },
    deleteProperty(target, property) {
      assert.fail('Expected no side effects, got ' + utilInspect(property) + ' deleted');
    },
    get(target, prop, receiver) {
      return mustNotMutateObjectDeep(Reflect.get(target, prop, receiver));
    },
    preventExtensions(target) {
      assert.fail('Expected no side effects, got extensions prevented on ' + utilInspect(target));
    },
    set(target, property, value, receiver) {
      assert.fail('Expected no side effects, got ' + utilInspect(value) +
                  ' assigned to ' + utilInspect(property));
    },
    setPrototypeOf(target, prototype) {
      assert.fail('Expected no side effects, got set prototype to ' + prototype);
    },
  };
  const proxy = new Proxy(original, handler);
  _mustNotMutateObjectDeepProxies.set(original, proxy);
  return proxy;
}

function invalidArgTypeHelper(input) {
  if (input == null) {
    return ' Received ' + input;
  }
  if (typeof input === 'function') {
    return ' Received function ' + input.name;
  }
  if (typeof input === 'object') {
    if (input.constructor?.name) {
      return ' Received an instance of ' + input.constructor.name;
    }
    return ' Received ' + utilInspect(input, { depth: -1 });
  }

  let inspected = utilInspect(input, { colors: false });
  if (inspected.length > 28) { inspected = inspected.slice(inspected, 0, 25) + '...'; }

  return ' Received type ' + typeof input + ' (' + inspected + ')';
}

const pwdCommand = isWindows ? ['cmd.exe', ['/d', '/c', 'cd']] : ['pwd', []];

function spawnPromisified(...args) {
  let stderr = '';
  let stdout = '';
  const { spawn } = require('child_process');
  const child = spawn(...args);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => { stdout += data; });
  return new Promise((resolve, reject) => {
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
    child.on('error', (code, signal) => {
      reject({ code, signal, stderr, stdout });
    });
  });
}

let catchWarning;
function _expectWarning(name, expected, code) {
  if (typeof expected === 'string') {
    expected = [[expected, code]];
  } else if (!Array.isArray(expected)) {
    expected = Object.entries(expected).map(([a, b]) => [b, a]);
  } else if (expected.length !== 0 && !Array.isArray(expected[0])) {
    expected = [[expected[0], expected[1]]];
  }
  if (name === 'DeprecationWarning') {
    expected.forEach(([, code]) => assert(code, 'Missing deprecation code: ' + expected));
  }
  return mustCall((warning) => {
    const expectedProperties = expected.shift();
    if (!expectedProperties) {
      assert.fail('Unexpected extra warning received: ' + warning);
    }
    const [message, code] = expectedProperties;
    assert.strictEqual(warning.name, name);
    if (typeof message === 'string') {
      assert.strictEqual(warning.message, message);
    } else {
      assert.match(warning.message, message);
    }
    assert.strictEqual(warning.code, code);
  }, expected.length);
}

function expectWarning(nameOrMap, expected, code) {
  if (catchWarning === undefined) {
    catchWarning = {};
    process.on('warning', (warning) => {
      if (!catchWarning[warning.name]) {
        throw new TypeError(
          '"' + warning.name + '" was triggered without being expected.\n' + utilInspect(warning),
        );
      }
      catchWarning[warning.name](warning);
    });
  }
  if (typeof nameOrMap === 'string') {
    catchWarning[nameOrMap] = _expectWarning(nameOrMap, expected, code);
  } else {
    Object.keys(nameOrMap).forEach((name) => {
      catchWarning[name] = _expectWarning(name, nameOrMap[name]);
    });
  }
}

const isDumbTerminal = !!(process.env && process.env.TERM === 'dumb');

const printSkipMessage = (msg) => {
  console.log('1..0 # Skipped: ' + msg);
};

const skipIfDumbTerminal = () => {
  if (isDumbTerminal) skip('skipping - dumb terminal');
};

const hasFipsCrypto = (() => {
  try {
    const c = typeof crypto !== 'undefined' && require('crypto');
    return !!(c && typeof c.getFips === 'function' && c.getFips());
  } catch {
    return false;
  }
})();

// Mirrors Node's test/common platformTimeout for the platforms we can detect.
// Node's test/common escapePOSIXShell: build a POSIX shell command that
// passes interpolated values through the environment instead of quoting them.
const escapePOSIXShell = (cmdParts, ...args) => {
  if (isWindows) {
    return [String.raw({ raw: cmdParts }, ...args)];
  }
  const env = { ...process.env };
  let cmd = cmdParts[0];
  for (let i = 0; i < args.length; i++) {
    const envVarName = `ESCAPED_${i}`;
    env[envVarName] = args[i];
    cmd += '${' + envVarName + '}' + cmdParts[i + 1];
  }
  return [cmd, { env }];
};

const platformTimeout = (ms) => {
  const big = typeof ms === 'bigint';
  const two = big ? 2n : 2;
  const four = big ? 4n : 4;
  const seven = big ? 7n : 7;
  if (process.features && process.features.debug) ms = two * ms;
  if (isAIX || isIBMi) return two * ms;
  if (isWindows) return two * ms;
  const arch = String(process.arch || '');
  if (arch.includes('arm')) return seven * ms;
  if (arch.includes('ppc') || arch.includes('s390')) return four * ms;
  return ms;
};

module.exports = {
  mustCall,
  mustCallAtLeast,
  mustNotCall,
  mustSucceed,
  expectsError,
  expectExitCode,
  skip,
  noop,
  getOption: (name) => process.env && process.env[name],
  platform: process.platform,
  fixturesDir: '/test/fixtures',
  tmpdir: '/tmp',
  rootDir: '/test',
  isWindows,
  isAIX,
  isIBMi,
  isLinux: process.platform === 'linux',
  isOSX: process.platform === 'darwin',
  isMacOS: process.platform === 'darwin',
  isMainThread: true,
  hasIntl: typeof Intl !== 'undefined',
  hasCrypto: typeof crypto !== 'undefined',
  canCreateWorker: typeof Worker !== 'undefined',
  hasWasm: typeof WebAssembly !== 'undefined',
  platformTimeout,
  escapePOSIXShell,
  skipIfWorker: noop,
  skipIfEslintDisabled: noop,
  skipIfInspectorDisabled: noop,
  skipIf32Bits: noop,
  getArrayBufferViews: (buf) => [buf],
  mustNotMutateObjectDeep,
  invalidArgTypeHelper,
  pwdCommand,
  spawnPromisified,
  expectWarning,
  isDumbTerminal,
  skipIfDumbTerminal,
  printSkipMessage,
  hasFipsCrypto,
};
`;

// Mirrors Node's test/common/countdown.js (written to /test/common/countdown.js).
export const countdownSource = String.raw`'use strict';
const assert = require('assert');
const kLimit = Symbol('limit');
const kCallback = Symbol('callback');
const common = require('./index.js');
class Countdown {
  constructor(limit, cb) {
    assert.strictEqual(typeof limit, 'number');
    assert.strictEqual(typeof cb, 'function');
    this[kLimit] = limit;
    this[kCallback] = common.mustCall(cb);
  }
  dec() {
    assert(this[kLimit] > 0, 'Countdown expired');
    if (--this[kLimit] === 0) this[kCallback]();
    return this[kLimit];
  }
  get remaining() { return this[kLimit]; }
}
module.exports = Countdown;
`;

// CJS sources written under /test/node_modules/internal/ so Node test files
// that `require('internal/<name>')` (the --expose-internals surface) resolve
// through plain node_modules lookup. Only modules with a browser-faithful
// subset are shimmed; internals with no faithful JS semantics stay unresolved
// so those tests fail with honest expected-fail reasons instead of silently
// degraded behavior. "node:test" is also shimmed here; runner.ts writes it as
// a package directory (/test/node_modules/node:test/index.js) because the
// bundler's bare-specifier resolver only matches existing directories.
export const internalShimSources: Record<string, string> = {
  // internal/event_target: NodeEventTarget keeps its listener registry in a
  // kEvents-keyed Map so tests can inspect it (test-events-once,
  // test-timers-*-promisified).
  "internal/event_target": String.raw`'use strict';
const kEvents = Symbol('kEvents');

class NodeEventTarget extends EventTarget {
  constructor() {
    super();
    this[kEvents] = new Map();
  }
  addEventListener(type, listener, options) {
    if (listener != null) {
      let set = this[kEvents].get(type);
      if (!set) {
        set = new Set();
        this[kEvents].set(type, set);
      }
      set.add(listener);
    }
    return super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    const set = this[kEvents].get(type);
    if (set) set.delete(listener);
    return super.removeEventListener(type, listener, options);
  }
}

module.exports = { NodeEventTarget, kEvents };
`,

  // internal/util: the manifest's tests only need promisified sleep.
  "internal/util": String.raw`'use strict';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = { sleep };
`,

  // internal/test/binding: Node's --expose-internals test seam. Only bindings
  // whose JS-visible semantics the browser container can reproduce faithfully
  // are exposed; anything else throws "No such binding" like Node does for an
  // unknown internal binding, rather than returning a fabricated object.
  // (Node's module also exports `primordials`; nothing in the vendored
  // sources needs it, so it is intentionally omitted.)
  "internal/test/binding": String.raw`'use strict';
const bindings = {
  timers: {
    // uv_now(): monotonic whole milliseconds since the event loop started.
    // The container worker's clock starts at process boot, matching libuv's
    // loop time base (uv_now is NOT wall-clock time).
    getLibuvNow: (() => {
      const started = performance.now();
      return () => Math.floor(performance.now() - started);
    })(),
  },
  // Node's performance binding exposes observerCounts — a live Uint32Array
  // counting the active observers per native observer type ('gc', 'http',
  // 'http2', 'net', 'dns'). The perf_hooks shim owns those counters.
  performance: {
    get observerCounts() {
      return globalThis.__browserContainers?.shims?.perf_hooks?.observerCounts ?? new Uint32Array(6);
    },
    get performanceObserverCounts() {
      return globalThis.__browserContainers?.shims?.perf_hooks?.observerCounts ?? new Uint32Array(6);
    },
  },
  // js_stream: Node's binding wraps a JS-implemented stream for C++
  // consumers. The vendored tests only need the constructor surface — a
  // faithful byte-pipe is out of scope for the browser container.
  js_stream: {
    JSStream: class JSStream {
      constructor() {
        this._externalStream = undefined;
      }
    },
  },
  // tty_wrap: Node's TTY binding. The vendored test only needs the
  // constructor and isTTY predicate to exist so node:tty's WriteStream can
  // be constructed; a browser has no file descriptors, so every fd is a TTY.
  tty_wrap: {
    TTY: class TTY {
      constructor(fd) {
        this.fd = fd;
      }
      setBlocking() { return 0; }
      getWindowSize(size) { if (size) { size[0] = 80; size[1] = 24; } return 0; }
      setRawMode() { return 0; }
    },
    isTTY: () => true,
  },
};

const internalBinding = (id) => {
  if (typeof id !== 'string') throw new TypeError('binding id must be a string');
  if (id.startsWith('internal_only')) {
    const error = new Error('No such binding: ' + id);
    error.code = 'ERR_INVALID_MODULE';
    throw error;
  }
  const binding = bindings[id];
  if (binding === undefined) {
    const error = new Error('No such binding: ' + id);
    error.code = 'ERR_INVALID_MODULE';
    throw error;
  }
  return binding;
};

module.exports = { internalBinding };
`,

  // internal/linkedlist: vendored verbatim from Node v22.12.0
  // lib/internal/linkedlist.js (pure JS, no primordials in that tree).
  "internal/linkedlist": String.raw`'use strict';

function init(list) {
  list._idleNext = list;
  list._idlePrev = list;
  return list;
}

// Show the most idle item.
function peek(list) {
  if (list._idlePrev === list) return null;
  return list._idlePrev;
}

// Remove an item from its list.
function remove(item) {
  if (item._idleNext) {
    item._idleNext._idlePrev = item._idlePrev;
  }

  if (item._idlePrev) {
    item._idlePrev._idleNext = item._idleNext;
  }

  item._idleNext = null;
  item._idlePrev = null;
}

// Remove an item from its list and place at the end.
function append(list, item) {
  if (item._idleNext || item._idlePrev) {
    remove(item);
  }

  // Items are linked  with _idleNext -> (older) and _idlePrev -> (newer).
  // Note: This linkage (next being older) may seem counter-intuitive at first.
  item._idleNext = list._idleNext;
  item._idlePrev = list;

  // The list _idleNext points to tail (newest) and _idlePrev to head (oldest).
  list._idleNext._idlePrev = item;
  list._idleNext = item;
}

function isEmpty(list) {
  return list._idleNext === list;
}

module.exports = {
  init,
  peek,
  remove,
  append,
  isEmpty,
};
`,

  // internal/timers: browser-faithful subset of lib/internal/timers.js.
  // setUnrefTimeout layers on the container's tracked setTimeout, which
  // returns real Timeout objects with unref()/refresh()/hasRef() — the same
  // surface Node's internal/timers provides. Ordering semantics (a refreshed
  // or unref'd timer yields to an already-queued timer of the same expiry)
  // come from the container event loop, which sorts due timers by
  // (expiry, creation sequence).
  "internal/timers": String.raw`'use strict';

function setUnrefTimeout(callback, after, ...args) {
  if (typeof callback !== 'function') {
    let received;
    if (callback === null) received = ' Received null';
    else if (typeof callback === 'object') {
      const name = callback.constructor && callback.constructor.name;
      received = name ? ' Received an instance of ' + name : ' Received ' + String(callback);
    } else {
      received = ' Received type ' + typeof callback + ' (' + String(callback) + ')';
    }
    const error = new TypeError(
      'The "callback" argument must be of type function.' + received,
    );
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  return setTimeout(callback, after, ...args).unref();
}

module.exports = { setUnrefTimeout };
`,

  // node:test: minimal serial runner. Tests declared with test()/it() execute
  // immediately in declaration order (matching top-level run order); async
  // tests keep the process alive until they settle. TAP 13 is printed per
  // test plus a plan once the queue drains; any failure sets a non-zero exit
  // code. describe() runs its body synchronously and groups the tests
  // declared inside it. No concurrency, isolation, or watch mode — none of
  // the vendored tests need more.
  "node:test": String.raw`'use strict';

let count = 0;
let failures = 0;
let pending = 0;
let keepAlive = null;
let currentSuite = null;

const suites = [];

const ensureKeepAlive = () => {
  if (!keepAlive) keepAlive = setInterval(() => {}, 2147483647);
};

const releaseKeepAlive = () => {
  if (pending === 0 && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
};

const reportPlan = () => {
  console.log('1..' + count);
};

const reportFailure = (name, err) => {
  failures += 1;
  process.exitCode = 1;
  console.log('not ok ' + count + ' ' + name);
  console.error(err);
};

const runTest = (name, fn) => {
  count += 1;
  const suite = currentSuite;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending += 1;
      ensureKeepAlive();
      return result.then(
        () => {
          pending -= 1;
          console.log('ok ' + count + ' ' + name);
          if (suite) suite.failures = failures - suite.startFailures;
          releaseKeepAlive();
        },
        (err) => {
          pending -= 1;
          reportFailure(name, err);
          if (suite) suite.failures = failures - suite.startFailures;
          releaseKeepAlive();
        },
      );
    }
    console.log('ok ' + count + ' ' + name);
    if (suite) suite.failures = failures - suite.startFailures;
  } catch (err) {
    reportFailure(name, err);
    if (suite) suite.failures = failures - suite.startFailures;
  }
  return undefined;
};

const normalizeTestArgs = (name, options, fn) => {
  if (typeof name === 'function') {
    return [name.name || '<anonymous>', {}, name];
  }
  if (typeof options === 'function') {
    return [String(name), {}, options];
  }
  return [String(name), options || {}, fn];
};

const test = (name, options, fn) => {
  const [testName, , testFn] = normalizeTestArgs(name, options, fn);
  if (typeof testFn !== 'function') {
    const error = new TypeError('The "fn" argument must be of type function');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  return runTest(testName, testFn);
};

const describe = (name, options, fn) => {
  const [suiteName, , suiteFn] = normalizeTestArgs(name, options, fn);
  if (typeof suiteFn !== 'function') {
    const error = new TypeError('The "fn" argument must be of type function');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const suite = { name: suiteName, failures: 0, startFailures: failures };
  suites.push(suite);
  const previous = currentSuite;
  currentSuite = suite;
  try {
    suiteFn();
  } catch (err) {
    reportFailure(suiteName, err);
  } finally {
    currentSuite = previous;
  }
  return suite;
};

process.on('exit', reportPlan);

module.exports = { describe, it: test, test, suites };
`,
};
