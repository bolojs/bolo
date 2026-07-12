import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://browser-containers.dev',
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
      proxy: {
        // In dev, /compat is served by the standalone compat app's own dev
        // server (run separately via `pnpm --filter @browser-containers/compat dev`).
        // Route through its stable portless hostname rather than a raw port,
        // since portless assigns that port dynamically per run.
        '/compat': {
          target: 'https://compat.localhost:1355',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  },
});
