// 移动壳装配检查（remote-use D9① 双壳测试 + D9② __testing 出口纪律）。
//
// 断言逻辑 = core 共享 helper（checkSessionEntryAssembly / checkInboundEffectsAssembly），
// 与桌面壳 packages/renderer/src/__tests__/assembly-check.test.ts 各调同一 helper——双壳
// 装配缺口（漏注入 → 静默退化 no-op）在测试期机器报红，防下一批缺口照旧累积。
//
// 移动侧断言入口 = __testing 测试后门命名空间（生产代码禁止消费，对齐 companion-bridge
// 先例；导出测试专用符号不扩大 API 面常驻语义）：
// - app-runtime.__testing.sessionEntry —— sessionEntry 端口束原始注入面（切入链订阅/LRU 三步）
// - bootstrap.__testing.shellEffects   —— 壳 effects 回调集（lifecycle factory 三生命周期回调）
//
// __testing 零消费 grep 断言（D9②）：扫描本包 src 生产文件（排除测试与出口定义点），
// 出现 __testing 标识符即违规——出口只对测试开放，生产消费 = API 面常驻语义扩大。
// 与桌面壳测试同构，扫描根/注释提及白名单按包各自声明（两壳名单独立演进）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/assembly-check.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkSessionEntryAssembly,
  checkInboundEffectsAssembly,
} from '@taiji/core'
import { __testing } from '../shell/app-runtime'
import { __testing as bootstrapTesting } from '../bootstrap'

// vitest 运行时 cwd 即包根（ac1-dependency-edge 同款锚定）
const pkgRoot = process.cwd()

/** 注释提及 __testing 但无消费的生产文件（相对 src 路径）——新条目须随改动同 commit 裁决 */
const DOC_MENTION_ALLOWLIST = ['views/SubagentStatusLine.vue'] as const

/** 生产文件 = src 下 .ts/.vue，排除测试目录与测试文件命名 */
function isProductionFile(relPath: string): boolean {
  if (relPath.split('/').includes('__tests__')) return false
  return relPath.endsWith('.ts') || relPath.endsWith('.vue')
}

function listProductionFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) return listProductionFiles(join(dir, entry.name), rel)
    return isProductionFile(rel) ? [rel] : []
  })
}

describe('D9① 移动壳装配检查（core 共享 helper）', () => {
  it('sessionEntry 端口束：切入链订阅/LRU 三成员非 no-op（S1 只看不发/S7 内存无界的装配锚点）', () => {
    const { ok, problems } = checkSessionEntryAssembly(__testing.sessionEntry)
    expect(problems).toEqual([])
    expect(ok).toBe(true)
  })

  it('effects 最小集：exited/restored/restoreFailed 三生命周期回调已接（S6 全弃的装配锚点）', () => {
    const { ok, problems } = checkInboundEffectsAssembly(bootstrapTesting.shellEffects)
    expect(problems).toEqual([])
    expect(ok).toBe(true)
  })
})

describe('D9② __testing 出口生产代码零消费（grep 断言）', () => {
  it('src 生产文件零消费 __testing（出口仅测试 import；定义点自证放行）', () => {
    const srcRoot = join(pkgRoot, 'src')
    const offenders = listProductionFiles(srcRoot).filter((rel) => {
      const content = readFileSync(join(srcRoot, rel), 'utf-8')
      if (!content.includes('__testing')) return false
      // 出口定义文件自证放行（export const __testing 形态统一，五处先例同款）
      if (content.includes('export const __testing')) return false
      return !DOC_MENTION_ALLOWLIST.includes(rel as (typeof DOC_MENTION_ALLOWLIST)[number])
    })
    expect(offenders).toEqual([])
  })
})
