// CommonJS source written to the container VFS at /test/common/index.js.
// Node's own test files `require('../common')`, so this must be vanilla CJS
// (no TS, no ESM). It mirrors the semantics of Node's test/common that decide
// pass/fail: call-count checks at exit, `skip` bailing out, platform timeouts.
// Faithfulness matters more than coverage: a stub that never fails scores
// false passes (see .agents/plans/2026-11-07-release-mechanics-and-verification.md).
export const commonIndexSource = String.raw`'use strict';
const assert = require('assert');

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

// Mirrors Node's test/common platformTimeout for the platforms we can detect.
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
  isMainThread: true,
  hasIntl: typeof Intl !== 'undefined',
  hasCrypto: typeof crypto !== 'undefined',
  canCreateWorker: typeof Worker !== 'undefined',
  hasWasm: typeof WebAssembly !== 'undefined',
  platformTimeout,
  skipIfWorker: noop,
  skipIfEslintDisabled: noop,
  skipIfInspectorDisabled: noop,
  skipIf32Bits: noop,
  getArrayBufferViews: (buf) => [buf],
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
