import { session as sessionApi, session as sessionMock } from '@/api';
import { createInboundEffects } from '@/composables/effects/useMessageEffects';
import { useSidebar, __testing } from '@/composables/features/sidebar/useSidebar';
import { useComposerShortcutActions, type ComposerShortcutActionDeps } from '@/composables/panel/composer-shortcut-actions';
import { modelSwitchErrorMessage, modelSwitchToastKey } from '@/composables/panel/model-switch-toast';
import { useTurnExpansion } from '@/composables/panel/useTurnExpansion';
import { triggerSessionCleanups, __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState';
import { useChatStore } from '@/stores/chat';
import { useTurnExpansionStore } from '@/stores/turn-expansion';
import { checkSessionEntryAssembly, checkInboundEffectsAssembly, _resetLruForTest } from '@taiji/core';
import { clearQueueEdit, isQueueEditAlive, startQueueEdit, type QueueEditAnchorPartition } from '@taiji/core/domain/composer';
import * as events from '@taiji/core/transport/api';
import type { SessionGroup, SessionSummary, Message, ModelInfo, ProviderId } from '@taiji/shared';
import { flushPromises } from '@vue/test-utils';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { effectScope, ref, effect } from 'vue';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - composables/features/sidebar/__tests__/useSidebar-bootstrap.test.ts
 * - composables/panel/__tests__/composables-panel-pure-bundle.test.ts
 */

// ======================================================================
// ← composables/features/sidebar/__tests__/useSidebar-bootstrap.test.ts
// ======================================================================

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
// 运行：cd packages/renderer && npx vitest run src/__tests__/wave3/happy-dom-10-composables-panel-pure-bundle-usesidebar-bootstrap.test.ts（assembly-check 节）


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
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/wave3/happy-dom-10-composables-panel-pure-bundle-usesidebar-bootstrap.test.ts（useSidebar-get-commands 节）
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

// ======================================================================
// ← composables/panel/__tests__/composables-panel-pure-bundle.test.ts
// ======================================================================

// ═══════════ 来源节：model-switch-toast ═══════════

describe('model-switch-toast', () => {
function err(code: string, message = 'engine said no'): Error & { code: string } {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}

describe('modelSwitchToastKey —— code → i18n key 单点映射', () => {
  it('4 个新码 → 各自专用文案 key（§3.4 错误规格表）', () => {
    expect(modelSwitchToastKey(err('SESSION_ACTIVATE_FAILED'))).toBe('panel.panel.modelSwitch.sessionActivateFailed')
    expect(modelSwitchToastKey(err('MODEL_NOT_FOUND'))).toBe('panel.panel.modelSwitch.modelNotFound')
    expect(modelSwitchToastKey(err('PROVIDER_CREDENTIAL_MISSING'))).toBe('panel.panel.modelSwitch.providerCredentialMissing')
    expect(modelSwitchToastKey(err('ENGINE_MODEL_MISSING'))).toBe('panel.panel.modelSwitch.engineModelMissing')
  })

  it('4 个既有透传码 → general（toast 文本含后端 message，不新增 key）', () => {
    for (const code of ['SESSION_NOT_FOUND', 'MODEL_NOT_CONFIGURED', 'RESTORE_FAILED', 'BUILTIN_EXTENSIONS_MISSING']) {
      expect(modelSwitchToastKey(err(code))).toBe('panel.panel.modelSwitch.general')
    }
  })

  it('未知码 / 数值码 / 无 code / 非对象输入 → general（兜底不炸）', () => {
    expect(modelSwitchToastKey(err('SOMETHING_ELSE'))).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey(Object.assign(new Error('x'), { code: -32603 }))).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey(new Error('plain'))).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey('string error')).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey(null)).toBe('panel.panel.modelSwitch.general')
    expect(modelSwitchToastKey(undefined)).toBe('panel.panel.modelSwitch.general')
  })

  it('modelSwitchErrorMessage：取 message 用于 {error} 插值；缺失退化为空串', () => {
    expect(modelSwitchErrorMessage(err('MODEL_NOT_FOUND', 'model not in taiji registry'))).toBe('model not in taiji registry')
    expect(modelSwitchErrorMessage('raw string')).toBe('raw string')
    expect(modelSwitchErrorMessage({ code: 'X' })).toBe('')
    expect(modelSwitchErrorMessage(null)).toBe('')
  })
})
})

// ═══════════ 来源节：useTurnExpansion ═══════════

describe('useTurnExpansion', () => {
beforeEach(() => {
  // 独立 Pinia 实例：每个 case 拿到全新 store（store 单例 per Pinia）
  setActivePinia(createPinia())
  // 重置模块级 cleanup 注册表，防上例注册残留污染下例（store 注册了 clearSession）
  __clearSessionCleanupRegistryForTest()
})

describe('useTurnExpansion (w1 wave IF1)', () => {
  it('TC-w1-1 isExpanded 默认折叠（key 不存在返回 false）', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded } = useTurnExpansion(sid)
    expect(isExpanded('turn-0')).toBe(false)
  })

  it('TC-w1-2 per-session 隔离：s1 expand(\'turn-0\') 不影响 s2', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand } = useTurnExpansion(sid)
    expand('turn-0')
    expect(isExpanded('turn-0')).toBe(true)

    // 切到 s2：store 按 sid 分区查 s2 分区（空），isExpanded 返回默认 false
    sid.value = 's2'
    expect(isExpanded('turn-0')).toBe(false)

    // 切回 s1：s1 分区数据保留（store Map 切 sid 不丢数据），仍 true
    sid.value = 's1'
    expect(isExpanded('turn-0')).toBe(true)
  })

  it('TC-w1-3 toggle 边沿：两次翻转回到原态', () => {
    const sid = ref<string | null>('s1')
    const { toggle, isExpanded } = useTurnExpansion(sid)

    toggle('turn-1')
    expect(isExpanded('turn-1')).toBe(true)

    toggle('turn-1')
    expect(isExpanded('turn-1')).toBe(false)
  })

  it('TC-w1-4 [C9 退役] 批量操作导出已删除（expandAll/collapseAll/hasAnyExpanded 不在公开面）', () => {
    const sid = ref<string | null>('s1')
    const api = useTurnExpansion(sid)
    expect('expandAll' in api).toBe(false)
    expect('collapseAll' in api).toBe(false)
    expect('hasAnyExpanded' in api).toBe(false)
  })

  it('TC-w1-5 null sessionId：所有写方法 no-op 不抛，isExpanded 返回 false', () => {
    const sid = ref<string | null>(null)
    const { isExpanded, toggle, expand } = useTurnExpansion(sid)

    expect(() => {
      toggle('turn-0')
      expand('turn-0')
    }).not.toThrow()

    expect(isExpanded('turn-0')).toBe(false)
  })

  it('TC-w1-6 cleanup 后状态重置（triggerSessionCleanups 移除分区）', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand } = useTurnExpansion(sid)
    expand('turn-0')
    expect(isExpanded('turn-0')).toBe(true)

    // 触发该 sid 的所有 cleanup（turn-expansion store 注册了 clearSession 到 cleanup registry）
    triggerSessionCleanups('s1')

    // store 分区被 clearSession 删除，下次访问惰性新建空分区 → isExpanded 回到默认 false
    expect(isExpanded('turn-0')).toBe(false)
  })

  it('TC-w1-7 响应式：expand 后下游 effect 重跑（依赖失效）', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand } = useTurnExpansion(sid)

    let runCount = 0
    const scope = effectScope()
    scope.run(() => {
      effect(() => {
        // 读 isExpanded 建立对 reactive 容器中该 key 的响应式依赖
        void isExpanded('turn-0')
        runCount++
      })
    })

    expect(runCount).toBe(1) // 首次跑建立依赖

    expand('turn-0') // mutate reactive 容器，effect 应失效重跑

    expect(runCount).toBe(2) // effect 重跑
    expect(isExpanded('turn-0')).toBe(true)

    scope.stop() // 清理 effect
  })

  it('TC-w1-9 响应式：写方法 false↔true 来回切 effect 持续重跑（collapse 赋值范式经 store 层验证）', () => {
    const sid = ref<string | null>('s1')
    // toggle 不解构：本用例 true→false 回切走 store 层 collapse（[C3]），toggle 路径由 TC-w1-3 覆盖
    const { isExpanded, expand } = useTurnExpansion(sid)

    let runCount = 0
    const scope = effectScope()
    scope.run(() => {
      effect(() => {
        // 读 isExpanded 建立对 reactive 容器中该 key 的响应式依赖
        void isExpanded('turn-0')
        runCount++
      })
    })

    expect(runCount).toBe(1) // 首次跑建立依赖

    expand('turn-0') // mutate reactive 容器（false→true），effect 失效重跑
    expect(runCount).toBe(2)
    expect(isExpanded('turn-0')).toBe(true)

    // [C3] 包装层 collapse 已随 deps.collapse 退役删除——true→false 回切走 store 层
    // collapse（赋值不 delete，保响应式链）等价驱动，效果一致：effect 应再次失效重跑
    useTurnExpansionStore().collapse('s1', 'turn-0')
    expect(runCount).toBe(3)
    expect(isExpanded('turn-0')).toBe(false)

    scope.stop()
  })
})

/* ──────────────────────────────────────────────────────────────
 * TC-w4-9：store per-session 隔离（w4 store 重构新增）
 * 验证：store 单例下，不同 sid 分区互不影响（w4 接线修复的核心场景）。
 * ────────────────────────────────────────────────────────────── */
describe('useTurnExpansionStore per-session 隔离（w4）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    __clearSessionCleanupRegistryForTest()
  })

  it('TC-w4-9 store per-session 隔离', () => {
    const store = useTurnExpansionStore()
    store.expand('s1', 'turn-1')
    expect(store.isExpanded('s1', 'turn-1')).toBe(true)
    // 隔离：s2 同 key 默认折叠（独立分区）
    expect(store.isExpanded('s2', 'turn-1')).toBe(false)
  })

  it('TC-w4-10 store 跨调用方共享（w4 接线修复目标：Turn.vue 与 MessageStream.vue 共享展开态）', () => {
    // 两次 useTurnExpansion 调用拿到同一 store（同 Pinia 实例），展开态共享
    const sid = ref<string | null>('shared-1')
    const callerA = useTurnExpansion(sid)
    const callerB = useTurnExpansion(sid)

    // A 展开 turn 'turn-0' → B 立即可见（w1 的 per-instance Map 不共享，w4 store 共享）
    callerA.expand('turn-0')
    expect(callerA.isExpanded('turn-0')).toBe(true)
    expect(callerB.isExpanded('turn-0')).toBe(true)

    // B 折叠（[C3] 包装层 collapse 已退役——true→false 回切走 store 层 collapse）→ A 立即可见
    useTurnExpansionStore().collapse('shared-1', 'turn-0')
    expect(callerA.isExpanded('turn-0')).toBe(false)
    expect(callerB.isExpanded('turn-0')).toBe(false)
  })
})
})

// ═══════════ 来源节：composer-shortcut-actions ═══════════

describe('composer-shortcut-actions', () => {
function mkModel(providerId: string, id: string, enabled = true): ModelInfo {
  return { id, name: id, providerId: providerId as ProviderId, providerName: providerId, enabled }
}

let msgSeq = 0
function mkMsg(role: Message['role'], content: Message['content'], status: Message['status'] = 'complete'): Message {
  msgSeq += 1
  return { id: `m${msgSeq}`, role, content, status, timestamp: msgSeq }
}

type KeyMods = {
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
  meta?: boolean
  repeat?: boolean
}

/** 构造带 preventDefault/stopPropagation spy 的键盘事件（repeat 经 defineProperty 注入，构造器初始化支持面不稳） */
function makeKeyEvent(key: string, mods: KeyMods = {}) {
  const e = new KeyboardEvent('keydown', {
    key,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    cancelable: true,
  })
  Object.defineProperty(e, 'repeat', { value: !!mods.repeat })
  const preventDefault = vi.fn()
  const stopPropagation = vi.fn()
  e.preventDefault = preventDefault
  e.stopPropagation = stopPropagation
  return { e, preventDefault, stopPropagation }
}

/** 选区 mock（§3.4 选区行；anchorNode 落点决定「composer 内选区」判定） */
function mockSelection(anchorNode: Node | null, collapsed = false): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: collapsed,
    rangeCount: collapsed ? 0 : 1,
    anchorNode,
  } as unknown as Selection)
}

/** navigator.clipboard 桩（happy-dom 无实现；configurable 供 afterEach 清除） */
function stubClipboard(fn: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(fn)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

/** fake deps（设计 §5 U1 deps 11 项全量注入；默认已建态 / 3 模型 prov::{a,b,c} / 4 档位 / current medium）。
 *  sessionId/currentThinkingLevel 用 in 判缺（非 ??）：显式 null/undefined（landing/占位）是合法测试态，不得被默认值吞掉 */
function makeDeps(opts: {
  cmdOpen?: boolean
  sessionId?: string | null
  isStaging?: boolean
  currentModelId?: string
  currentThinkingLevel?: string | undefined
  supportedLevels?: string[] | undefined
  models?: ModelInfo[]
  messages?: Message[]
} = {}) {
  const cmdOpen = ref(opts.cmdOpen ?? false)
  const sessionId = ref<string | null>('sessionId' in opts ? opts.sessionId! : 's1')
  const isStaging = ref(opts.isStaging ?? false)
  const currentModelId = ref(opts.currentModelId ?? 'prov/a')
  const currentThinkingLevel = ref<string | undefined>(
    'currentThinkingLevel' in opts ? opts.currentThinkingLevel : 'medium',
  )
  const currentSupportedLevels = ref<string[] | undefined>(
    opts.supportedLevels ?? ['off', 'low', 'medium', 'high'],
  )
  const enabledModels = ref<ModelInfo[]>(
    opts.models ?? [mkModel('prov', 'a'), mkModel('prov', 'b'), mkModel('prov', 'c')],
  )
  const onModelSelect = vi.fn((_payload: { modelId: string; provider: ProviderId }) => Promise.resolve())
  const onThinkingSelect = vi.fn((_level: string) => Promise.resolve())
  const getMessages = vi.fn((_sid: string) => opts.messages ?? [])
  const toastInfo = vi.fn()
  const toastError = vi.fn()
  const deps: ComposerShortcutActionDeps = {
    cmdOpen,
    sessionId,
    isStaging,
    currentModelId,
    currentThinkingLevel,
    currentSupportedLevels,
    enabledModels,
    onModelSelect,
    onThinkingSelect,
    getMessages,
    toast: { info: toastInfo, error: toastError },
  }
  return {
    deps,
    cmdOpen,
    sessionId,
    isStaging,
    currentModelId,
    currentThinkingLevel,
    currentSupportedLevels,
    enabledModels,
    onModelSelect,
    onThinkingSelect,
    getMessages,
    toastInfo,
    toastError,
  }
}

describe('useComposerShortcutActions', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  // ── 键位判定 + 事件拦截语义（§3.3 键位表 + §3.4 拦截语义/决策 7）──────────────
  describe('键位判定与事件拦截', () => {
    it('shift+tab 命中：档位循环触发 + preventDefault + stopPropagation + 返回 true', () => {
      const { deps, onThinkingSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e, preventDefault, stopPropagation } = makeKeyEvent('Tab', { shift: true })

      const consumed = handler(e)

      expect(consumed).toBe(true)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(onThinkingSelect).toHaveBeenCalledTimes(1)
    })

    it('ctrl+p 命中 model-forward：从当前真值前进一步', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/b' })
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('p', { ctrl: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledTimes(1)
      expect(onModelSelect.mock.calls[0][0]).toEqual({ modelId: 'c', provider: 'prov' })
    })

    it('ctrl+shift+p 命中 model-backward：从当前真值退一步（独立实例，避免意图续步跨用例语义混淆）', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/b' })
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('p', { ctrl: true, shift: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledTimes(1)
      expect(onModelSelect.mock.calls[0][0]).toEqual({ modelId: 'a', provider: 'prov' })
    })

    it('大写 \'P\' + ctrl 命中 model-forward（capslock/shift 平台 key 上报大写，toLowerCase 防线）', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/b' })
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('P', { ctrl: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledTimes(1)
      expect(onModelSelect.mock.calls[0][0]).toEqual({ modelId: 'c', provider: 'prov' })
    })

    it('大写 \'P\' + ctrl+shift 命中 model-backward（与 ctrl+p 是两个不同 action，独立实例防续步混淆）', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/b' })
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('P', { ctrl: true, shift: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledTimes(1)
      expect(onModelSelect.mock.calls[0][0]).toEqual({ modelId: 'a', provider: 'prov' })
    })

    it.each(['a', 'Enter', 'Tab'])('未命中键（%s）：返回 false 原样放行，无拦截无动作', (key) => {
      const { deps, onThinkingSelect, onModelSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e, preventDefault, stopPropagation } = makeKeyEvent(key)

      expect(handler(e)).toBe(false)
      expect(preventDefault).not.toHaveBeenCalled()
      expect(stopPropagation).not.toHaveBeenCalled()
      expect(onThinkingSelect).not.toHaveBeenCalled()
      expect(onModelSelect).not.toHaveBeenCalled()
    })

    it('修饰键约束：alt+p / ctrl+alt+p 不命中（决策 6 无 alt+p 绑定）；meta+p / meta+shift+p 不命中（⌘ 系冒泡给全局表，决策 7）', () => {
      const { deps, onModelSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)

      for (const { key, mods } of [
        { key: 'p', mods: { alt: true } },
        { key: 'p', mods: { ctrl: true, alt: true } },
        { key: 'p', mods: { meta: true } },
        { key: 'p', mods: { meta: true, shift: true } },
        { key: 'Tab', mods: { ctrl: true, shift: true } },
        { key: 'Tab', mods: { alt: true, shift: true } },
      ]) {
        const { e, preventDefault } = makeKeyEvent(key, mods)
        expect(handler(e), `${key} + ${JSON.stringify(mods)} 应不命中`).toBe(false)
        expect(preventDefault).not.toHaveBeenCalled()
      }
      expect(onModelSelect).not.toHaveBeenCalled()
    })
  })

  // ── 检查矩阵 §3.4 逐行 ──────────────────────────────────────────────────────
  describe('检查矩阵（§3.4 全行）', () => {
    // 行 1：命令浮层 open → 不触发（入口检查整体跳过，不吞键）
    it('浮层 open：shift+tab / ctrl+p 均不触发不吞键（入口 cmdOpen 检查直接 return false）', () => {
      const { deps, onThinkingSelect, onModelSelect } = makeDeps({ cmdOpen: true })
      const handler = useComposerShortcutActions(deps)

      const tab = makeKeyEvent('Tab', { shift: true })
      expect(handler(tab.e)).toBe(false)
      expect(tab.preventDefault).not.toHaveBeenCalled()
      const p = makeKeyEvent('p', { ctrl: true })
      expect(handler(p.e)).toBe(false)
      expect(p.preventDefault).not.toHaveBeenCalled()

      expect(onThinkingSelect).not.toHaveBeenCalled()
      expect(onModelSelect).not.toHaveBeenCalled()
    })

    // 行 2（IME）：模块级不复判——分发链 IME 段是单点防线（composer-keydown.test.ts 钉住），
    // 本表只经分发链调用（over-engineering-audit 20260916 裁决删除模块级二次检查）

    // 行 3：auto-repeat —— 三个切换键忽略；ctrl+x 不忽略（决策 8 幂等例外）
    it('auto-repeat：shift+tab 忽略（吞键不动作，防 RPC 风暴）', () => {
      const { deps, onThinkingSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e, preventDefault } = makeKeyEvent('Tab', { shift: true, repeat: true })

      expect(handler(e)).toBe(true)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onThinkingSelect).not.toHaveBeenCalled()
    })

    it('auto-repeat：ctrl+p 忽略（吞键不动作）', () => {
      const { deps, onModelSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('p', { ctrl: true, repeat: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).not.toHaveBeenCalled()
    })

    it('auto-repeat：ctrl+shift+p 忽略（吞键不动作）', () => {
      const { deps, onModelSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('p', { ctrl: true, shift: true, repeat: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).not.toHaveBeenCalled()
    })

    it('auto-repeat：ctrl+x 不忽略（幂等无 RPC，决策 8 例外——照常复制）', () => {
      const { deps } = makeDeps({
        messages: [mkMsg('assistant', 'streaming partial')],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())
      const { e } = makeKeyEvent('x', { ctrl: true, repeat: true })

      expect(handler(e)).toBe(true)
      expect(writeText).toHaveBeenCalledWith('streaming partial')
    })

    // 行 4：composer 内有选区 —— ctrl+x 放行原生剪切；三个切换键正常触发（选区检查只挂 copy 分支）
    it('选区行：composer 内有选区时 ctrl+x 放行原生剪切（不拦截、不触发复制动作）', () => {
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      document.body.appendChild(editor)
      editor.focus()
      expect(document.activeElement).toBe(editor) // 造态自检：焦点在输入框
      mockSelection(editor)

      const { deps, toastInfo } = makeDeps({ messages: [mkMsg('assistant', 'reply')] })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())
      const { e, preventDefault } = makeKeyEvent('x', { ctrl: true })

      expect(handler(e)).toBe(false)
      expect(preventDefault).not.toHaveBeenCalled()
      expect(writeText).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('选区行：选区锚点在焦点元素外（非 composer 选区）→ ctrl+x 照常触发复制', () => {
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      document.body.appendChild(editor)
      editor.focus()
      const detached = document.createElement('span') // 未挂载：不在任何焦点祖先内
      mockSelection(detached)

      const { deps } = makeDeps({ messages: [mkMsg('assistant', 'reply')] })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      expect(handler(makeKeyEvent('x', { ctrl: true }).e)).toBe(true)
      expect(writeText).toHaveBeenCalledWith('reply')
    })

    it('选区行：shift+tab 与选区无关，正常触发档位循环', () => {
      const editor = document.createElement('div')
      document.body.appendChild(editor)
      editor.focus()
      mockSelection(editor)

      const { deps, onThinkingSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)

      expect(handler(makeKeyEvent('Tab', { shift: true }).e)).toBe(true)
      expect(onThinkingSelect).toHaveBeenCalledTimes(1)
    })

    it('选区行：composer 内有选区时 ctrl+p / ctrl+shift+p 正常触发模型双向循环（选区检查只挂 copy 分支）', () => {
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      document.body.appendChild(editor)
      editor.focus()
      mockSelection(editor)

      // 独立实例：避免决策 8 意图续步把第一按目标当第二按起点，保持「选区无关」单变量语义
      const forward = makeDeps({ currentModelId: 'prov/b' })
      const forwardHandler = useComposerShortcutActions(forward.deps)
      expect(forwardHandler(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(forward.onModelSelect).toHaveBeenCalledTimes(1)
      expect(forward.onModelSelect).toHaveBeenCalledWith({ modelId: 'c', provider: 'prov' })

      const backward = makeDeps({ currentModelId: 'prov/b' })
      const backwardHandler = useComposerShortcutActions(backward.deps)
      expect(backwardHandler(makeKeyEvent('p', { ctrl: true, shift: true }).e)).toBe(true)
      expect(backward.onModelSelect).toHaveBeenCalledTimes(1)
      expect(backward.onModelSelect).toHaveBeenCalledWith({ modelId: 'a', provider: 'prov' })
    })

    // 行 5：staging 活跃 —— 切换改暂存值（core 快照路由，经同一 onModelSelect/onThinkingSelect）；复制正常
    it('staging 活跃：shift+tab / ctrl+p 经同一入口触发（写暂存快照由 core 三分支承接）', () => {
      const { deps, onThinkingSelect, onModelSelect } = makeDeps({ isStaging: true })
      const handler = useComposerShortcutActions(deps)

      expect(handler(makeKeyEvent('Tab', { shift: true }).e)).toBe(true)
      expect(onThinkingSelect).toHaveBeenCalledWith('high')
      expect(handler(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledWith({ modelId: 'b', provider: 'prov' })
    })

    it('staging 活跃：ctrl+x 正常复制（staging 不影响消息流）', () => {
      const { deps } = makeDeps({
        isStaging: true,
        messages: [mkMsg('assistant', 'staged flow reply')],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      expect(handler(makeKeyEvent('x', { ctrl: true }).e)).toBe(true)
      expect(writeText).toHaveBeenCalledWith('staged flow reply')
    })

    // 行 6：landing 态（sessionId=null）—— 切换写 pending/localThinkingLevel 路径（core 承接，经同一入口）；复制无消息流
    it('landing 态：shift+tab / ctrl+p 经同一入口触发（写 localThinkingLevel/pendingModel 由 core 承接）', () => {
      const { deps, onThinkingSelect, onModelSelect } = makeDeps({ sessionId: null })
      const handler = useComposerShortcutActions(deps)

      expect(handler(makeKeyEvent('Tab', { shift: true }).e)).toBe(true)
      expect(onThinkingSelect).toHaveBeenCalledTimes(1)
      expect(handler(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledTimes(1)
    })

    it('landing 态：ctrl+x 无消息流 → no-op 无 toast（键吞掉）', () => {
      const { deps, toastInfo, toastError } = makeDeps({ sessionId: null })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())
      const { e } = makeKeyEvent('x', { ctrl: true })

      expect(handler(e)).toBe(true)
      expect(writeText).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    })

    // 行 7：已建态 → RPC + 回执真值 + 决策 8 续步（生命周期专项在下方 describe）
    // 行 8：档位可用集仅 off（non-reasoning）→ no-op（键吞掉）
    it('档位可用集仅 off：shift+tab no-op（键吞掉、无动作、无噪音）', () => {
      const { deps, onThinkingSelect } = makeDeps({ supportedLevels: ['off'], currentThinkingLevel: 'off' })
      const handler = useComposerShortcutActions(deps)
      const { e, preventDefault, stopPropagation } = makeKeyEvent('Tab', { shift: true })

      expect(handler(e)).toBe(true)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(onThinkingSelect).not.toHaveBeenCalled()
    })

    // 行 9：模型列表 ≤1 → no-op（键吞掉）
    it('模型列表 ≤1 或空：ctrl+p / ctrl+shift+p no-op（键吞掉）', () => {
      const single = makeDeps({ models: [mkModel('prov', 'a')], currentModelId: 'prov/a' })
      const handlerSingle = useComposerShortcutActions(single.deps)
      expect(handlerSingle(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(handlerSingle(makeKeyEvent('p', { ctrl: true, shift: true }).e)).toBe(true)
      expect(single.onModelSelect).not.toHaveBeenCalled()

      const empty = makeDeps({ models: [], currentModelId: '' })
      const handlerEmpty = useComposerShortcutActions(empty.deps)
      expect(handlerEmpty(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(empty.onModelSelect).not.toHaveBeenCalled()
    })
  })

  // ── 循环取值与起点规则（§3.3）───────────────────────────────────────────────
  describe('循环取值与起点规则', () => {
    it('模型 forward 绕回：表尾 → 表头', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/c' })
      useComposerShortcutActions(deps)(makeKeyEvent('p', { ctrl: true }).e)
      expect(onModelSelect).toHaveBeenCalledWith({ modelId: 'a', provider: 'prov' })
    })

    it('模型 backward 绕回：表头 → 表尾', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/a' })
      useComposerShortcutActions(deps)(makeKeyEvent('p', { ctrl: true, shift: true }).e)
      expect(onModelSelect).toHaveBeenCalledWith({ modelId: 'c', provider: 'prov' })
    })

    it('模型起点不在列表（landing 占位空串）：forward 取第一个 / backward 取最后一个', () => {
      const forward = makeDeps({ currentModelId: '' })
      useComposerShortcutActions(forward.deps)(makeKeyEvent('p', { ctrl: true }).e)
      expect(forward.onModelSelect).toHaveBeenCalledWith({ modelId: 'a', provider: 'prov' })

      const backward = makeDeps({ currentModelId: '' })
      useComposerShortcutActions(backward.deps)(makeKeyEvent('p', { ctrl: true, shift: true }).e)
      expect(backward.onModelSelect).toHaveBeenCalledWith({ modelId: 'c', provider: 'prov' })
    })

    it('模型循环序 = deps.enabledModels 注入序（壳层负责 enabled 过滤，模块零过滤逻辑）：按注入序循环', () => {
      // 契约：composer-shell 组装时已按 enabled !== false 兜底过滤（ModelSelectPopover 双保险
      // 同款），模块直接消费注入列表——此处注入已过滤的 [a, c]（b 禁用被壳层剔除）
      const { deps, onModelSelect } = makeDeps({
        currentModelId: 'prov/a',
        models: [mkModel('prov', 'a'), mkModel('prov', 'c')],
      })
      useComposerShortcutActions(deps)(makeKeyEvent('p', { ctrl: true }).e)
      expect(onModelSelect).toHaveBeenCalledWith({ modelId: 'c', provider: 'prov' })
    })

    it('thinking 起点 undefined（占位）：取归一序列第一档（off）', () => {
      const { deps, onThinkingSelect } = makeDeps({ currentThinkingLevel: undefined })
      useComposerShortcutActions(deps)(makeKeyEvent('Tab', { shift: true }).e)
      expect(onThinkingSelect).toHaveBeenCalledWith('off')
    })

    it('thinking 起点为脏值（不在归一集，钳制残值）：forward 取第一档', () => {
      // supportedLevels 含非法值 'bogus' → 归一 ['off','high']；'weird' 不在归一集 → 取 'off'
      const { deps, onThinkingSelect } = makeDeps({
        currentThinkingLevel: 'weird',
        supportedLevels: ['high', 'off', 'bogus'],
      })
      useComposerShortcutActions(deps)(makeKeyEvent('Tab', { shift: true }).e)
      expect(onThinkingSelect).toHaveBeenCalledWith('off')
    })

    it('thinking supportedLevels undefined：归一默认五档（off..high），medium → high', () => {
      const { deps, onThinkingSelect } = makeDeps({
        currentThinkingLevel: 'medium',
        supportedLevels: undefined,
      })
      useComposerShortcutActions(deps)(makeKeyEvent('Tab', { shift: true }).e)
      expect(onThinkingSelect).toHaveBeenCalledWith('high')
    })

    it('thinking 绕回：表尾（high）→ off', () => {
      const { deps, onThinkingSelect } = makeDeps({ currentThinkingLevel: 'high' })
      useComposerShortcutActions(deps)(makeKeyEvent('Tab', { shift: true }).e)
      expect(onThinkingSelect).toHaveBeenCalledWith('off')
    })
  })

  // ── 决策 8 意图目标生命周期（已建态）────────────────────────────────────────
  describe('决策 8：意图目标生命周期（仅已建态设立与续步）', () => {
    function makePendingDeps(opts: Parameters<typeof makeDeps>[0] = {}) {
      const ctx = makeDeps(opts)
      // RPC 永不 settle：模拟 RTT 窗口（回执未到），意图目标为唯一计算起点
      ctx.onModelSelect.mockImplementation(() => new Promise<void>(() => {}))
      ctx.onThinkingSelect.mockImplementation(() => new Promise<void>(() => {}))
      return ctx
    }

    it('模型 RTT 内连按 3 次：意图目标续步，目标逐次递进 b→c→d（不重步）', () => {
      const { deps, onModelSelect } = makePendingDeps({
        currentModelId: 'prov/a',
        models: [mkModel('prov', 'a'), mkModel('prov', 'b'), mkModel('prov', 'c'), mkModel('prov', 'd')],
      })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e)
      handler(makeKeyEvent('p', { ctrl: true }).e)
      handler(makeKeyEvent('p', { ctrl: true }).e)

      expect(onModelSelect.mock.calls.map((c) => c[0].modelId)).toEqual(['b', 'c', 'd'])
    })

    it('thinking RTT 内连按 3 次：档位逐次递进 high→off（绕回）→low', () => {
      const { deps, onThinkingSelect } = makePendingDeps({ currentThinkingLevel: 'medium' })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('Tab', { shift: true }).e)
      handler(makeKeyEvent('Tab', { shift: true }).e)
      handler(makeKeyEvent('Tab', { shift: true }).e)

      expect(onThinkingSelect.mock.calls.map((c) => c[0])).toEqual(['high', 'off', 'low'])
    })

    it('等值清：回执真值到达且等于意图目标后清除——后续按键从新真值起算（而非残留意图）', async () => {
      const { deps, onModelSelect, currentModelId } = makeDeps({ currentModelId: 'prov/a' })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e) // 意图 b
      await flushPromises() // 回执到达
      currentModelId.value = 'prov/b' // store 真值 = 意图目标 → 等值清
      await flushPromises()

      // 外部把真值挪回 a（session 快照重新拉取等）：若意图未清，续步起点 b → 目标 c（错）
      currentModelId.value = 'prov/a'
      await flushPromises()
      handler(makeKeyEvent('p', { ctrl: true }).e)
      expect(onModelSelect).toHaveBeenCalledTimes(2)
      expect(onModelSelect.mock.calls[1][0]).toEqual({ modelId: 'b', provider: 'prov' })
    })

    it('reject 清：RPC 失败清除意图目标 + console.warn 诊断 + 一次 toast（U4 改写原「无 toast」规格）——连按从真值重新起算', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { deps, onModelSelect, toastInfo, toastError } = makeDeps({ currentModelId: 'prov/a' })
      onModelSelect.mockImplementationOnce(() => Promise.reject(new Error('rpc down')))
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e) // 意图 b，随后 reject
      await flushPromises()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(toastInfo).not.toHaveBeenCalled()
      // U4（model-switch-live-provider-sync §3.4/D7）：键盘循环是用户显式动作，失败必须闭环提示——
      // 每条路径恰一个 toast 点（键盘路径 = 此处；UI 路径 = 壳层包装，二者不叠加）。
      // 无 code 的错误落 general 文案 key。
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('panel.panel.modelSwitch.general')

      // 意图已清 → 从真值 a 起算目标 b（若残留意图 b 则会算出 c）
      handler(makeKeyEvent('p', { ctrl: true }).e)
      expect(onModelSelect).toHaveBeenCalledTimes(2)
      expect(onModelSelect.mock.calls[1][0]).toEqual({ modelId: 'b', provider: 'prov' })
    })

    it('sessionId 变化即清：跨 session 不残留意图错一步起点', async () => {
      const { deps, onModelSelect, sessionId } = makePendingDeps({ currentModelId: 'prov/a' })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e) // session s1：意图 b
      sessionId.value = 's2'
      await flushPromises()
      handler(makeKeyEvent('p', { ctrl: true }).e)

      // 真值仍 a → 目标 b（若残留意图 b 则续步到 c）
      expect(onModelSelect).toHaveBeenCalledTimes(2)
      expect(onModelSelect.mock.calls[1][0]).toEqual({ modelId: 'b', provider: 'prov' })
    })

    it('进入 staging 即清：已建 in-flight 意图不跨态残留（影响面审 S-1）', async () => {
      const { deps, onModelSelect, isStaging } = makePendingDeps({ currentModelId: 'prov/a' })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e) // 已建态：意图 b
      isStaging.value = true // 进入 fork staging
      await flushPromises()
      handler(makeKeyEvent('p', { ctrl: true }).e) // staging 分支：起点应为真值 a

      expect(onModelSelect).toHaveBeenCalledTimes(2)
      expect(onModelSelect.mock.calls[1][0]).toEqual({ modelId: 'b', provider: 'prov' })
    })

    it('landing 态不设意图：RTT 内连按两次均从真值起算（同步写语义，目标相同不重步缺失）', () => {
      const { deps, onThinkingSelect } = makePendingDeps({
        sessionId: null,
        currentThinkingLevel: 'medium',
      })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('Tab', { shift: true }).e)
      handler(makeKeyEvent('Tab', { shift: true }).e)

      // 无意图 → 两次起点都是真值 medium → 两次目标都是 high（若有意图则第二次为 off）
      expect(onThinkingSelect.mock.calls.map((c) => c[0])).toEqual(['high', 'high'])
    })
  })

  // ── 复制动作（§3.3 决策 4 + §3.5 错误规格）──────────────────────────────────
  describe('复制动作（ctrl+x）', () => {
    it('最后一条 assistant 纯文本复制成功：clipboard 写入 + toast info + 拦截', async () => {
      const { deps, toastInfo, toastError } = makeDeps({
        messages: [
          mkMsg('user', 'q1'),
          mkMsg('assistant', 'first reply'),
          mkMsg('user', 'q2'),
          mkMsg('assistant', 'second reply'),
        ],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())
      const { e, preventDefault } = makeKeyEvent('x', { ctrl: true })

      expect(handler(e)).toBe(true)
      await flushPromises()
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('second reply')
      expect(toastInfo).toHaveBeenCalledWith('panel.composer.copyLastReply')
      expect(toastError).not.toHaveBeenCalled()
      expect(preventDefault).toHaveBeenCalledTimes(1)
    })

    it('assistant content 为 Segment[]：normalizeContent 归一纯文本后写入', async () => {
      const { deps } = makeDeps({
        messages: [mkMsg('assistant', [{ type: 'text', text: 'segment text' }])],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      handler(makeKeyEvent('x', { ctrl: true }).e)
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('segment text')
    })

    it('clipboard writeText reject：toast error「复制失败」+ 不抛出（无 unhandled rejection）', async () => {
      const { deps, toastInfo, toastError } = makeDeps({
        messages: [mkMsg('assistant', 'reply')],
      })
      const handler = useComposerShortcutActions(deps)
      stubClipboard(() => Promise.reject(new Error('clipboard denied')))

      expect(() => handler(makeKeyEvent('x', { ctrl: true }).e)).not.toThrow()
      await flushPromises()
      expect(toastError).toHaveBeenCalledWith('panel.composer.copyLastReplyFailed')
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('空流（无 assistant 消息）：no-op 不弹 toast（避免空态噪音），键吞掉', () => {
      const { deps, toastInfo, toastError } = makeDeps({ messages: [mkMsg('user', 'only user')] })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      expect(handler(makeKeyEvent('x', { ctrl: true }).e)).toBe(true)
      expect(writeText).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    })

    it('最后一条 assistant 为错误消息（status=error）：照常复制错误全文（§3.5）', async () => {
      const { deps } = makeDeps({
        messages: [mkMsg('assistant', 'ok'), mkMsg('assistant', 'boom', 'error')],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      handler(makeKeyEvent('x', { ctrl: true }).e)
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('boom')
    })

    it('复制内容为空串：写剪贴板空串 + toast info 照常提示（§3.5）', async () => {
      const { deps, toastInfo } = makeDeps({ messages: [mkMsg('assistant', '')] })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      handler(makeKeyEvent('x', { ctrl: true }).e)
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('')
      expect(toastInfo).toHaveBeenCalledWith('panel.composer.copyLastReply')
    })
  })
})
})

// ═══════════ 来源节：queue-edit-anchor ═══════════

describe('queue-edit-anchor', () => {
function partition(clientUuid: string | null = null): QueueEditAnchorPartition {
  return { clientUuid }
}

describe('startQueueEdit · 单锚定不变式（Q4 三裁决）', () => {
  it('无锚定 → started 且锚定登记', () => {
    const p = partition()
    expect(startQueueEdit(p, 'u-1')).toBe('started')
    expect(p.clientUuid).toBe('u-1')
  })

  it('同一行再点 ✎ → already-editing-same（幂等 no-op：不重新 peek 不覆盖草稿）', () => {
    const p = partition('u-1')
    expect(startQueueEdit(p, 'u-1')).toBe('already-editing-same')
    expect(p.clientUuid).toBe('u-1')
  })

  it('编辑 A 中点 B 行 → conflict（锚定不切换，拦截由壳层提示）', () => {
    const p = partition('u-1')
    expect(startQueueEdit(p, 'u-2')).toBe('conflict')
    expect(p.clientUuid).toBe('u-1') // 原锚定不被覆盖
  })
})

describe('clearQueueEdit · 解除单点', () => {
  it('解除后归 null；重复解除幂等', () => {
    const p = partition('u-1')
    clearQueueEdit(p)
    expect(p.clientUuid).toBeNull()
    clearQueueEdit(p)
    expect(p.clientUuid).toBeNull()
  })
})

describe('isQueueEditAlive · 帧驱动活性（Q3）', () => {
  const rows = [{ clientUuid: 'u-1' }, { clientUuid: 'u-2' }]

  it('锚定条目在派生队列行中（queued/in-flight/failed）→ alive', () => {
    expect(isQueueEditAlive(rows, 'u-2')).toBe(true)
  })

  it('条目离场（delivered 被谓词滤除 / cancelled 不进帧 / 行消失）→ 不 alive', () => {
    expect(isQueueEditAlive(rows, 'u-gone')).toBe(false)
  })

  it('无锚定（null）→ 恒 false（空集调用安全）', () => {
    expect(isQueueEditAlive(rows, null)).toBe(false)
    expect(isQueueEditAlive([], null)).toBe(false)
  })
})
})
