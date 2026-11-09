import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import { searchForWorkspaceRoot } from 'vite';

export default defineConfig({
  site: process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : 'https://bolojs.dev',
  base: '/docs',
  vite: {
    server: { fs: { allow: [searchForWorkspaceRoot(process.cwd())] } },
  },
  integrations: [
    starlight({
      title: 'bolo',
      description: 'Everything you need to run Node.js in the browser.',
      favicon: '/favicon.ico',
      head: [
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
      ],
      customCss: ['./src/styles/custom.css'],
      plugins: [starlightLlmsTxt()],
      sidebar: [
        { label: 'Getting Started', link: '/getting-started/' },
        { label: 'Compatibility', link: '/compat/' },
        { label: 'API Reference', link: '/api/' },
        { label: 'Migration Guide', link: '/migration/' },
        { label: 'Alternatives Comparison', link: '/alternatives/' },
      ],
    }),
  ],
});
