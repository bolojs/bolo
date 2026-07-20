import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, mergeConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { bolojsPreset } from "@bolojs/vite-preset";

/**
 * Dev-only injection of `OPENROUTER_API_KEY` from
 * `examples/app-builder-solid/.env` into `index.html` as a
 * `window.__OPENROUTER_DEV_KEY__` global. Ported verbatim from the React
 * app-builder — the plugin is framework-free. Used from Slice 2 onward
 * (chat); harmless for Slice 1.
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
  if (mode === "development") {
    const env = loadEnv(mode, process.cwd(), "");
    if (env.OPENROUTER_API_KEY) {
      process.env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
    }
  }

  // Slice 1: no oxc-transform inlining needed (no editor yet). The React
  // app-builder's preset mutation (drop oxc-transform from rollup external)
  // is added back in Slice 3 when the CodeMirror-based editor lands.
  return mergeConfig(bolojsPreset(), {
    plugins: [solid(), tailwindcss(), devOpenRouterKey()],
    resolve: {
      alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
    },
  });
});
