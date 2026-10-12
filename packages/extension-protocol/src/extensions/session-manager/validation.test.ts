import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const PKG_DIR = resolve(__dirname, '../../..')
const INDEX_TS = resolve(PKG_DIR, 'src/index.ts')
const ROOT_DIR = resolve(PKG_DIR, '../..')

// 工具入口不经 `pnpm --filter ... exec` 调用：门禁（coverage-gate）从非交互 shell
// 跑 vitest，PATH 常缺 pnpm（版本管理器的 bin 不在非交互 PATH），spawn 会 command
// not found。改用测试进程自带的 node 绝对路径（process.execPath）直驱工具 js 入口，
// 经 execFileSync 免 shell——对 PATH 完全免疫；断言语义（tsc 编译通过 / eslint 全绿）
// 与原 pnpm --filter exec 形态一致（同以包根为配置解析 cwd）。
const require = createRequire(import.meta.url)
const NODE = process.execPath
const TSC_BIN = require.resolve('typescript/bin/tsc')
// eslint 的 bin 子路径被其 package.json exports 屏蔽（ERR_PACKAGE_PATH_NOT_EXPORTED），
// require.resolve 解析不到，走 workspace 根 hoisted 物理路径
const ESLINT_BIN = resolve(ROOT_DIR, 'node_modules/eslint/bin/eslint.js')

/**
 * U1-A1: marker 常量 + 请求/结果 schema 类型 + 审计 entry schema 单一 SSOT
 *
 * 验证：
 * 1. tsc --noEmit 编译通过
 * 2. index.ts 导出 SESSION_MANAGER_MARKER
 */
describe('U1-A1 marker 常量 + 请求/结果 schema 类型 + 审计 entry schema 单一 SSOT', () => {
  it(
    'U1-A1 tsc --noEmit 编译通过',
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

/**
 * U1-A3: extension-protocol lint 全绿
 */
describe('U1-A3 extension-protocol lint 全绿', () => {
  it(
    'U1-A3 eslint src/ 无错误',
    () => {
      expect(() => {
        execFileSync(NODE, [ESLINT_BIN, 'src/'], {
          cwd: PKG_DIR,
          stdio: 'pipe',
        })
      }).not.toThrow()
    },
    30_000,
  )
})
