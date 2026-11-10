import assert, {
  strict,
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
  notStrictEqual,
} from "../assert.js";

// `node:assert/strict` — the strict-mode facade; identical to `assert.strict`.
export {
  strict,
  strict as default,
  deepStrictEqual,
  deepStrictEqual as deepEqual,
  notDeepStrictEqual,
  notDeepStrictEqual as notDeepEqual,
  strictEqual,
  strictEqual as equal,
  notStrictEqual,
  notStrictEqual as notEqual,
};

export const ok = assert.ok;
export const fail = assert.fail;
export const throws = assert.throws;
export const doesNotThrow = assert.doesNotThrow;
export const rejects = assert.rejects;
export const doesNotReject = assert.doesNotReject;
export const ifError = assert.ifError;
export const match = assert.match;
export const doesNotMatch = assert.doesNotMatch;
export const AssertionError = assert.AssertionError;
export const CallTracker = assert.CallTracker;
