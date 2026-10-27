/**
 * useSidebar 装配与 selectSession 契约测试合并文件（round6 测试提速，同被测对象簇：
 * 真实 useSidebar 链、@/api 全量 mock 同款）。
 *
 * 本文件由以下两文件原样搬运合并（describe/it 名零改动）：
 * - src/__tests__/assembly-check.test.ts（D9① 装配检查 + D9② __testing 出口纪律；
 *   process.cwd() 锚定包根，随目录位移不变）
 * - src/__tests__/useSidebar-get-commands.test.ts（selectSession 不再主动拉 commands）
 *
 * 剔出登记：src/__tests__/new-task/app-bootstrap.test.ts 原计划并入本簇（同用真实
 * useSidebar），2026-10-27 外部工作区回退事故后其「§6.4 在途版」依赖同批被回退的
 * 生产源码改动（域同步器语义），HEAD 版测试与 HEAD 源码自洽——按规则保留独立不合并，
 * 由其归属会话处置。
 *
 * 合并统一：'@/api' 两源全量工厂去重为并集单例 apiCtrl（hoisted，内联默认 resolve 值
 * 取两源原语义）；各节 beforeEach 自复位（clearAllMocks），节间先后不串。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/sidebar/__tests__/useSidebar-bootstrap.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import {
  checkSessionEntryAssembly,
  checkInboundEffectsAssembly,
  _resetLruForTest,
} from '@taiji/core'
import * as events from '@taiji/core/transport/api'
import { session as sessionApi, session as sessionMock } from '@/api'
import { useSidebar, __testing } from '@/composables/features/sidebar/useSidebar'
import { createInboundEffects } from '@/composables/effects/useMessageEffects'
import { useChatStore } from '@/stores/chat'

// '@/api' 并集工厂（两节共享；内联默认值 = assembly-check/get-commands 原工厂语义）
const apiCtrl = vi.hoisted(() => ({
  project: {
    load: vi.fn(() => Promise.resolve({ projects: [], activeProjectId: '' })),
    save: vi.fn(() => Promise.resolve(undefined)),
  },
  chat: {
    getHistory: vi.fn(() => Promise.resolve([])),
    streamSubscribe: vi.fn(() => () => {}),
  },
  session: {
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1 })),
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    // D2 驱逐退订复合入口的 RPC 通道（evictLruWithUnsubscribe fire-and-forget 消费）
    unsubscribe: vi.fn(() => Promise.resolve()),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
    getCommands: vi.fn(() => Promise.resolve({ sessionId: 's1', commands: [
      { name: '/commit', description: '提交', source: 'extension' },
      { name: 'skill:code-review', description: '审查', source: 'skill' },
    ] })),
    getContext: vi.fn(() => Promise.resolve({ inputTokens: 0, contextLimit: 0, usagePercent: 0 })),
  },
  // selectSession 触发 loadTree（文件树预加载）等 fire-and-forget 外围
  file: { tree: vi.fn(() => Promise.resolve([])), expand: vi.fn(() => Promise.resolve([])) },
  git: { status: vi.fn(() => Promise.resolve({ sessionId: 's1', isRepo: false, files: [] })) },
}))
vi.mock('@/api', () => apiCtrl)

// ══════════════ 源: src/__tests__/assembly-check.test.ts ══════════════
// 桌面壳装配检查（remote-use D9① 双壳测试 + D9② __testing 出口纪律）。
//
// 断言逻辑 = core 共享 helper（checkSessionEntryAssembly / checkInboundEffectsAssembly），
// 与移动壳（该用例现并入 packages/mobile-renderer/src/__tests__/mobile-package-and-delivery.test.ts）各调同一 helper——
// 桌面侧防未来重构 useSidebar 时静默删 sessionEntry 注入（ac1-dependency-edge 同款护栏立场：
// 装配缺口是静默的，重构删注入无报错，测试期机器报红是唯一防线）。
//
// 断言入口：
// - useSidebar.__testing.sessionEntry —— sessionEntry 端口束原始注入点（composable 内构造，
//   useSidebar() 调用时填充；测试后门命名空间生产代码禁止消费，对齐 useExtensionHostBridge
//   __testing 先例——导出测试专用符号不扩大 API 面常驻语义）
// - createInboundEffects() —— effects 回调集工厂（useMessageEffects 公开导出，useConnection
//   装配点同源）
//
// __testing 零消费 grep 断言（D9②）：扫描本包 src 生产文件（排除测试与出口定义点），
// 出现 __testing 标识符即违规。与移动壳测试同构，扫描根/注释提及白名单按包各自声明。
//
// 运行：cd packages/renderer && npx vitest run src/__tests__/assembly-check.test.ts



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

describe('D9 桌面壳装配检查 —— 源: src/__tests__/assembly-check.test.ts', () => {
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
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

  it('evictLru 接 D2 驱逐+退订复合入口：超阈值驱逐对被驱逐 sid 发 session.unsubscribe（裸接 chat.evictIfNeeded 即红）', () => {
    _resetLruForTest()
    const scope = effectScope()
    scope.run(() => useSidebar())
    const entry = __testing.sessionEntry!
    const chatStore = useChatStore()
    // LRU_MAX_SESSIONS=8：9 分区触发阈值驱逐，插入序最前者被逐（同毫秒稳定排序保留插入序）
    for (let i = 0; i < 9; i++) chatStore.hydrate(`evict-s${i}`, [])

    entry.evictLru(null)

    // 驱逐本体仍生效（改接未破坏 evictIfNeeded 语义）
    expect(chatStore.isHydrated('evict-s0')).toBe(false)
    expect(chatStore.isHydrated('evict-s8')).toBe(true)
    // 复合入口的退订半边：被驱逐 sid 恰好一次 unsubscribe RPC，保留区零 RPC——
    // 裸接 chat.evictIfNeeded() 时该 mock 零调用，断言即红
    expect(vi.mocked(sessionApi.unsubscribe)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sessionApi.unsubscribe)).toHaveBeenCalledWith('evict-s0')
    scope.stop()
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
})

// ══════════════ 源: src/__tests__/useSidebar-get-commands.test.ts ══════════════
describe('selectSession 不再主动拉 commands —— 源: src/__tests__/useSidebar-get-commands.test.ts', () => {
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/**
 * wave:remove-bandaids 测试：selectSession 不再主动拉 commands/context。
 *
 * 历史：原 bandaid 修复 broadcast 与订阅时序竞争（runtime broadcast session.commands 早于
 * renderer 订阅新 sessionId 通道被丢弃），selectSession 在 activeId 更新后主动调 getCommands。
 * 现已删除——commands 由 useChat.ensureStreamSubscription → subscribeSession → applySnapshot 的
 * stateSnapshot dispatch 提供（routeInbound 兜底分支更新 commandStore）。
 *
 * 本测试反转原断言：验证 getCommands 不再被 selectSession 调用（R4：保留 RPC handler，
 * 其他独立场景仍可调用；sessionApi.getCommands RPC 客户端函数保留）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/useSidebar-get-commands.test.ts
 */





function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1 }
}

function makeGroups(ids: string[]): SessionGroup[] {
  return [{ cwd: '/proj', sessions: ids.map(makeSummary) }]
}

it('U1: selectSession 不再主动调 sessionApi.getCommands（wave:remove-bandaids 删兜底）', async () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebar())!
  events.dispatchGlobal({ type: 'config.sessions', payload: { groups: makeGroups(['s1']) } })

  await sidebar.selectSession('s1')

  expect(sessionMock.switchSession).toHaveBeenCalledWith('s1')
  // 关键断言：getCommands 不再被 selectSession 调用（commands 由 subscribe stateSnapshot 提供）
  expect(sessionMock.getCommands).not.toHaveBeenCalled()
  scope.stop()
})

it('U2: selectSession 不再主动调 sessionApi.getContext（wave:remove-bandaids 删兜底）', async () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebar())!
  events.dispatchGlobal({ type: 'config.sessions', payload: { groups: makeGroups(['s1']) } })

  await sidebar.selectSession('s1')

  // getContext 不再被 selectSession 调用（context 由 subscribe stateSnapshot 提供）
  expect(sessionMock.getContext).not.toHaveBeenCalled()
  scope.stop()
})

it('U3: selectSession 不向 session 通道本地投递 session.commands（由 subscribe stateSnapshot 接管）', async () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebar())!
  events.dispatchGlobal({ type: 'config.sessions', payload: { groups: makeGroups(['s1']) } })

  const received: Array<{ type: string; payload: { commands?: unknown[] } }> = []
  events.on('s1', (msg) => received.push(msg as never))

  await sidebar.selectSession('s1')

  // selectSession 不再本地 dispatch session.commands（subscribe stateSnapshot 接管，
  // 此处 mock 未触发 subscribeSession，故 commands 消息不应出现）
  const cmdMsgs = received.filter((m) => m.type === 'session.commands' && m.payload.commands)
  expect(cmdMsgs).toHaveLength(0)
  scope.stop()
})
})
