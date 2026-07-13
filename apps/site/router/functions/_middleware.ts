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
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
      const rewritten = new URL(url);
      rewritten.pathname = url.pathname.slice(prefix.length) || '/';
      return env[binding].fetch(new Request(rewritten, request));
    }
  }

  return env.SITE.fetch(request);
};
