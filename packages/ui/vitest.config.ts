import { taijiTestConfig } from '../../test-guard/factory.ts'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// ui 包测试配置（w6 chat-ui-and-shell）。
// - happy-dom：组件渲染环境（对齐 renderer vitest）
// - self-alias：@taiji/ui → src，支持包内自引用（features/chat import 同包原语）
// - shared alias：@taiji/shared → ../shared/src（vitest 不走 workspace symlink）
// - i18n setup：vitest.setup.ts mock vue-i18n useI18n（ui 组件用 useI18n，测试环境需 t）
export default taijiTestConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
  },
  plugins: [vue()],
  resolve: {
    alias: {
      '@taiji/ui': resolve(__dirname, 'src'),
      '@taiji/shared': resolve(__dirname, '../shared/src'),
      '@taiji/core': resolve(__dirname, '../core/src'),
    },
  },
})
