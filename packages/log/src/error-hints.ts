/**
 * Error normalization + hint registry — shared across packages.
 *
 * Lives in @bolojs/log because it's a leaf dep that both @bolojs/runtime
 * and @bolojs/vite-server can consume without creating a circular dep
 * (runtime → vite-server → runtime).
 *
 * `BoloError` is the one record shape every context (main thread, Web
 * Workers, Service Workers, WASM tools, preview iframes) funnels errors
 * into. Plain interface — not an Error subclass — because these records
 * cross `postMessage` boundaries and `structuredClone` strips prototypes.
 *
 * `attachHint` / `hintFor` enrich an error message with an actionable
 * fix instruction when the message matches a known failure pattern. The
 * hint registry is sink-side: regex over `message` is fine for advisory
 * text; classification (`kind`) is set at the throw site where the
 * domain is known.
 */

export type BoloErrorKind =
  | "capability"
  | "transform"
  | "bundler"
  | "network"
  | "sandbox"
  | "wasm-trap"
  | "user-code"
  | "sw"
  | "unknown";

export type BoloErrorSource = "main" | "worker" | "sw" | "iframe" | "wasm";

export interface BoloError {
  readonly kind: BoloErrorKind;
  readonly source: BoloErrorSource;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly hint?: string;
  readonly ts: number;
}

interface HintRule {
  readonly match: RegExp;
  readonly hint: string;
}

// ponytail: hint text is advisory — if you find yourself elaborating here,
// prefer routing the throw site to set `kind` explicitly and have the UI
// render a curated message keyed by kind.
const HINTS: readonly HintRule[] = [
  {
    match: /Failed to construct 'Worker'|SecurityError.*[Ww]orker|cross-origin.*[Ww]orker/i,
    hint:
      "A WASM tool (oxc-transform / @rolldown/browser) tried to construct a cross-origin " +
      "classic Worker, which browsers forbid. Set __preferLocalBundler = true (or " +
      "__preferLocalOxc / __preferLocalRolldown) before boot, and add " +
      "noExternal: ['oxc-transform', '@oxc-transform/binding-wasm32-wasi'] in the consumer's " +
      "vite.config — see examples/app-builder/vite.config.ts and " +
      "packages/wasm-registry/src/bundle.ts.",
  },
  {
    match: /CompileError|Wasm.*unreachable|RuntimeError.*unreachable/i,
    hint:
      "WASM trap inside a bundler tool. Retry with __preferLocalBundler; if persistent, " +
      "the tool version may be mismatched. Read .logs/latest.jsonl or call " +
      "window.__boloObsDrain().",
  },
  {
    match: /ServiceWorker timeout|SW not ready|ServiceWorker not ready/i,
    hint:
      "Preview request reached the SW before its MessageChannel was live. Reload after " +
      "boot completes; window.__boloObsDrain() will show sw-state (controller: false = " +
      "SW not yet controlling the page).",
  },
  {
    match: /Transform error:/i,
    hint:
      "Module transform failed in @bolojs/wasm-registry. The underlying message is in " +
      "the 500 body itself; window.__boloObsDrain() usually has the originating record.",
  },
  {
    match: /404.*oxc|404.*rolldown|cannot resolve.*oxc|cannot resolve.*rolldown/i,
    hint:
      "Bundler module not bundled into the static build. Add " +
      "noExternal: ['oxc-transform', '@oxc-transform/binding-wasm32-wasi'] in the " +
      "consumer's vite.config — see examples/app-builder/vite.config.ts.",
  },
];

export const hintFor = (message: string): string | undefined =>
  HINTS.find((h) => h.match.test(message))?.hint;

export const attachHint = (e: BoloError): BoloError => {
  const hint = hintFor(e.message);
  return hint ? { ...e, hint } : e;
};

export const enrichMessage = (message: string): string => {
  const hint = hintFor(message);
  return hint ? `${message}\n\nHint: ${hint}` : message;
};