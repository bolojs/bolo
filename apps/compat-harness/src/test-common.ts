// TypeScript-side helpers (for static type-checking)
export const mustCall = (
  fn: (...args: unknown[]) => void,
  expected = 1,
): ((...args: unknown[]) => void) => {
  let calls = 0;
  const wrapped = (...args: unknown[]) => {
    calls++;
    if (fn) return fn(...args);
  };
  return wrapped;
};

export const mustNotCall =
  (msg?: string): (() => never) =>
  () => {
    throw new Error(msg ?? "should not be called");
  };

export const mustSucceed = (fn: (...args: unknown[]) => void, expected = 1) =>
  mustCall(fn, expected);

export const skip = (_msg?: string): void => {
  // noop
};

export const getOption = (name: string): string | undefined => process.env?.[name];

export const platform = process.platform;

export const fixturesDir = "/test/fixtures";

export const tmpdir = "/tmp";

export const rootDir = "/test";

export const isWindows = process.platform === "win32";

export const isMainThread = true;

export const hasIntl = typeof Intl !== "undefined";

export const hasCrypto = typeof crypto !== "undefined";

export const canCreateWorker = typeof Worker !== "undefined";

export const hasWasm = typeof WebAssembly !== "undefined";

export const noop = (): void => {};

export const platformTimeout = (ms: number): number => ms;

export const skipIfEslintDisabled = noop;

export const skipIfInspectorDisabled = noop;

export const skipIf32Bits = noop;

export const getArrayBufferViews = (buf: Uint8Array): Uint8Array[] => [buf];

// CommonJS source written to VFS at /test/common/index.js.
// Must be vanilla CJS (no TS, no ESM) since Node test files require('common').
export const commonIndexSource = `'use strict';
const noop = () => {};

const mustCall = (fn, expected = 1) => {
  let calls = 0;
  const wrapped = (...args) => {
    calls++;
    if (fn) return fn(...args);
  };
  return wrapped;
};

const mustNotCall = (msg) => () => {
  throw new Error(msg ?? 'should not be called');
};

const mustSucceed = (fn, expected = 1) => mustCall(fn, expected);

const skip = (_msg) => {
  // noop
};

const getOption = (name) => process.env?.[name];

const platform = process.platform;

const fixturesDir = '/test/fixtures';

const tmpdir = '/tmp';

const rootDir = '/test';

const isWindows = process.platform === 'win32';

const isMainThread = true;

const hasIntl = typeof Intl !== 'undefined';

const hasCrypto = typeof crypto !== 'undefined';

const canCreateWorker = typeof Worker !== 'undefined';

const hasWasm = typeof WebAssembly !== 'undefined';

const platformTimeout = (ms) => ms;

const skipIfEslintDisabled = noop;
const skipIfInspectorDisabled = noop;
const skipIf32Bits = noop;

const getArrayBufferViews = (buf) => [buf];

module.exports = {
  mustCall,
  mustNotCall,
  mustSucceed,
  skip,
  noop,
  getOption,
  platform,
  fixturesDir,
  tmpdir,
  rootDir,
  isWindows,
  isMainThread,
  hasIntl,
  hasCrypto,
  canCreateWorker,
  hasWasm,
  platformTimeout,
  skipIfEslintDisabled,
  skipIfInspectorDisabled,
  skipIf32Bits,
  getArrayBufferViews,
};
`;
