import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : 'https://bolojs.dev',
  base: '/docs',
  vite: {
    server: { fs: { allow: ['../../../docs'] } },
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
        { label: 'API Reference', link: '/api/' },
        { label: 'Migration Guide', link: '/migration/' },
        { label: 'Node.js Compatibility', link: '/compat/' },
        { label: 'Shim Coverage', link: '/shim-coverage/' },
        { label: 'Package Manager Support', link: '/package-managers/' },
        { label: 'WASM Registry', link: '/wasm-registry/' },
        { label: 'Alternatives Comparison', link: '/alternatives/' },
      ],
    }),
  ],
});
