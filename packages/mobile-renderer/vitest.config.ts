import { taijiTestConfig } from '../../test-guard/factory.ts'
import vue from '@vitejs/plugin-vue'

export default taijiTestConfig({
  test: {
    environment: 'happy-dom',
  },
  plugins: [vue()],
})
