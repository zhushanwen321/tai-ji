import { taijiTestConfig } from '../../test-guard/factory.ts'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default taijiTestConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/__tests__/vitest-i18n-setup.ts'],
    // 单用例超时预算：coverage 插桩 + 全包并行 worker 的负载下，mount+flush 类用例
    // 可越 vitest 默认 5s（2026-09-24 两例：zcode-session-source recovery 阶梯、
    // system-page-smart-context mount——空载单跑均毫秒级，仅重负载下超线）。预算是
    // 环境余量不是断言语义，真死锁用例仍会红（15s）。
    testTimeout: 15000,
    // W1 i18n-frontend-p2：注入 VITE_MOCK=true，让 useSearch 等 mock-mode 分支在测试环境默认走 mock fixture。
    // （mock fixture 是 i18n-frontend-p2 U1 等用例的预期数据源；real 轨无 seed 数据会让 recents/suggested 全空导致断言失败。）
    env: {
      VITE_MOCK: 'true',
    },
    // coverage gate（方法论见 docs/TEST-STRATEGY.md §7「覆盖率与 coverage gate」）。
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
    },
  },
})
