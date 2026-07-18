import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, mergeConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { bolojsPreset } from "@bolojs/vite-preset";

/**
 * Dev-only injection of `OPENROUTER_API_KEY` from `examples/app-builder/.env`
 * into `index.html` as a `window.__OPENROUTER_DEV_KEY__` global. This lets
 * agent QA and fresh dev tabs skip the manual config-dialog paste without
 * baking the key into the bundled output (`VITE_*` env vars would do that;
 * we read server-side and inject at request time instead, so the key only
 * exists in dev-server memory).
 *
 * localStorage always takes priority — once a user pastes a key via the
 * dialog, the dev key becomes invisible to that tab. The dev key is purely
 * a default-fill for the empty-tab case. Build output is unaffected: the
 * plugin no-ops in `vite build` (only enabled via `defineConfig` callback,
 * which only runs in serve).
 */
function devOpenRouterKey(): Plugin {
  return {
    name: "bolo:dev-openrouter-key",
    apply: "serve",
    transformIndexHtml() {
      const key = process.env.OPENROUTER_API_KEY?.trim();
      if (!key) return [];
      const safe = JSON.stringify(key).replace(/<\//g, "<\\/");
      return [
        {
          tag: "script",
          injectTo: "head",
          children: `window.__OPENROUTER_DEV_KEY__=${safe};`,
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  // Vite only auto-exposes `VITE_*` env vars to client code. To bridge a
  // unprefixed dev-only var from `.env` to a server-side plugin without
  // baking it into the bundle, load the env file ourselves here (server-side
  // only) and assign to `process.env` so the plugin above can read it.
  if (mode === "development") {
    const env = loadEnv(mode, process.cwd(), "");
    if (env.OPENROUTER_API_KEY) {
      process.env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
    }
  }

  return mergeConfig(bolojsPreset(), {
    plugins: [react(), tailwindcss(), devOpenRouterKey()],
    resolve: {
      alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
    },
  });
});