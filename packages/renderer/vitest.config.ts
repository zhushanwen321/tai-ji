import { taijiTestConfig } from '../../test-guard/factory.ts'
import { loadDomainExclusions } from '../../test-guard/domain-exclusions.ts'
import { configDefaults } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// coverage 运行（--coverage CLI 标记，config 主进程加载时 argv 可见）测量全量档：
// 阈值 68/66/56/60 的校准基线是全量实测（见下方 coverage 块注释），挂载重型文件若被
// 排除，测量域就与阈值基线脱钩（默认档收缩后实测跌破阈值的实例：lines 48.86% < 68%）。
// 因此 coverage 运行不套挂载排除——文件清单仍走 domain-map 单一权威源（同一份排除表
// 整体退出生效，不另抄清单）；日常档（pnpm test）与域触发档（TAIJI_TEST_DOMAIN）不受影响。
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
      : [...configDefaults.exclude, ...loadDomainExclusions(__dirname, 'packages/renderer/')],
    setupFiles: ['./src/__tests__/vitest-i18n-setup.ts', './src/__tests__/vitest-settings-transport-setup.ts'],
    // 单用例超时预算 = vitest 默认 5s。历史上曾放宽到 15s 兜 mount 族重负载（3-14s 实测），
    // 2026-10 单测层整治后全包 junit 最慢单条 <1s（模块图预热共享 / mountSection 直挂），
    // 放宽随根因修复退役——新用例再触 5s 上限时按 docs/TEST-STRATEGY.md「新写测试判据」
    // 处置（确定性化或挂集成门控），不抬预算。
    // W1 i18n-frontend-p2：注入 VITE_MOCK=true，让 useSearch 等 mock-mode 分支在测试环境默认走 mock fixture。
    // （mock fixture 是 i18n-frontend-p2 U1 等用例的预期数据源；真实进程层无 seed 数据会让 recents/suggested 全空导致断言失败。）
    env: {
      VITE_MOCK: 'true',
    },
    // coverage gate（方法论见 docs/TEST-STRATEGY.md §7「覆盖率与 coverage gate」）。
    // 测量域 = 全量档（--coverage 运行不套挂载排除，见 isCoverageRun 注释）。
    // 2026-08-20 重校准：PR #185 大量重构扩大全量分母，旧基线（2026-06 S3-W1：Stmts72.34/Branch61.79/
    // Funcs69.15/Lines74.84 → 阈值 72/70/59/67）失效，实测跌破必红。当前工作区全量实测
    // Lines70.57/Stmts68.38/Branch58.95/Funcs63.37，按基线-2~3% 设阈留 flake 缓冲。
    // 未来收紧需补测试提升覆盖率或记录原因后再调（保持基线-2~3% 原则）。
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 68,
        statements: 66,
        branches: 56,
        functions: 60,
      },
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**'],
      exclude: [
        'src/__tests__/**',
        'src/**/*.d.ts',
        'src/main.ts',
      ],
    },
  },
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@taiji/shared': resolve(__dirname, '../shared/src'),
      '@taiji/core': resolve(__dirname, '../core/src'),
      '@taiji/ui': resolve(__dirname, '../ui/src'),
      // reka-ui 桶装载削减（仅测试侧）：'reka-ui' → 瘦入口 shim（12 个在用组件子树的
      // 逐文件 re-export，见 shim 文件头）。dist/index.js 桶每测试文件装载 ~280ms
      // （265 文件合计 ~75s CPU，装载成本第一热点，数据见 .tmp/round4-a-import-durations.md）；
      // shim 后仅装载在用子树。新增 reka-ui 组件 import 须同步补 shim（缺导出 import 期
      // 即报错，fail-fast）。生产构建（vite.config.ts）与 typecheck 不经此 alias。
      'reka-ui': resolve(__dirname, 'src/__tests__/helpers/reka-ui-slim.ts'),
    },
  },
})
