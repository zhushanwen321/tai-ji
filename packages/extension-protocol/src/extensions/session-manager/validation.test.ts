import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../test-guard/integration-gate'

const PKG_DIR = resolve(__dirname, '../../..')
const INDEX_TS = resolve(PKG_DIR, 'src/index.ts')

// 工具入口不经 `pnpm --filter ... exec` 调用：门禁（coverage-gate）从非交互 shell
// 跑 vitest，PATH 常缺 pnpm（版本管理器的 bin 不在非交互 PATH），spawn 会 command
// not found。改用测试进程自带的 node 绝对路径（process.execPath）直驱工具 js 入口，
// 经 execFileSync 免 shell——对 PATH 完全免疫；断言语义（tsc 编译通过）与包根
// `tsc --noEmit` 直跑一致（同以包根为配置解析 cwd）。
const require = createRequire(import.meta.url)
const NODE = process.execPath
const TSC_BIN = require.resolve('typescript/bin/tsc')

/**
 * U1-A1: marker 常量 + 请求/结果 schema 类型 + 审计 entry schema 单一 SSOT
 *
 * 验证：
 * 1. tsc --noEmit 编译通过——挂集成门控（TAIJI_TEST_INTEGRATION）：整包编译属
 *    「测试内跑编译器」（整治判据 e 类，docs/TEST-STRATEGY.md「新写测试判据」节），
 *    且本包无其他机器承载（`extensions:typecheck` 只覆盖 extensions/ 目录、
 *    CI typecheck job 无本包步骤），删除会失去唯一类型门禁，故保留但本地默认跳过
 * 2. index.ts 导出 SESSION_MANAGER_MARKER（纯逻辑，默认组常驻）
 */
describe('U1-A1 marker 常量 + 请求/结果 schema 类型 + 审计 entry schema 单一 SSOT', () => {
  it.skipIf(!INTEGRATION_TESTS_ENABLED)(
    `U1-A1 tsc --noEmit 编译通过${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`,
    () => {
      expect(() => {
        execFileSync(NODE, [TSC_BIN, '--noEmit'], {
          cwd: PKG_DIR,
          stdio: 'pipe',
        })
      }).not.toThrow()
    },
    30_000,
  )

  it('U1-A1 index.ts 导出 SESSION_MANAGER_MARKER', () => {
    const content = readFileSync(INDEX_TS, 'utf-8')
    expect(content).toContain('SESSION_MANAGER_MARKER')
  })
})
