import { transformScript } from "@bolojs/registry";
import { enrichMessage } from "@bolojs/log/error-hints";

export interface PageTransformResult {
  readonly code: string;
  readonly engine: "oxc";
}

// NOTE: `@next/swc-wasm-web` (pinned to the Next 16 line) was evaluated and
// rejected for page transforms. That wasm build hardwires Next's
// client-bundle page transform: it strips `getStaticProps` exports and emits
// `__N_SSG` markers, and no option disables the behavior (probed against
// 16.4.6). Our compiled modules are served to the browser AND executed
// server-side for data fetching, so the stripping is disqualifying.
// oxc-transform is the N1 transform engine; revisit when the wasm surface
// exposes a plain (non-page) transform mode.

/** Map bare `next/*` imports to the built-in shim modules served under the
 * server's `/_bolo/shims/` endpoint so compiled pages load without the real
 * `next` package (which cannot run in the browser). */
export const rewriteNextImports = (code: string, shimBase: string): string => {
  return code.replace(
    /(from\s*|import\s*\(\s*|import\s*)(["'])next\/([a-z-]+)(\/[^"']*)?\2/g,
    (_m, prefix: string, quote: string, pkg: string, sub: string | undefined) => {
      const specifier = sub ? `${pkg}${sub}` : pkg;
      return `${prefix}${quote}${shimBase}/${specifier}.js${quote}`;
    },
  );
};

export interface ImportMap {
  readonly imports?: Record<string, string>;
}

/** Rewrite bare specifiers (e.g. `react/jsx-runtime`) through an importmap
 * for server-side module execution in the host page, which has no importmap
 * of its own. Relative, absolute, URL, and data: specifiers pass through.
 * Only the copy executed for getStaticProps/API routes is rewritten; the
 * served browser modules keep bare imports resolved by the document importmap. */
export const rewriteBareImports = (code: string, importMap: ImportMap): string => {
  const imports = importMap.imports ?? {};
  const resolve = (specifier: string): string => {
    if (specifier in imports) return imports[specifier];
    for (const [key, target] of Object.entries(imports)) {
      if (key.endsWith("/") && specifier.startsWith(key)) {
        return target + specifier.slice(key.length);
      }
    }
    return specifier;
  };
  return code.replace(
    /(from\s*|import\s*\(\s*|import\s*)(["'])([^"']+)\2/g,
    (match, prefix: string, quote: string, specifier: string) => {
      if (/^(\.|\/|https?:|data:|node:)/.test(specifier)) return match;
      const resolved = resolve(specifier);
      return resolved === specifier ? match : `${prefix}${quote}${resolved}${quote}`;
    },
  );
};

/** Transform a page/module source file to browser-ready ESM via
 * oxc-transform (TS + automatic-runtime JSX). */
export const compileModule = async (
  code: string,
  filename: string,
  shimBase: string,
): Promise<PageTransformResult> => {
  try {
    const ext = filename.endsWith(".tsx")
      ? ("tsx" as const)
      : filename.endsWith(".jsx")
        ? ("jsx" as const)
        : ("ts" as const);
    const { code: transformed } = await transformScript(code, { loader: ext });
    return { code: rewriteNextImports(transformed, shimBase), engine: "oxc" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(enrichMessage(`Transform error: ${message}`));
  }
};
