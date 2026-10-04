// 桌面壳装配检查（remote-use D9① 双壳测试 + D9② __testing 出口纪律）。
//
// 断言逻辑 = core 共享 helper（checkSessionEntryAssembly / checkInboundEffectsAssembly），
// 与移动壳 packages/mobile-renderer/src/__tests__/assembly-check.test.ts 各调同一 helper——
// 桌面侧防未来重构 useSidebar 时静默删 sessionEntry 注入（ac1-dependency-edge 同款护栏立场：
// 装配缺口是静默的，重构删注入无报错，测试期机器报红是唯一防线）。
//
// 断言入口：
// - useSidebar.__testing.sessionEntry —— sessionEntry 端口束原始注入面（composable 内构造，
//   useSidebar() 调用时填充；测试后门命名空间生产代码禁止消费，对齐 useExtensionHostBridge
//   __testing 先例——导出测试专用符号不扩大 API 面常驻语义）
// - createInboundEffects() —— effects 回调集工厂（useMessageEffects 公开导出，useConnection
//   装配点同源）
//
// __testing 零消费 grep 断言（D9②）：扫描本包 src 生产文件（排除测试与出口定义点），
// 出现 __testing 标识符即违规。与移动壳测试同构，扫描根/注释提及白名单按包各自声明。
//
// 运行：cd packages/renderer && npx vitest run src/__tests__/assembly-check.test.ts
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import {
  checkSessionEntryAssembly,
  checkInboundEffectsAssembly,
} from '@taiji/core'

// ── mock @/api：useSidebar 构造期 buildSessionApiPort 依赖（对齐 sidebar-assign-project
// 同款 mock 面；extension 域构造期不解引用，无需 mock）──
vi.mock('@/api', () => ({
  project: {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    save: vi.fn().mockResolvedValue(undefined),
  },
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve({ id: 'mock' })),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
  },
}))

import { useSidebar, __testing } from '@/composables/features/sidebar/useSidebar'
import { createInboundEffects } from '@/composables/effects/useMessageEffects'

// vitest 运行时 cwd 即包根（ac1 同款锚定）
const pkgRoot = process.cwd()

/** 注释提及 __testing 但无消费的生产文件（相对 src 路径）——新条目须随改动同 commit 裁决 */
const DOC_MENTION_ALLOWLIST: readonly string[] = []

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

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('D9① 桌面壳装配检查（core 共享 helper）', () => {
  it('sessionEntry 端口束：切入链订阅/LRU 三成员非 no-op（useSidebar 重构删注入即红）', () => {
    // useSidebar() 构造期填充 __testing.sessionEntry（effectScope 承接链内 onScopeDispose 订阅）
    const scope = effectScope()
    scope.run(() => useSidebar())
    const { ok, problems } = checkSessionEntryAssembly(__testing.sessionEntry)
    scope.stop()
    expect(problems).toEqual([])
    expect(ok).toBe(true)
  })

  it('effects 最小集：exited/restored/restoreFailed 三生命周期回调已接（useConnection 装配同源）', () => {
    const { ok, problems } = checkInboundEffectsAssembly(createInboundEffects())
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
      // 出口定义文件自证放行（export const __testing 形态统一）
      if (content.includes('export const __testing')) return false
      return !DOC_MENTION_ALLOWLIST.includes(rel)
    })
    expect(offenders).toEqual([])
  })
})
