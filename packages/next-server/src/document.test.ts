import { describe, it, expect } from "vitest";
import { assembleDocument, serializePageProps } from "./document.js";

describe("assembleDocument", () => {
  it("builds a full html shell with doctype and #__next mount point", () => {
    const html = assembleDocument({
      pathname: "/about",
      pageProps: { title: "About" },
      entryUrl: "/__next/_bolo/entry?page=%2F__next%2F_pages%2Fabout.js",
    });

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<div id="__next"></div>');
    expect(html).toContain('<meta charSet="utf-8">');
    expect(html).toContain('content="width=device-width, initial-scale=1"');
  });

  it("injects the importmap when provided", () => {
    const html = assembleDocument({
      pathname: "/",
      pageProps: {},
      entryUrl: "/__next/_bolo/entry?page=/x",
      importMapJson: '{"imports":{"react":"https://esm.sh/react"}}',
    });
    expect(html).toContain('<script type="importmap">');
    expect(html).toContain('"react":"https://esm.sh/react"');
  });

  it("inlines the bootstrap import with pathname and pageProps", () => {
    const html = assembleDocument({
      pathname: "/blog/1",
      pageProps: { post: "hello" },
      entryUrl: "/__next/_bolo/entry?page=/p",
    });
    expect(html).toContain('import { boot } from "/__next/_bolo/entry?page=/p"');
    expect(html).toContain('boot("/blog/1"');
    expect(html).toContain('"post":"hello"');
  });

  it("escapes </script> inside pageProps", () => {
    const html = assembleDocument({
      pathname: "/",
      pageProps: { evil: "</script><script>alert(1)</script>" },
      entryUrl: "/e",
    });
    expect(html).not.toContain('{"evil":"</script>');
    expect(html).toContain("\\u003c/script>");
  });

  it("renders head tags", () => {
    const html = assembleDocument({
      pathname: "/",
      pageProps: {},
      entryUrl: "/e",
      headTags: [
        { type: "title", content: "My page" },
        { type: "meta", props: { name: "description", content: "d" } },
        { type: "link", props: { rel: "stylesheet", href: "/styles/globals.css" } },
      ],
    });
    expect(html).toContain("<title>My page</title>");
    expect(html).toContain('<meta name="description" content="d">');
    expect(html).toContain('<link rel="stylesheet" href="/styles/globals.css">');
  });

  it("applies html and body attributes", () => {
    const html = assembleDocument({
      pathname: "/",
      pageProps: {},
      entryUrl: "/e",
      htmlAttrs: { lang: "en" },
      bodyAttrs: { class: "dark" },
    });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<body class="dark">');
  });

  it("escapes attribute values", () => {
    const html = assembleDocument({
      pathname: "/",
      pageProps: {},
      entryUrl: "/e",
      htmlAttrs: { lang: 'en" onload="x' },
    });
    expect(html).not.toContain('onload="x"');
    expect(html).toContain("&quot;");
  });
});

describe("serializePageProps", () => {
  it("serializes plain data", () => {
    expect(serializePageProps({ a: 1 })).toBe('{"a":1}');
    expect(serializePageProps(undefined)).toBe("{}");
    expect(serializePageProps(null)).toBe("{}");
  });

  it("rejects non-serializable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializePageProps(circular)).toThrow(/serializable/);
  });
});
