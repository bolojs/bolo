import { defineConfig } from "vite";

// COI=1 serves the page cross-origin isolated (COOP/COEP) so SharedArrayBuffer
// exists; COI=0 serves it plain, matching a non-isolated tier-B host.
const coi = process.env.COI === "1";

export default defineConfig({
  worker: { format: "es" },
  server: coi
    ? {
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          // WebKit applies COEP to same-origin worker subresources too —
          // every response must carry an explicit CORP opt-in.
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      }
    : {},
  // Keep both napi wasm packages out of the dep optimizer so their
  // `new URL('./x.wasm' | './wasi-worker.mjs', import.meta.url)` patterns
  // resolve against the real served file URLs.
  optimizeDeps: {
    exclude: ["@rolldown/browser", "@oxc-parser/binding-wasm32-wasip1"],
  },
});
