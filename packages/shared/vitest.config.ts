import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    include: ['__tests__/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
  },
})
