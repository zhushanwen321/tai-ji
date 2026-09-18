import { taijiTestConfig } from '../../test-guard/factory.ts'

export default taijiTestConfig({
  test: {
    include: ['__tests__/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
  },
})
