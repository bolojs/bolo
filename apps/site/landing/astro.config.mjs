import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : 'https://browser-containers.pages.dev',
  integrations: [
    starlight({
      title: 'browser-containers',
      description: 'A fully client-side Node.js runtime for the browser.',
      customCss: ['./src/styles/global.css'],
      plugins: [starlightLlmsTxt()],
      components: {
        ThemeProvider: './src/components/ThemeInit.astro',
        ThemeSelect: './src/components/StarlightThemeSelect.astro',
      },
    }),
  ],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  vite: {
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
  },
});
