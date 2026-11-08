import * as fc from "fast-check";
import { expect } from "vitest";

/**
 * Shared fast-check run parameters for every property test in the repo
 * (see tests/unit/regressions/README.md for the failure-replay convention).
 *
 * Resolution order:
 *   1. FC_SEED / FC_NUM_RUNS env vars — replay a reported seed anywhere.
 *   2. CI (CI env set): fixed seed + modest run count so PR runs are
 *      deterministic and fast.
 *   3. Local / nightly: random seed + larger run count so exploration
 *      widens over time.
 */
const CI_SEED = 20261108;
const CI_NUM_RUNS = 50;
const LOCAL_NUM_RUNS = 250;

const envInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`expected ${name} to be an integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

export const fcParams = (): fc.Parameters<unknown> => {
  const ci = process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "false";
  return {
    seed: envInt("FC_SEED") ?? (ci ? CI_SEED : undefined),
    numRuns: envInt("FC_NUM_RUNS") ?? (ci ? CI_NUM_RUNS : LOCAL_NUM_RUNS),
  };
};

/** Outcome wrapper for comparing "throws vs returns" between shim and node. */
export type Outcome<T> = { threw: true; error: unknown } | { threw: false; value: T };

export const outcome = <T>(fn: () => T): Outcome<T> => {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    return { threw: true, error };
  }
};

/** Compare an Outcome pair: same threw-ness, same value when both returned. */
export const expectSameOutcome = <T>(shimResult: Outcome<T>, nodeResult: Outcome<T>): void => {
  expect(shimResult.threw).toBe(nodeResult.threw);
  if (!shimResult.threw && !nodeResult.threw) {
    expect(shimResult.value).toEqual(nodeResult.value);
  }
};
