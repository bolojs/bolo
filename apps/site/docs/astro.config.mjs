import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : 'https://browser-containers.pages.dev',
  base: '/docs',
  integrations: [
    starlight({
      title: 'browser-containers',
      description: 'Everything you need to run Node.js in the browser.',
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
