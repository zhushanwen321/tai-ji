import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PKG_DIR = resolve(__dirname, '../../..')
const INDEX_TS = resolve(PKG_DIR, 'src/index.ts')
const ROOT_DIR = resolve(PKG_DIR, '../..')

/**
 * U1-A1: marker 常量 + 请求/结果 schema 类型 + 审计 entry schema 单一 SSOT
 *
 * 验证：
 * 1. tsc --noEmit 编译通过
 * 2. index.ts 导出 SESSION_MANAGER_MARKER
 */
describe('U1-A1 marker 常量 + 请求/结果 schema 类型 + 审计 entry schema 单一 SSOT', () => {
  it('U1-A1 tsc --noEmit 编译通过', () => {
    expect(() => {
      execSync('pnpm --filter @xyz-agent/extension-protocol exec tsc --noEmit', {
        cwd: ROOT_DIR,
        stdio: 'pipe',
      })
    }).not.toThrow()
  })

  it('U1-A1 index.ts 导出 SESSION_MANAGER_MARKER', () => {
    const content = readFileSync(INDEX_TS, 'utf-8')
    expect(content).toContain('SESSION_MANAGER_MARKER')
  })
})

/**
 * U1-A3: extension-protocol lint 全绿
 */
describe('U1-A3 extension-protocol lint 全绿', () => {
  it('U1-A3 eslint src/ 无错误', () => {
    expect(() => {
      execSync('pnpm --filter @xyz-agent/extension-protocol exec eslint src/', {
        cwd: ROOT_DIR,
        stdio: 'pipe',
      })
    }).not.toThrow()
  })
})
