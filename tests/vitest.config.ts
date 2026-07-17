import { defineConfig } from "vitest/config";

// unenv v2 ships each runtime module as a flat `.mjs` file resolved via its
// package.json `exports` map (e.g. `unenv/node/util`), so the v1-era
// directory-index aliases are no longer needed here.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./setup.ts"],
  },
});
