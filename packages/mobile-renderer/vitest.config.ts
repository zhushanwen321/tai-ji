import { taijiTestConfig } from '../../test-guard/factory.ts'
import vue from '@vitejs/plugin-vue'

export default taijiTestConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    environment: 'happy-dom',
  },
  plugins: [vue()],
})
