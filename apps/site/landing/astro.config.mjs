import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";
import solid from "@astrojs/solid-js";
import {
  bolojsShimPlugins,
  bolojsAlias,
  bolojsOptimizeDeps,
  coopCoepHeaders,
} from "@bolojs/vite-preset";

export default defineConfig({
  site: process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : "https://bolojs.dev",
  integrations: [
    react({ include: ["**/shared/components/**/*"], exclude: ["**/demo/**/*"] }),
    solid({ include: ["**/demo/**/*"] }),
  ],
  server: {
    headers: coopCoepHeaders,
  },
  vite: {
    // Buffer/global injected per-module by the shim plugins collide across the Demo
    // island's hydration graph ("Identifier '__buffer_polyfill' has already been
    // declared"); Buffer is provided once instead via src/demo/client-globals.ts.
    plugins: [tailwindcss(), ...bolojsShimPlugins()],
    server: {
      headers: coopCoepHeaders,
    },
    environments: {
      client: {
        build: {
          target: "esnext",
          rollupOptions: {
            external: [
              "typescript",
              "oxc-transform",
              "@oxc-transform/binding-wasm32-wasi",
              "@oxc-transform/binding",
              "sass",
              "@swc/wasm-web",
            ],
            output: {
              manualChunks(id) {
                if (id.includes("quickjs-emscripten") || id.includes("@jitl/")) return "quickjs";
                if (id.includes("memfs")) return "memfs";
                if (id.includes("@bolojs/npm") || id.includes("@unjs/lockfile")) return "npm";
              },
            },
          },
        },
      },
      ssr: {
        build: {
          target: "esnext",
        },
      },
    },
    resolve: {
      alias: bolojsAlias(),
    },
    optimizeDeps: bolojsOptimizeDeps(),
  },
});
