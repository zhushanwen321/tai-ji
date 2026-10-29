import { taijiTestConfig } from '../../test-guard/factory.ts'
import { loadDomainExclusions } from '../../test-guard/domain-exclusions.ts'
import { configDefaults } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// coverage 运行（--coverage CLI 标记，config 主进程加载时 argv 可见）测量全量档：
// 增量覆盖率门禁（pr-review coverage-gate，80% 阈值）按 lcov 实测计——挂载测试若被
// 排除，其组件（rendering-protocol 原语 / DrawerPanel 等）在测量域内永远零覆盖，
// 测量域就与门禁阈值脱钩（renderer 同款修正先例：packages/renderer/vitest.config.ts
// isCoverageRun 注释）。因此 coverage 运行不套挂载排除——文件清单仍走 domain-map
// 单一权威源（同一份排除表整体退出生效，不另抄清单）；日常档（pnpm test）与域触发档
// （TAIJI_TEST_DOMAIN）不受影响。
const isCoverageRun = process.argv.includes('--coverage')

export default taijiTestConfig({
  test: {
    environment: 'happy-dom',
    // 默认档排除挂载渲染重型测试（round6 Wave2 范围收缩）：清单来自
    // docs/testing/domain-map.json 单一权威源（本模块只派生，不持清单），
    // 域触发档（TAIJI_TEST_DOMAIN 由 scripts/run-domain-tests.mjs 设置）不排除，
    // 由 run 脚本按域传显式文件清单；coverage 运行同样不排除（测全量档，见
    // isCoverageRun 注释）。必须与 configDefaults.exclude 合并，
    // 禁止整体替换（否则放开 node_modules/dist 默认排除）。
    exclude: isCoverageRun
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, ...loadDomainExclusions(__dirname, 'packages/ui/')],
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
