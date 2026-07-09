export const mustCall = (fn: () => void): (() => void) => {
  fn();
  return fn;
};

export const mustNotCall =
  (msg?: string): (() => never) =>
  () => {
    throw new Error(msg ?? "should not be called");
  };

export const skip = (_msg?: string): void => {
  // noop
};

export const getOption = (name: string): string | undefined => process.env?.[name];

export const platform = process.platform;

export const fixturesDir = "/test/fixtures";

export const tmpdir = "/tmp";

export const rootDir = "/test";

export const isWindows = process.platform === "win32";

export const commonIndexSource = `'use strict';
const mustCall = (fn) => {
  fn();
  return fn;
};

const mustNotCall = (msg) => () => {
  throw new Error(msg ?? "should not be called");
};

const skip = (_msg) => {
  // noop
};

const getOption = (name) => process.env?.[name];

const platform = process.platform;

const fixturesDir = "/test/fixtures";

const tmpdir = "/tmp";

const rootDir = "/test";

const isWindows = process.platform === "win32";

module.exports = {
  mustCall,
  mustNotCall,
  skip,
  getOption,
  platform,
  fixturesDir,
  tmpdir,
  rootDir,
  isWindows,
};
`;
