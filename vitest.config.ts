import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/dist/**'],
    root: '.',
    projects: [
      'packages/*',
      'tests',
    ],
  },
})
