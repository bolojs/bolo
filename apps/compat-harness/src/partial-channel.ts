// The incremental-result channel between the harness page and the CLI.
//
// After every finished package the page calls the global named by
// PARTIAL_CHANNEL. The CLI fills that global with a function that forwards
// to the Playwright binding it exposed, so results reach the CLI as each
// package completes instead of only when the whole matrix is done.
//
// The page also publishes the channel name under PARTIAL_CHANNEL_NAME_GLOBAL
// so the CLI can discover it at runtime: the CLI must not hardcode the name,
// otherwise the two sides can drift apart and the channel silently stops
// delivering results (which is exactly what happened when the CLI installed
// `__boloPartialPush` while the page called `__packagePartial`).
//
// The page side lives in TypeScript and the CLI side in plain JavaScript
// (the CLI runs on Node 20 in CI, which cannot import TypeScript), so the
// two sides cannot share an import. The single shared literal is the name of
// the discovery global, which both sides spell out; the channel name itself
// travels at runtime. Both halves are pinned by
// tests/unit/compat-partial-channel.test.ts.

/** Global the harness page invokes after every finished package. */
export const PARTIAL_CHANNEL = "__packagePartial";

/** Global the page publishes so the CLI can discover the channel name. */
export const PARTIAL_CHANNEL_NAME_GLOBAL = "__partialChannelName";
