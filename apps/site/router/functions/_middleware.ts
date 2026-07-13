interface Env {
  SITE: Fetcher;
  COMPAT: Fetcher;
  DEMO: Fetcher;
  DOCS: Fetcher;
}

const MOUNTS: Array<{ prefix: string; binding: keyof Env }> = [
  { prefix: '/compat', binding: 'COMPAT' },
  { prefix: '/demo', binding: 'DEMO' },
  { prefix: '/docs', binding: 'DOCS' },
];

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);

  for (const { prefix, binding } of MOUNTS) {
    // Canonicalize the bare mount path (no trailing slash) to its trailing-slash
    // form first: relative asset URLs in the mounted app's HTML (e.g. docmd's
    // `<base href="/docs/">` + `./assets/...` links) resolve against the
    // *document* URL, and Chrome's preload scanner ignores `<base>` entirely —
    // so `/docs` (no slash) fetches assets from site root instead of `/docs/`.
    if (url.pathname === prefix) {
      const redirected = new URL(url);
      redirected.pathname = `${prefix}/`;
      return Response.redirect(redirected.href, 308);
    }
    if (url.pathname.startsWith(`${prefix}/`)) {
      const rewritten = new URL(url);
      rewritten.pathname = url.pathname.slice(prefix.length) || '/';
      return env[binding].fetch(new Request(rewritten, request));
    }
  }

  return env.SITE.fetch(request);
};
