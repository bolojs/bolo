import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // ponytail: tests mutate globalThis.fetch and process.env; run files sequentially
    fileParallelism: false,
  },
});
