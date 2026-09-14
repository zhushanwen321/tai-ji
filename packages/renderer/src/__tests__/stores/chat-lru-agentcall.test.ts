/**
 * [B9 agentcall 分区 LRU 联动] renderer 装配链路集成测试
 * （docs/design/memory-leak-remediation.md §3.3-B9 / 验收 A6 单测层）。
 *
 * 覆盖装配全链：stores/chat.ts → agentcall-lru-linkage（装配点）→ core lru.ts 联动驱逐 +
 * drawer control getViewedVids 豁免。核心断言（对应 A6 场景表行）：
 * - 联动驱逐：主 session 被 LRU 阈值驱逐时，未查看的 agentcall 分区释放（getMessages → []）
 * - 豁免：正被查看的 agentcall 分区存活、drawer 不白屏；关闭 drawer 后再驱逐，分区释放
 * - 两路径：evictSessionWithVirtual 显式驱逐同样联动
 * - 豁免源钉死 panel 枚举：曾开过 drawer、焦点已切走的 session 分区不被全枚举豁免
 *
 * panel store 用模块 mock（对齐 useSideDrawer.test.ts 模式——豁免查询源经装配模块绑定的
 * panel 枚举 computed，mock 使其与用例内焦点切换同步）；workflow/chat store 走真实 pinia。
 *
 * 另含（原 chat-lru.test.ts / useSidebar-lru-panel-exempt.test.ts 并入）：
 * - M7/D6 虚拟 key 清理契约（subagentVirtualId 真实工厂 + agentcall 两段式不联动；
 *   纯策略行为 core lru.test.ts 已逐条覆盖，renderer 侧只保留装配增量）
 * - selectSession 全链路 touchLru 接线（AC-2：切 9 个最旧被驱逐，方案 C 不架空 LRU）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-lru-agentcall.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock panel store：控制 panel 枚举 + focusedSessionId（豁免查询源 + drawer 分区键）──
const mockFocusedSessionId = ref<string | null>(null)
const mockPanels = ref<Array<{ id: string; sessionId: string | null }>>([
  { id: 'panel-root', sessionId: null },
])

vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    get focusedSessionId() {
      return mockFocusedSessionId.value
    },
    get panels() {
      return mockPanels.value
    },
    loadSession(panelId: string, sessionId: string | null) {
      const p = mockPanels.value.find((leaf) => leaf.id === panelId)
      if (p) {
        p.sessionId = sessionId
        if (panelId === 'panel-root') mockFocusedSessionId.value = sessionId
      }
    },
  }),
}))

// ── selectSession 全链路用例（原 panel-exempt 并入）所需 mock：fileTree / useChat / useFileTree ──
const clearSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ clearSession: clearSessionMock }),
}))
const useChatDisposeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ disposeSession: useChatDisposeMock }),
  ensureStreamSubscription: vi.fn(),
}))
const loadTreeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/file-tree/useFileTree', () => ({
  useFileTree: () => ({ loadTree: loadTreeMock }),
}))

// ── mock api 域（selectSession 链路 RPC；getHistory 由 historyBackend 取数对齐 reconcile 基线）──
const switchSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const getHistoryMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })))
const getCommandsMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ commands: [] })))
const getContextMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { getHistory: getHistoryMock, streamSubscribe: vi.fn(() => () => {}) },
  extension: {},
  session: {
    create: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1' })),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: switchSessionMock,
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    getSubagents: vi.fn(() => Promise.resolve([])),
    getWorkflows: vi.fn(() => Promise.resolve([])),
    getAgentCallHistory: vi.fn(() => Promise.resolve([])),
    getCommands: getCommandsMock,
    getContext: getContextMock,
  },
}))

import { useChatStore } from '@/stores/chat'
import { subagentVirtualId } from '@/stores/subagent'
import { useWorkflowStore, agentCallVirtualId } from '@/stores/workflow'
// useSideDrawer 模块顶层绑定 drawer 分区键（bindDrawerSessionId ← panel focusedSessionId）——
// 生产链路 side effect，测试 import 即激活（与真实 App 一致）
import '@/composables/features/drawer/useSideDrawer'
import { _resetLruForTest } from '@xyz-agent/core'
import { drawerControl, closeDrawer, _resetDrawerControlForTest } from '@xyz-agent/core/domain/drawer'
import type { Message } from '@xyz-agent/shared'

function makeMessage(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

/** 切换 panel 焦点 session（同步 panel 枚举源 + drawer 分区键，模拟 selectSession） */
function focusSession(sid: string): void {
  mockFocusedSessionId.value = sid
  const p = mockPanels.value[0]!
  p.sessionId = sid
}

beforeEach(() => {
  setActivePinia(createPinia())
  _resetLruForTest()
  _resetDrawerControlForTest()
  mockFocusedSessionId.value = null
  mockPanels.value = [{ id: 'panel-root', sessionId: null }]
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('B9 agentcall LRU 联动驱逐（阈值路径 evictIfNeeded）', () => {
  it('主 session 被挤出 LRU 时：未查看的 agentcall 分区释放，正被查看的存活（drawer 不白屏）', () => {
    const chat = useChatStore()
    const wf = useWorkflowStore()
    const viewed = agentCallVirtualId('acs-viewed')
    const unviewed = agentCallVirtualId('acs-unviewed')

    // panel 焦点 s0，drawer 打开 subagent tab 选中 viewed（正在查看）
    focusSession('s0')
    drawerControl.setSubagentView(viewed, 'workflow')
    // 登记 workflow 映射（agentcall 清理唯一通路）+ 写分区消息
    wf.registerAgentCall('s0', unviewed)
    wf.registerAgentCall('s0', viewed)
    chat.setMessages(unviewed, [makeMessage('m-u')])
    chat.setMessages(viewed, [makeMessage('m-v')])

    // hydrate s0 + 8 个填充 session，s0 最旧 → 超阈值挤出
    vi.setSystemTime(1000)
    chat.hydrate('s0', [makeMessage('m0')])
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(2000 + i * 10)
      chat.hydrate(`fill-${i}`, [makeMessage(`mf-${i}`)])
    }

    chat.evictIfNeeded()

    // 主 session 驱逐 + 未查看 agentcall 联动释放（白屏形态：getMessages → []）
    expect(chat.getMessages('s0')).toEqual([])
    expect(chat.getMessages(unviewed)).toEqual([])
    // 正在查看的分区存活（豁免命中）
    expect(chat.getMessages(viewed)).toHaveLength(1)
  })

  it('关闭 drawer 后再驱逐：选中过的分区也释放（A6「关闭 drawer 后再切走，分区释放」）', () => {
    const chat = useChatStore()
    const wf = useWorkflowStore()
    const viewed = agentCallVirtualId('acs-was-viewed')

    focusSession('s0')
    drawerControl.setSubagentView(viewed, 'workflow')
    closeDrawer() // 关闭 drawer：不再查看 → 豁免失效
    wf.registerAgentCall('s0', viewed)
    chat.setMessages(viewed, [makeMessage('m-v')])

    vi.setSystemTime(1000)
    chat.hydrate('s0', [makeMessage('m0')])
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(2000 + i * 10)
      chat.hydrate(`fill-${i}`, [makeMessage(`mf-${i}`)])
    }

    chat.evictIfNeeded()

    expect(chat.getMessages('s0')).toEqual([])
    expect(chat.getMessages(viewed)).toEqual([]) // 无豁免 → 释放
  })

  it('豁免源钉死 panel 枚举：曾开过 drawer、焦点已切走的 session 分区不被全枚举豁免', () => {
    const chat = useChatStore()
    const wf = useWorkflowStore()
    const staleVid = agentCallVirtualId('acs-stale')

    // s-stale 曾开 drawer 选中 staleVid，焦点切走后分区保留（LRU 不清 drawer 控制分区）
    focusSession('s-stale')
    drawerControl.setSubagentView(staleVid, 'workflow')
    wf.registerAgentCall('s-stale', staleVid)
    chat.setMessages(staleVid, [makeMessage('m-s')])
    // 焦点切到 s-now（panel 枚举只剩 s-now → s-stale 的选中不在豁免源内）
    focusSession('s-now')

    // s-stale 最旧被挤出
    vi.setSystemTime(1000)
    chat.hydrate('s-stale', [makeMessage('m0')])
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(2000 + i * 10)
      chat.hydrate(`fill-${i}`, [makeMessage(`mf-${i}`)])
    }

    chat.evictIfNeeded()

    expect(chat.getMessages('s-stale')).toEqual([])
    expect(chat.getMessages(staleVid)).toEqual([]) // 全枚举豁免回归即此处红灯
  })
})

describe('B9 agentcall LRU 联动驱逐（显式路径 evictSessionWithVirtual）', () => {
  it('显式驱逐主 session 同样联动释放未查看的 agentcall 分区（不论阈值）', () => {
    const chat = useChatStore()
    const wf = useWorkflowStore()
    const viewed = agentCallVirtualId('acs-v2')
    const unviewed = agentCallVirtualId('acs-u2')

    focusSession('s1')
    drawerControl.setSubagentView(viewed, 'workflow')
    wf.registerAgentCall('s1', unviewed)
    wf.registerAgentCall('s1', viewed)
    chat.setMessages(unviewed, [makeMessage('m-u')])
    chat.setMessages(viewed, [makeMessage('m-v')])
    chat.hydrate('s1', [makeMessage('m1')])

    chat.evictSessionWithVirtual('s1')

    expect(chat.getMessages('s1')).toEqual([])
    expect(chat.getMessages(unviewed)).toEqual([]) // 显式路径联动释放
    expect(chat.getMessages(viewed)).toHaveLength(1) // 豁免仍生效（正在查看）
  })

  it('未登记映射的主 session 驱逐：回调返回空，行为与旧版一致', () => {
    const chat = useChatStore()
    const orphan = agentCallVirtualId('acs-orphan') // 分区存在但未 registerAgentCall

    chat.setMessages(orphan, [makeMessage('m-o')])
    chat.hydrate('s2', [makeMessage('m2')])

    chat.evictSessionWithVirtual('s2')

    expect(chat.getMessages('s2')).toEqual([])
    expect(chat.getMessages(orphan)).toHaveLength(1) // 无映射不联动（登记制契约）
  })
})

// ── 原 chat-lru.test.ts 并入：M7/D6 虚拟 key 清理契约（renderer 装配增量；纯策略行为
//    ——阈值驱逐/recency/豁免/重 hydrate——由 core lru.test.ts 权威覆盖，此处不再重复）──
describe('M7/D6 虚拟 key 清理契约（真实工厂 key）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    _resetLruForTest()
    _resetDrawerControlForTest()
    mockFocusedSessionId.value = null
    mockPanels.value = [{ id: 'panel-root', sessionId: null }]
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('AC-2/M7: 驱逐主 session 同步清真实 subagentVirtualId 生成的虚拟 key（防手写三段式假绿）', () => {
    const chat = useChatStore()
    const virtualKey = subagentVirtualId('s0', 'sa1')

    chat.hydrate('s0', [makeMessage('m0')])
    chat.setMessages(virtualKey, [makeMessage('sa1')])

    chat.evictSessionWithVirtual('s0')

    expect(chat.getMessages('s0')).toEqual([])
    expect(chat.getMessages(virtualKey)).toEqual([])
  })

  it('D6: agentcall 两段式虚拟 key 不走 LRU 联动清理（由 workflow 映射显式清）', () => {
    const chat = useChatStore()

    chat.hydrate('s0', [makeMessage('m0')])
    chat.setMessages('agentcall:ac1', [makeMessage('ac1')])

    chat.evictSessionWithVirtual('s0')

    expect(chat.getMessages('s0')).toEqual([])
    // agentcall 两段式不含 mainSid，LRU 不联动清理（留给 workflow 映射显式清）
    expect(chat.getMessages('agentcall:ac1')).toHaveLength(1)
  })
})

// ── 原 useSidebar-lru-panel-exempt.test.ts 并入：selectSession 全链路 touchLru 接线 ──
// [session-reconcile 对齐] b97147c7e 后 selectSession 对已 hydrate 的 session 也会
// getHistory + reconcileHistory 静默刷新（entry 历史为基线）。historyBackend 让 getHistory
// mock 与 hydrateSession 注入一致，否则切入刷新会把注入消息替换成空基线，断言失去检验对象。
const historyBackend = new Map<string, Message[]>()

describe('selectSession 全链路 touchLru 接线（AC-2 单 panel LRU 基线不退化）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    _resetLruForTest()
    _resetDrawerControlForTest()
    mockFocusedSessionId.value = null
    mockPanels.value = [{ id: 'panel-root', sessionId: null }]
    vi.clearAllMocks()
    vi.useFakeTimers()
    historyBackend.clear()
    switchSessionMock.mockResolvedValue(undefined)
    getHistoryMock.mockImplementation((sid: string) =>
      Promise.resolve({ messages: historyBackend.get(sid) ?? [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    )
    getCommandsMock.mockResolvedValue({ commands: [] })
    getContextMock.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('单 panel 下 selectSession 切 9 个 session，最旧的被驱逐、最新保留（方案 C 不架空 LRU）', async () => {
    const { useSidebar, resetAppBootstrap } = await import('@/composables/features/sidebar/useSidebar')
    const { useSessionStore } = await import('@/stores/session')
    resetAppBootstrap()
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    // seed session store（selectSession 需要列表内有目标 session）
    const ids = Array.from({ length: 9 }, (_, i) => `s${i}`)
    useSessionStore().applySnapshot({
      groups: [{ cwd: '/proj', sessions: ids.map((id) => ({ id, label: id, cwd: '/proj', status: 'idle' as const, lastActiveAt: 1, modelId: 'm1' })) }],
    })

    // 单 panel：panel 焦点即当前 active session（focusSession 同步 mock panel 枚举）
    for (let i = 0; i < ids.length; i++) {
      vi.setSystemTime(1000 + i * 10)
      const msgs = [makeMessage(`msg-${ids[i]}`)]
      historyBackend.set(ids[i], msgs)
      useChatStore().hydrate(ids[i], msgs)
      await sidebar.selectSession(ids[i])
    }

    // 最旧的 s0 被驱逐（LRU 基线——selectSession 的 touchLru 在 evictIfNeeded 前刷新
    // recency，只保护当前 session，不能把 LRU 架空）
    expect(useChatStore().getMessages('s0')).toHaveLength(0)
    // 最新的 s8 保留
    expect(useChatStore().getMessages('s8')).toHaveLength(1)

    scope.stop()
  })
})
