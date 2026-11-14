import { enrichMessage } from "@bolojs/log/error-hints";

export interface DocumentHeadTag {
  readonly type: "meta" | "link" | "title" | "script" | "base" | "style" | "raw";
  readonly props?: Record<string, string>;
  readonly content?: string;
}

export interface AssembleDocumentOptions {
  /** Route pathname being rendered, used for the canonical-ish bootstrap. */
  readonly pathname: string;
  /** JSON-serializable props from getStaticProps (may be undefined). */
  readonly pageProps: unknown;
  /** Module URL the browser entry is served at. */
  readonly entryUrl: string;
  /** Importmap JSON to inject into <head>, if present. */
  readonly importMapJson?: string | null;
  /** Extra head tags (from _document static head, next/head SSR, etc.). */
  readonly headTags?: readonly DocumentHeadTag[];
  /** Attributes for <html>, e.g. `{ lang: "en" }`. */
  readonly htmlAttrs?: Record<string, string>;
  /** Attributes for <body>. */
  readonly bodyAttrs?: Record<string, string>;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const renderAttrs = (props: Record<string, string> | undefined): string => {
  if (!props) return "";
  return Object.entries(props)
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join("");
};

const renderHeadTag = (tag: DocumentHeadTag): string => {
  switch (tag.type) {
    case "title":
      return `<title>${escapeHtml(tag.content ?? "")}</title>`;
    case "style":
      return `<style>${tag.content ?? ""}</style>`;
    case "raw":
      return tag.content ?? "";
    default:
      return `<${tag.type}${renderAttrs(tag.props)}>`;
  }
};

/** Serialize page props for inline bootstrap. JSON with a safeguard against
 * `</script>` breaking out of the inline script element. */
export const serializePageProps = (props: unknown): string => {
  let json: string;
  try {
    json = JSON.stringify(props ?? {}) ?? "{}";
  } catch (err) {
    throw new Error(
      enrichMessage(
        `pageProps are not JSON-serializable (getStaticProps must return plain data): ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
  }
  return json.replace(/</g, "\\u003c");
};

/** Assemble the full HTML document shell for a Pages Router request.
 * Pages are client-rendered into `<div id="__next">` by the entry module;
 * this function builds everything around it (doctype, html/head/body,
 * importmap, bootstrap script). */
export const assembleDocument = (options: AssembleDocumentOptions): string => {
  const headTags = (options.headTags ?? []).map(renderHeadTag).join("\n    ");
  const importMapTag = options.importMapJson
    ? `<script type="importmap">${options.importMapJson}</script>`
    : "";
  const pagePropsJson = serializePageProps(options.pageProps);

  return `<!DOCTYPE html>
<html${renderAttrs(options.htmlAttrs)}>
  <head>
    <meta charSet="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${importMapTag}
    ${headTags}
  </head>
  <body${renderAttrs(options.bodyAttrs)}>
    <div id="__next"></div>
    <script type="module">
      import { boot } from ${JSON.stringify(options.entryUrl)};
      boot(${JSON.stringify(options.pathname)}, ${pagePropsJson});
    </script>
  </body>
</html>`;
};
