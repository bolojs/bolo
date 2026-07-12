import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : 'https://browser-containers.pages.dev',
  base: '/compat',
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
