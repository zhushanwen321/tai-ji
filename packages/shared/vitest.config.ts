import { taijiTestConfig } from '../../test-guard/factory.ts'

export default taijiTestConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    include: ['__tests__/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
  },
})
