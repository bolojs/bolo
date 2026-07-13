interface Env {
  SITE: Fetcher;
  COMPAT: Fetcher;
  DEMO: Fetcher;
  DOCS: Fetcher;
}

// COEP per binding: DEMO needs credentialless (SharedArrayBuffer/WASI),
// everything else uses require-corp (safer for cross-origin subresources).
// COOP is same-origin everywhere.
const COEP: Record<keyof Env, string> = {
  SITE: "require-corp",
  COMPAT: "require-corp",
  DEMO: "credentialless",
  DOCS: "require-corp",
};

const MOUNTS: Array<{ prefix: string; binding: keyof Env }> = [
  { prefix: '/compat', binding: 'COMPAT' },
  { prefix: '/demo', binding: 'DEMO' },
  { prefix: '/docs', binding: 'DOCS' },
];

// Clones the upstream response and adds COOP/COEP headers.
// _headers files do NOT propagate through service bindings (Cloudflare Pages
// applies them only to direct static asset responses, not Functions responses).
function withSecurityHeaders(response: Response, coep: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", coep);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
      const upstream = await env[binding].fetch(new Request(rewritten, request));
      return withSecurityHeaders(upstream, COEP[binding]);
    }
  }

  const upstream = await env.SITE.fetch(request);
  return withSecurityHeaders(upstream, COEP.SITE);
};
