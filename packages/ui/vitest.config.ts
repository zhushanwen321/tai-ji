import { taijiTestConfig } from '../../test-guard/factory.ts'
import { loadDomainExclusions } from '../../test-guard/domain-exclusions.ts'
import { configDefaults } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// ui 包测试配置（w6 chat-ui-and-shell）。
// - happy-dom：组件渲染环境（对齐 renderer vitest）
// - self-alias：@taiji/ui → src，支持包内自引用（features/chat import 同包原语）
// - shared alias：@taiji/shared → ../shared/src（vitest 不走 workspace symlink）
// - i18n setup：vitest.setup.ts mock vue-i18n useI18n（ui 组件用 useI18n，测试环境需 t）
export default taijiTestConfig({
  test: {
    environment: 'happy-dom',
    // 默认档排除挂载渲染重型测试（round6 Wave2 范围收缩）：清单来自
    // docs/testing/domain-map.json 单一权威源（本模块只派生，不持清单），
    // 域触发档（TAIJI_TEST_DOMAIN 由 scripts/run-domain-tests.mjs 设置）不排除，
    // 由 run 脚本按域传显式文件清单。必须与 configDefaults.exclude 合并，
    // 禁止整体替换（否则放开 node_modules/dist 默认排除）。
    exclude: [...configDefaults.exclude, ...loadDomainExclusions(__dirname, 'packages/ui/')],
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
