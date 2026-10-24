/**
 * Wool 协议退役守护测试（provider-plugin-access D6/D7：羊毛管理域随插件化迁出宿主）。
 *
 * 退役不变量（负向守护，防回潮）：wool.* WS 帧与 wool-shared 类型已整体退出主仓
 * shared 包——管理动作由 taiji 插件进程承载（providers.* 受控通道归 runtime
 * provider-write-proxy），宿主不再有羊毛域协议面。任何一方重新引入 wool.* 帧类型、
 * ./wool 类型模块或 index 导出，本文件即红（协议退役的机器化 grep 断言）。
 *
 * 测试框架：vitest。运行：cd packages/shared && npx vitest run src/__tests__/wool.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const sharedSrcDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/** wool.* WS 帧名（退役前 ClientMessageMap / ServerMessageMap 的 type 字面量）。 */
const RETIRED_WOOL_FRAME_RE = /'wool\.[a-zA-Z_]+'/g

describe('Wool 协议退役守护（provider-plugin-access D6）', () => {
  it('wool 类型模块已删除（packages/shared/src/wool.ts 不存在）', () => {
    expect(existsSync(join(sharedSrcDir, 'wool.ts'))).toBe(false)
  })

  it('protocol.ts 零 wool.* 帧字面量残留', () => {
    const source = readFileSync(join(sharedSrcDir, 'protocol.ts'), 'utf8')
    const hits = source.match(RETIRED_WOOL_FRAME_RE) ?? []
    expect(hits).toEqual([])
  })

  it('shared 包入口零 wool 导出', () => {
    const source = readFileSync(join(sharedSrcDir, 'index.ts'), 'utf8')
    expect(source).not.toContain("from './wool'")
    expect(source).not.toMatch(/Wool[A-Z]/)
  })
})
