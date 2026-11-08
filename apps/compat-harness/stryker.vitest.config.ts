import { defineConfig } from "vitest/config";

// Stryker runs the harness-local classifier suite; the root unit suite imports
// the same file so both commands exercise identical assertions.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/classify.test.ts"],
  },
});
