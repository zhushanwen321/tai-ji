/**
 * stores mock 域合并产物（round 6 renderer 测试压缩）：四文件同产物，环境默认
 * （happy-dom；四原文件均默认环境；fileTree 为 round5 产物）。
 *
 * 并入来源（基名）：
 *  - subagent（subagent store 全行为面 + streaming 订阅生命周期，44 例）
 *  - workflow（workflow store 全行为面 + 拉取收敛，38 例）
 *  - fileTree（round5 产物：fileTree store 结构/git overlay/徽章 + B/M 系 chat 联动，46 例）
 *  - list-load-error（三列表加载错误态，4 例）
 *
 * mock 注册与互斥核查（四源 mock 统一）：
 *  - session domain 深路径：subagent/workflow 各自砍成员工厂 + list-load 八成员工厂 →
 *    统一为成员并集工厂（getSubagents/getSubagentHistory/subagentAction/getWorkflows/
 *    list/create/switchSession/rename/remove/writeSegments），正文引用的四个 mock 经
 *    vi.hoisted 共享（subagent 的 vi.mocked(sessionApi.*) 与 list-load 的断言同一实例）。
 *  - '@/api'：subagent/workflow 的 spread + session 指回工厂 与 fileTree/list-load 的
 *    砍成员工厂 → 统一为 spread actual + session 指回 session domain mock 命名空间 +
 *    project（apiProjectMock）与 chat 域覆写（bash/abortBash/streamSubscribe/getHistory）。
 *    四节链上门面其余域真成员保留（quota/extension 等），原砍成员版未触的域不受影响。
 *  - transport/api：subagent 中部砍成员 {on} 与 list-load 砍成员 {on,dispatchSession,
 *    dispatchGlobal,onGlobalType} → 统一并集工厂。经 grep 核实链上仅 stores/subagent.ts
 *    消费该模块（events.on），四成员覆盖全部消费面。
 *  - useToast（fileTree 节）：砍成员 error spy——subagent/workflow/list-load 节与
 *    store 链经 grep 核实无 useToast 消费（error 成员在场兜底）。
 *  - 各文件级 beforeEach 已下沉进各自 describe（subagent/workflow/list-load 含
 *    clearAllMocks；fileTree 仅 pinia）。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/stores/stores-mock-bundle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { GitFileStatus } from '@taiji/shared'
import { apiProjectMock } from '../helpers/api-facade-mock'
import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'
import { getExecutingBash } from '@taiji/core'
import type { Message, ServerMessage, WorkflowAgentCall } from '@taiji/shared'
import { useQuotaStore } from '@/stores/quota'
import type { NormalizedQuotaRow } from '@taiji/shared'
import type { ServerMessageMap, WorkflowRunRecord, SubagentRecord } from '@taiji/shared'
import { agentCallVirtualId } from '@taiji/shared'

// ── 共享 mock 替身（正文引用面 hoisted）──
const listMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
const getWorkflowsMock = vi.hoisted(
  () =>
    vi.fn(
      (sessionId: string): Promise<ServerMessageMap['session.workflows']> =>
        Promise.resolve({ sessionId, workflows: [] }),
    ),
)
const getSubagentsMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
const getSubagentHistoryMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
// ── fileTree 节的 api 替身（bash/abortBash/streamSubscribe）──
const apiMock = vi.hoisted(() => ({
  bash: vi.fn(() => Promise.resolve()),
  abortBash: vi.fn(() => Promise.resolve()),
  streamSubscribe: vi.fn(() => () => {}),
}))
// ── useToast mock：捕获 error 调用 ──
const toastError = vi.hoisted(() => vi.fn())

// ── session domain 深路径统一工厂（成员并集；subagent/workflow/list-load 三源归一）──
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getSubagents: getSubagentsMock,
  getSubagentHistory: getSubagentHistoryMock,
  subagentAction: vi.fn(),
  getWorkflows: getWorkflowsMock,
  list: listMock,
  create: vi.fn(() => Promise.resolve({})),
  switchSession: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
  writeSegments: vi.fn(() => Promise.resolve()),
}))

// ── '@/api' 统一工厂：spread actual + session 指回 mock 命名空间 + 覆写成员并集 ──
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return {
    ...actual,
    project: apiProjectMock(),
    chat: {
      ...actual.chat,
      bash: apiMock.bash,
      abortBash: apiMock.abortBash,
      streamSubscribe: apiMock.streamSubscribe,
      getHistory: vi.fn(() => Promise.resolve([])),
    },
    session,
  }
})

// ── transport/api 统一工厂（砍成员并集；链上仅 stores/subagent.ts 消费 events.on）──
vi.mock('@taiji/core/transport/api', () => ({
  on: vi.fn(),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
  onGlobalType: vi.fn(() => () => {}),
  // [session-cold-switch-perf §3.3-3] historyCacheReady 订阅经 crossSession 通道
  // （session-api-port.onHistoryCacheReady 消费），mock 须提供
  onCrossSession: vi.fn(() => () => {}),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError }),
}))

import * as sessionApi from '@taiji/core/transport/api/domains/session'
import * as events from '@taiji/core/transport/api'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore, agentCallElapsedMs, deriveWorkflowRunElapsedMs } from '@/stores/workflow'
import { useSessionStore } from '@/stores/session'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'

// ═══════════ 来源节：subagent（中部 transport/api mock 与 events import 已上移产物顶部）═══════════

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'bg-test-1-111',
    sessionFile: '/data/sub.jsonl',
    agent: 'reviewer',
    slug: 'review-code',
    task: 'Review the code',
    status: 'done',
    ...overrides,
  }
}

/** chatStore mock：W4 新签名 —— applySubagentStreamDelta / finalizeSubagentStream / setMessages（fetchAndInject 用） */
function makeChatMock() {
  const messages = new Map<string, Message[]>()
  return {
    applySubagentStreamDelta: vi.fn((sid: string, lines: string[]) => {
      const prev = messages.get(sid) ?? []
      messages.set(sid, [
        ...prev,
        {
          id: `sa-${Math.random()}`,
          role: 'assistant',
          content: lines.join('\n'),
          status: 'streaming',
          contentBlocks: [{ type: 'text', refId: 'text' }],
          timestamp: Date.now(),
        } as Message,
      ])
    }),
    finalizeSubagentStream: vi.fn((sid: string) => {
      const prev = messages.get(sid)
      if (!prev) return
      messages.set(sid, prev.map((m) => (m.status === 'streaming' ? { ...m, status: 'complete' } : m)))
    }),
    setMessages: vi.fn((sid: string, msgs: Message[]) => { messages.set(sid, msgs) }),
    _map: messages,
  }
}

describe('subagent store — state 初值', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('recordsBySession 初值为空 Map', () => {
    const store = useSubagentStore()
    expect(store.getRecordsBySession('session-1')).toEqual([])
  })
})

describe('subagent store — loadSubagents', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('成功时写入该 sid 分区', async () => {
    const records = [makeRecord(), makeRecord({ subagentId: 'bg-2', agent: 'worker' })]
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: records, oversize: false })

    const store = useSubagentStore()
    await store.loadSubagents('session-1')

    expect(store.getRecordsBySession('session-1')).toHaveLength(2)
    expect(store.getRecordsBySession('session-1')[0].agent).toBe('reviewer')
  })

  it('失败时保留分区数据并设 loadError（M1：失败不覆盖）', async () => {
    vi.mocked(sessionApi.getSubagents).mockRejectedValue(new Error('network'))

    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord()]) // 预置旧数据
    await store.loadSubagents('session-1')

    // M1 契约：失败不覆盖现有分区数据，设 loadError 供错误态展示
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)
    expect(store.getRecordsBySession('session-1')[0].subagentId).toBe('bg-test-1-111')
    expect(store.loadErrorOf('session-1')).toBe('network')
    expect(store.isLoadingOf('session-1')).toBe(false)
  })

  it('sessionId 为空时不写分区', async () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord()])
    await store.loadSubagents('')

    // 空 sid 不写分区（已有数据保留，不调 RPC）
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)
    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
  })
})

// ── found 会话存在性判定（待裁决项 4 行为锁）：runtime getSubagents 以 found=false
// 显式标记「会话不在册」（pi 延迟落盘窗口 / 扫描竞态），歧义在协议层根治——
// 「读不到会话」保留分区不覆盖，「真实空列表」（found=true）直接覆盖。
// 原连续空计数 strike 检查随歧义根治整体退役（原 sidebar-sync-plan P1 + R1
// business-logic S3 的补偿，其补偿对象已不存在）。

describe('subagent store — loadSubagents found 会话存在性判定（待裁决项 4 行为锁）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('found=false（会话不在册）→ 保留分区不覆盖，不设 loadError（读不到 ≠ 数据为空）', async () => {
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [], oversize: false, found: false })

    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-keep' })])
    await store.loadSubagents('session-1')

    // 分区保留：延迟落盘窗口的空结果不清掉已有记录
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)
    expect(store.getRecordsBySession('session-1')[0].subagentId).toBe('bg-keep')
    // 「不在册」不是错误态：不设 loadError，oversize 降级标志不置位
    expect(store.loadErrorOf('session-1')).toBeNull()
    expect(store.oversizeOf('session-1')).toBe(false)
    // 窗口结束后会话在册且数据为空（found=true）→ 正常覆盖（此时才是真实删空）
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [], oversize: false, found: true })
    await store.loadSubagents('session-1')
    expect(store.getRecordsBySession('session-1')).toEqual([])
  })

  it('found=true 空列表 → 直接覆盖分区（真实删空语义，无需连续计数）', async () => {
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [], oversize: false, found: true })

    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-gone' })])
    await store.loadSubagents('session-1')

    // 单次空即覆盖：found 已区分「不在册」，空列表歧义不存在
    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(store.loadErrorOf('session-1')).toBeNull()
  })

  it('found 缺省（undefined，mock / 旧 runtime）→ 按 found 处理（空列表直接覆盖，兼容语义不变）', async () => {
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [], oversize: false })

    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-old' })])
    await store.loadSubagents('session-1')

    expect(store.getRecordsBySession('session-1')).toEqual([])
  })

  it('[RT-4#8] oversize=true：置降级标志 + 保留旧分区（不可用 ≠ 删空）', async () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-keep' })])
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [], oversize: true })

    // 连续多次 oversize（面板 retry）：始终保留分区
    await store.loadSubagents('session-1')
    await store.loadSubagents('session-1')
    expect(store.oversizeOf('session-1')).toBe(true)
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)

    // 恢复正常（oversize=false）：标志清除 + 正常覆盖
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [makeRecord({ subagentId: 'bg-new' })], oversize: false })
    await store.loadSubagents('session-1')
    expect(store.oversizeOf('session-1')).toBe(false)
    expect(store.getRecordsBySession('session-1')[0].subagentId).toBe('bg-new')

    // clearSession 释放 oversize 分区
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [], oversize: true })
    await store.loadSubagents('session-1')
    store.clearSession('session-1')
    expect(store.oversizeOf('session-1')).toBe(false)
  })
})

describe('subagent store — clearSubagents', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('清空所有分区', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-a' })])
    store.applyRecords('session-2', [makeRecord({ subagentId: 'bg-b' })])

    store.clearSubagents()

    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(store.getRecordsBySession('session-2')).toEqual([])
  })

  it('RD-3#12: clearSubagents 补齐 loading/error 两 facet（+ oversize），对齐 clearSession 全清', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = useSubagentStore()
      // session-2：oversize 降级标志置位
      store.applyRecords('session-2', [makeRecord({ subagentId: 'bg-b' })])
      vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [], oversize: true })
      await store.loadSubagents('session-2')
      expect(store.oversizeOf('session-2')).toBe(true)
      // session-3：RPC 失败 → loadError 置位
      vi.mocked(sessionApi.getSubagents).mockRejectedValue(new Error('boom'))
      await store.loadSubagents('session-3')
      expect(store.loadErrorOf('session-3')).toBe('boom')
      // session-4：loading 在途残留形态（fail 后 finally 清，此处验证整表替换兜底）
      store.applyRecords('session-4', [makeRecord({ subagentId: 'bg-c' })])

      store.clearSubagents()

      // records + loading/error + oversize 全清
      expect(store.getRecordsBySession('session-2')).toEqual([])
      expect(store.getRecordsBySession('session-4')).toEqual([])
      expect(store.isLoadingOf('session-4')).toBe(false)
      expect(store.loadErrorOf('session-3')).toBeNull()
      expect(store.oversizeOf('session-2')).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('subagent store — clearSession (per-session 分区释放)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('清除指定 sid 分区，不影响其他 sid', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-a' })])
    store.applyRecords('session-2', [makeRecord({ subagentId: 'bg-b' })])

    store.clearSession('session-1')

    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(store.getRecordsBySession('session-2')).toHaveLength(1)
  })

  it('清除不存在的 sid 分区是 no-op', () => {
    const store = useSubagentStore()
    expect(() => store.clearSession('never')).not.toThrow()
  })

  it('loading/error/oversize 三 facet 随分区一并清除（重新加载从干净态起步）', async () => {
    const store = useSubagentStore()
    // oversize 标志置位 + loadError 残留
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-keep' })])
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [], oversize: true })
    await store.loadSubagents('session-1')
    expect(store.oversizeOf('session-1')).toBe(true)

    store.clearSession('session-1')

    // 三 facet 全清（残留 oversize 会让重开后面板误显降级提示）
    expect(store.oversizeOf('session-1')).toBe(false)
    expect(store.loadErrorOf('session-1')).toBeNull()
    expect(store.isLoadingOf('session-1')).toBe(false)

    // 清除后重新加载：正常覆盖路径不受残留状态影响
    vi.mocked(sessionApi.getSubagents).mockResolvedValue({ subagents: [makeRecord({ subagentId: 'bg-new' })], oversize: false })
    await store.loadSubagents('session-1')
    expect(store.getRecordsBySession('session-1')[0].subagentId).toBe('bg-new')
    expect(store.oversizeOf('session-1')).toBe(false)
  })
})

describe('subagent store — isRunning', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('status=running 返回 true', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-1', status: 'running' })])

    expect(store.isRunning('session-1', 'bg-1')).toBe(true)
  })

  it('status=done 返回 false', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-1', status: 'done' })])

    expect(store.isRunning('session-1', 'bg-1')).toBe(false)
  })

  it('未知 subagentId 返回 false', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-1' })])
    expect(store.isRunning('session-1', 'nonexistent')).toBe(false)
  })
})

describe('subagent store — hasRunning', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('分区存在 running → true', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [
      makeRecord({ subagentId: 'bg-1', status: 'done' }),
      makeRecord({ subagentId: 'bg-2', status: 'running' }),
    ])
    expect(store.hasRunning('session-1')).toBe(true)
  })

  it('分区无 running → false', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-1', status: 'done' })])
    expect(store.hasRunning('session-1')).toBe(false)
  })

  it('未知 sid → false', () => {
    const store = useSubagentStore()
    expect(store.hasRunning('never')).toBe(false)
  })
})

describe('subagent store — fetchAndInject（drawer SubagentTab 数据加载入口）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('调 getSubagentHistory + setMessages 注入历史到三段式虚拟 id', async () => {
    const fakeHistory: Message[] = [
      { id: 'm1', role: 'user', content: 'hello', timestamp: 1 },
    ]
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue(fakeHistory)
    const store = useSubagentStore()
    const chat = makeChatMock()

    await store.fetchAndInject('session-1', 'bg-1', chat.setMessages)

    expect(sessionApi.getSubagentHistory).toHaveBeenCalledWith('session-1', 'bg-1')
    expect(chat.setMessages).toHaveBeenCalledWith('subagent:session-1:bg-1', fakeHistory)
  })

  // ── drawer-blank-fix u1-store（T1）：空历史不擦分区 + 返回拉取的 history ──

  it('RPC 返回 [] → 不调 setMessages（保留分区已有内容），fetchAndInject 返回 []', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    const store = useSubagentStore()
    const chat = makeChatMock()

    const history = await store.fetchAndInject('session-1', 'bg-1', chat.setMessages)

    // 空结果不写入：E-4 已映射内容不被擦除（drawer-blank-fix §6.2）
    expect(chat.setMessages).not.toHaveBeenCalled()
    // 返回值契约：调用方（u2 编排层）据此判定分区是否种兜底
    expect(history).toEqual([])
  })

  it('RPC 返回非空 → setMessages 收到该数组且返回值等于该数组', async () => {
    const fakeHistory: Message[] = [
      { id: 'm1', role: 'user', content: 'task', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'done', timestamp: 2 },
    ]
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue(fakeHistory)
    const store = useSubagentStore()
    const chat = makeChatMock()

    const history = await store.fetchAndInject('session-1', 'bg-1', chat.setMessages)

    // 非空照旧整体替换（定稿权威语义）+ 返回拉取的 history
    expect(chat.setMessages).toHaveBeenCalledWith('subagent:session-1:bg-1', fakeHistory)
    expect(history).toBe(fakeHistory)
  })

  it('getSubagentHistory 失败时 fail-fast throw（调用方负责 catch + 显示错误态）', async () => {
    vi.mocked(sessionApi.getSubagentHistory).mockRejectedValue(new Error('network'))
    const store = useSubagentStore()
    const chat = makeChatMock()

    // W2/M5 fail-fast 契约：drawer SubagentTab 负责捕获 + 显示错误态 + 重试入口
    await expect(store.fetchAndInject('session-1', 'bg-1', chat.setMessages)).rejects.toThrow('network')

    // 失败时不应注入历史（避免用户看到空对话流，无重试入口）
    expect(chat.setMessages).not.toHaveBeenCalled()
  })
})

describe('subagent store — cancelSubagent', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('调 subagentAction RPC + 乐观更新分区 status→idle + stopReason=interrupted（U8b 两态化，与宿主 settle 终态同形态）', async () => {
    vi.mocked(sessionApi.subagentAction).mockResolvedValue(undefined)
    const store = useSubagentStore()
    // 预置一条 running subagent
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-cancel-target', status: 'running' })])
    expect(store.getRecordsBySession('session-1')[0].status).toBe('running')

    await store.cancelSubagent('session-1', 'bg-cancel-target')

    // 调了 RPC
    expect(sessionApi.subagentAction).toHaveBeenCalledWith('session-1', 'cancel', { subagentId: 'bg-cancel-target' })
    // 乐观更新：翻 idle + 停因 interrupted（不等 WS 推送；不再写 legacy cancelled 终态）
    const updated = store.getRecordsBySession('session-1').find(r => r.subagentId === 'bg-cancel-target')
    expect(updated?.status).toBe('idle')
    expect(updated?.stopReason).toBe('interrupted')
    expect(updated?.endedAt).toBeTypeOf('number')
  })

  it('RPC 失败 → 回滚乐观更新（status/stopReason 均保持原值）', async () => {
    vi.mocked(sessionApi.subagentAction).mockRejectedValue(new Error('session not active'))
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-fail', status: 'running' })])

    await expect(store.cancelSubagent('session-1', 'bg-fail')).rejects.toThrow('session not active')
    // status 保持 running，无停因写入（回滚）
    const rolled = store.getRecordsBySession('session-1').find(r => r.subagentId === 'bg-fail')
    expect(rolled?.status).toBe('running')
    expect(rolled?.stopReason).toBeUndefined()
  })
})

// ── subscribeStream / stopStream（W4 收尾机制 + U8 drawer scope token + E-4 双订阅适配）──
//
// store 内 import * as events from '@taiji/core/transport/api'，此处 mock events.on 捕获 WS handler。
// E-4：双键订阅（主 sid = 旧 widget 通道帧路由 key；虚拟分区 id = tee 帧路由 key），
// 每次 subscribeStream 消耗 events.on 两次。


describe('subagent store — subscribeStream / stopStream（streaming 订阅生命周期）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  /**
   * 注册并捕获 WS handler：events.on 顺序实现 = 按调用序捕获 handler + 返回 unsub spy。
   * subscribeStream 依次订阅 mainSessionId（第一次 on）与 virtualId（第二次 on）。
   */
  function captureHandlers() {
    const unsubSpies: Array<ReturnType<typeof vi.fn>> = []
    const handlers: Array<(msg: unknown) => void> = []
    vi.mocked(events.on).mockImplementation(
      ((_sid: string, h: (msg: unknown) => void) => {
        handlers.push(h)
        const unsubSpy = vi.fn()
        unsubSpies.push(unsubSpy)
        return unsubSpy
      }) as unknown as typeof events.on,
    )
    return {
      unsubSpies,
      /** tee 帧路由键（virtualId）上的 handler */
      getVirtualKeyHandler: () => handlers[1],
      /** 旧 widget 通道路由键（mainSessionId）上的 handler */
      getMainKeyHandler: () => handlers[0],
    }
  }

  function subscribe(store: ReturnType<typeof useSubagentStore>, chat = makeChatMock()) {
    const cap = captureHandlers()
    store.subscribeStream(
      'drawer:subagent',
      'session-1',
      'bg-1',
      'subagent:session-1:bg-1',
      chat.applySubagentStreamDelta,
      chat.finalizeSubagentStream,
    )
    return { ...cap, chat }
  }

  it('双键订阅：mainSessionId（旧 widget 通道）+ virtualId（tee 帧 payload.sessionId=虚拟分区 id）', () => {
    const store = useSubagentStore()
    const { getMainKeyHandler, getVirtualKeyHandler, chat } = subscribe(store)

    expect(events.on).toHaveBeenNthCalledWith(1, 'session-1', expect.any(Function))
    expect(events.on).toHaveBeenNthCalledWith(2, 'subagent:session-1:bg-1', expect.any(Function))

    // 两个 key 的 handler 同语义：帧类型 / recordId 过滤 + delta 经 chat 回调收尾（W4）。
    // chat mock 是跨迭代累积的同一 vi.fn，按迭代起点快照计数断言增量（绝对 not-called
    // 断言在第二迭代必被第一迭代的合法调用击穿）。
    for (const handler of [getMainKeyHandler(), getVirtualKeyHandler()]) {
      const before = chat.applySubagentStreamDelta.mock.calls.length
      handler({ type: 'session.updated', payload: {} })
      handler({ type: 'subagent.stream_delta', payload: { recordId: 'bg-other', lines: ['x'] } })
      expect(chat.applySubagentStreamDelta).toHaveBeenCalledTimes(before)
      handler({ type: 'subagent.stream_delta', payload: { recordId: 'bg-1', lines: ['line-1'] } })
      expect(chat.applySubagentStreamDelta).toHaveBeenCalledTimes(before + 1)
    }
    expect(chat.applySubagentStreamDelta).toHaveBeenCalledTimes(2)
    expect(chat.applySubagentStreamDelta).toHaveBeenCalledWith('subagent:session-1:bg-1', ['line-1'])
  })

  it('lines === undefined（assistant 定稿清除帧）→ finalize 收尾，不停订阅不 refetch（E-4 / R1 消解）', async () => {
    const store = useSubagentStore()
    const { getVirtualKeyHandler, unsubSpies, chat } = subscribe(store)

    getVirtualKeyHandler()({ type: 'subagent.stream_delta', payload: { recordId: 'bg-1', lines: undefined } })

    // 收尾 streaming 实体（chat store sealed 收尾）
    expect(chat.finalizeSubagentStream).toHaveBeenCalledWith('subagent:session-1:bg-1')
    // 订阅保留（续聊轮后续 delta 仍可达）+ 无 refetch（定稿由 entry 帧派生视图链覆盖）
    for (const unsubSpy of unsubSpies) expect(unsubSpy).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(sessionApi.getSubagentHistory).not.toHaveBeenCalled()
    expect(chat.setMessages).not.toHaveBeenCalled()

    // 后续轮 delta 仍可消费（R1 消解证据）
    getVirtualKeyHandler()({ type: 'subagent.stream_delta', payload: { recordId: 'bg-1', lines: ['next-round'] } })
    expect(chat.applySubagentStreamDelta).toHaveBeenCalledWith('subagent:session-1:bg-1', ['next-round'])
  })

  it('同 scope 重复订阅 → 先 stopStream 清旧（两键 unsub 均被调，drawer 单实例单订阅）', () => {
    const store = useSubagentStore()
    const first = subscribe(store)
    const second = subscribe(store)

    // 第二次 subscribeStream 先 stop 旧 scope 订阅（双键都拆）
    expect(first.unsubSpies[0]).toHaveBeenCalledTimes(1)
    expect(first.unsubSpies[1]).toHaveBeenCalledTimes(1)
    expect(events.on).toHaveBeenCalledTimes(4)
    // 新订阅的 handler 仍工作
    second.getMainKeyHandler()({ type: 'subagent.stream_delta', payload: { recordId: 'bg-1', lines: ['n'] } })
    expect(second.chat.applySubagentStreamDelta).toHaveBeenCalled()
  })

  it('stopStream(scope) → 双键 unsub 均调并移除；重复 stop / 未知 scope / 空 scope → no-op', () => {
    const store = useSubagentStore()
    const { unsubSpies } = subscribe(store)

    store.stopStream('drawer:subagent')
    expect(unsubSpies[0]).toHaveBeenCalledTimes(1)
    expect(unsubSpies[1]).toHaveBeenCalledTimes(1)

    // 重复 stop：unsub 已移除，不再调用
    store.stopStream('drawer:subagent')
    expect(unsubSpies[0]).toHaveBeenCalledTimes(1)

    // 未知 scope / 空 scope 不抛不错调
    expect(() => store.stopStream('never')).not.toThrow()
    expect(() => store.stopStream(undefined)).not.toThrow()
    expect(unsubSpies[0]).toHaveBeenCalledTimes(1)
  })

  it('作用域销毁兜底（onScopeDispose）：store 作用域销毁（$dispose）→ 在途订阅全部 unsub', () => {
    // pinia store 的 onScopeDispose 挂在 store 内部 effect scope 上（createPinia 用
    // detached scope，外层 scope.stop 不级联）——$dispose 直接触发该作用域销毁路径
    setActivePinia(createPinia())
    const store = useSubagentStore()
    const { unsubSpies } = subscribe(store)

    store.$dispose()
    expect(unsubSpies[0]).toHaveBeenCalledTimes(1)
    expect(unsubSpies[1]).toHaveBeenCalledTimes(1)
  })
})

// ── hasRunning / isStreamingSubagent 窄口径判据（running-resumable 排除，residual-fixes）──

describe('subagent store — hasRunning / isStreamingSubagent 窄口径（轮终 running 不算真在跑）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('[U6] 轮终形态（idle + result + completed）→ hasRunning false，isRunning false（两口径合流）', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [
      // [U6] renderer 实收轮终形态（U4 翻边 + runtime 归一后）
      makeRecord({ subagentId: 'bg-1', status: 'idle', result: '本轮产出', stopReason: 'completed' }),
    ])
    // hasRunning 窄口径：不算后台真在跑（derivedStatus 不卡 working）
    expect(store.hasRunning('session-1')).toBe(false)
    // isRunning 宽口径（running 字面）：U4 翻边后轮终 = idle——两口径天然合流（设计 §2.3）
    expect(store.isRunning('session-1', 'bg-1')).toBe(false)
  })

  it('[U6] W4 新型（running + stopReason=failed 无 result）→ hasRunning false / isStreamingSubagent false（stopReason 子句对冲生效；isRunning 宽口径仍 true——订阅语义保留）', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [
      makeRecord({ subagentId: 'bg-2', status: 'running', stopReason: 'failed' }),
    ])
    expect(store.hasRunning('session-1')).toBe(false)
    expect(store.isStreamingSubagent('session-1', 'bg-2')).toBe(false)
    // 宽口径（running 字面）不计 stopReason——SubagentTab 订阅语义保留（带停因 running 仍可
    // 被接管链活动；原「死亡纳管态」措辞随 adoptEngineDeath 写点退役，登记见 record-store.ts:179）
    expect(store.isRunning('session-1', 'bg-2')).toBe(true)
  })

  it('running 无 result → hasRunning true / isStreamingSubagent true（真在跑）', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-3', status: 'running' })])
    expect(store.hasRunning('session-1')).toBe(true)
    expect(store.isStreamingSubagent('session-1', 'bg-3')).toBe(true)
  })

  it('isStreamingSubagent：终态 record / 未知 subagentId → false', () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-4', status: 'done' })])
    expect(store.isStreamingSubagent('session-1', 'bg-4')).toBe(false)
    expect(store.isStreamingSubagent('session-1', 'nonexistent')).toBe(false)
  })
})

describe('subagent store — split 双 session 加载态隔离（P2-3 回归锁）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('pane A 失败置 loadError 不影响 pane B 的错误/加载态（per-session 分区）', async () => {
    vi.mocked(sessionApi.getSubagents)
      .mockRejectedValueOnce(new Error('pane-a rpc down')) // sid-a 失败
      .mockResolvedValueOnce({ subagents: [makeRecord()], oversize: false }) // sid-b 成功

    const store = useSubagentStore()
    await store.loadSubagents('sid-a')
    await store.loadSubagents('sid-b')

    // 各自分区互不串扰：旧全局单值形态下 sid-b 面板也会显示 pane A 的错误
    expect(store.loadErrorOf('sid-a')).toBe('pane-a rpc down')
    expect(store.loadErrorOf('sid-b')).toBeNull()
    expect(store.isLoadingOf('sid-a')).toBe(false)
    expect(store.isLoadingOf('sid-b')).toBe(false)
    expect(store.getRecordsBySession('sid-b')).toHaveLength(1)
  })

  it('load 在途时另一 session 的读取不受影响（isIdle 分区读取）', async () => {
    let releaseB: (() => void) | undefined
    vi.mocked(sessionApi.getSubagents)
      .mockResolvedValueOnce({ subagents: [makeRecord()], oversize: false })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseB = () => resolve({ subagents: [makeRecord()], oversize: false }) }))

    const store = useSubagentStore()
    const pA = store.loadSubagents('sid-a') // 立即完成
    const pB = store.loadSubagents('sid-b') // 挂起（模拟长轮询）
    await pA
    await Promise.resolve()

    expect(store.isLoadingOf('sid-a')).toBe(false)
    expect(store.isLoadingOf('sid-b')).toBe(true)
    releaseB?.()
    await pB
    expect(store.isLoadingOf('sid-b')).toBe(false)
  })
})


describe('subagent store — drawer 二级 tab 状态族（subagent-detail-tabs）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('drawerTabsOf 惰性建分区：首次访问返回空分区，二次访问同一对象', () => {
    const store = useSubagentStore()

    // 首次访问惰性建空分区（Vue reactive Map 语义：首访返回 raw 对象，二次起返回同一响应式 proxy）
    const first = store.drawerTabsOf('sid-a')
    expect(first.tabs).toEqual([])
    expect(first.active).toBeNull()

    const second = store.drawerTabsOf('sid-a')
    const third = store.drawerTabsOf('sid-a')
    expect(third).toBe(second)
    expect(second.tabs).toEqual([])
  })

  it('openDrawerTab 新开 tab 并激活；重复打开幂等（不重复 push，仅切激活）', () => {
    const store = useSubagentStore()

    store.openDrawerTab('sid-a', 'vid-1')
    store.openDrawerTab('sid-a', 'vid-2')
    let entry = store.drawerTabsOf('sid-a')
    expect(entry.tabs).toEqual(['vid-1', 'vid-2'])
    expect(entry.active).toBe('vid-2')

    // 已打开 vid-1 后先切到 vid-2，再「打开」vid-1：不重复 push，仅激活切回
    store.activateDrawerTab('sid-a', 'vid-2')
    store.openDrawerTab('sid-a', 'vid-1')
    entry = store.drawerTabsOf('sid-a')
    expect(entry.tabs).toEqual(['vid-1', 'vid-2'])
    expect(entry.active).toBe('vid-1')
  })

  it('activateDrawerTab 已打开者切换生效；未打开者 tabs 不变', () => {
    const store = useSubagentStore()
    store.openDrawerTab('sid-a', 'vid-1')

    store.activateDrawerTab('sid-a', 'vid-1')
    expect(store.drawerTabsOf('sid-a').active).toBe('vid-1')

    store.activateDrawerTab('sid-a', 'vid-never-opened')
    const entry = store.drawerTabsOf('sid-a')
    expect(entry.tabs).toEqual(['vid-1'])
    expect(entry.active).toBe('vid-1')
  })

  it('关闭激活 tab：右邻优先激活；无右邻激活左邻', () => {
    const store = useSubagentStore()
    store.openDrawerTab('sid-a', 'vid-1')
    store.openDrawerTab('sid-a', 'vid-2')
    store.openDrawerTab('sid-a', 'vid-3')
    store.activateDrawerTab('sid-a', 'vid-1')

    // 关最左激活者 → 右邻 vid-2 激活
    expect(store.closeDrawerTab('sid-a', 'vid-1')).toBe('vid-2')
    expect(store.drawerTabsOf('sid-a').tabs).toEqual(['vid-2', 'vid-3'])

    // 关最右激活者（无右邻）→ 左邻 vid-2 激活
    store.activateDrawerTab('sid-a', 'vid-3')
    expect(store.closeDrawerTab('sid-a', 'vid-3')).toBe('vid-2')
    expect(store.drawerTabsOf('sid-a').tabs).toEqual(['vid-2'])
  })

  it('关闭非激活 tab 激活者不变；关闭不存在的 tab 返回当前激活者', () => {
    const store = useSubagentStore()
    store.openDrawerTab('sid-a', 'vid-1')
    store.openDrawerTab('sid-a', 'vid-2')
    store.openDrawerTab('sid-a', 'vid-3')
    store.activateDrawerTab('sid-a', 'vid-1')

    // vid-2 非激活，关闭后激活者仍是 vid-1
    expect(store.closeDrawerTab('sid-a', 'vid-2')).toBe('vid-1')
    expect(store.drawerTabsOf('sid-a').tabs).toEqual(['vid-1', 'vid-3'])
    expect(store.drawerTabsOf('sid-a').active).toBe('vid-1')

    // 不存在的 vid：tabs 与激活者均不变
    expect(store.closeDrawerTab('sid-a', 'vid-ghost')).toBe('vid-1')
    expect(store.drawerTabsOf('sid-a').tabs).toEqual(['vid-1', 'vid-3'])
  })

  it('关到最后一个 tab：返回 null（调用方据此回空态）', () => {
    const store = useSubagentStore()
    store.openDrawerTab('sid-a', 'vid-1')

    expect(store.closeDrawerTab('sid-a', 'vid-1')).toBeNull()
    expect(store.drawerTabsOf('sid-a')).toEqual({ tabs: [], active: null })
  })

  it('clearSession 释放 tab 分区：再访问是全新空分区', () => {
    const store = useSubagentStore()
    store.openDrawerTab('sid-a', 'vid-1')
    const before = store.drawerTabsOf('sid-a')

    store.clearSession('sid-a')

    const after = store.drawerTabsOf('sid-a')
    expect(after).not.toBe(before)
    expect(after).toEqual({ tabs: [], active: null })
  })

  it('多 session 分区隔离：A 的 tabs 操作不影响 B', () => {
    const store = useSubagentStore()
    store.openDrawerTab('sid-a', 'vid-a1')
    store.openDrawerTab('sid-b', 'vid-b1')

    expect(store.drawerTabsOf('sid-a').tabs).toEqual(['vid-a1'])
    expect(store.drawerTabsOf('sid-b').tabs).toEqual(['vid-b1'])
    expect(store.drawerTabsOf('sid-a').active).toBe('vid-a1')
    expect(store.drawerTabsOf('sid-b').active).toBe('vid-b1')

    store.closeDrawerTab('sid-a', 'vid-a1')
    expect(store.drawerTabsOf('sid-b').tabs).toEqual(['vid-b1'])
    expect(store.drawerTabsOf('sid-b').active).toBe('vid-b1')
  })
})

// ═══════════ 来源节：workflow（makeRecord 重命名为 makeRecordWf 避免与 subagent 节重名）═══════════

function makeRecordWf(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-test-001',
    scriptName: 'test-flow',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-10T10:00:00Z',
    completedAt: '2026-07-10T10:30:00Z',
    usedTokens: 50000,
    totalCallCount: 2,
    agentCalls: [
      { id: 0, agent: 'dev-W1', status: 'completed', phase: 'Dev', sessionId: 'sess-001' },
      { id: 1, agent: 'dev-W2', status: 'completed', phase: 'Dev', sessionId: 'sess-002' },
    ],
    stateFilePath: '/data/wf-test-001.jsonl',
    ...overrides,
  }
}

/**
 * 测试种数据：applyRecords 已从 store 导出清单摘除（生产零直写场景），测试经分区 ref
 * 直写——不可变替换整 Map（与 partition.apply 等价）触发 shallowRef 响应性。
 */
function seedRecords(
  store: ReturnType<typeof useWorkflowStore>,
  sid: string,
  records: WorkflowRunRecord[],
): void {
  store.recordsBySession = new Map(store.recordsBySession).set(sid, records)
}

describe('workflow store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始状态：records 分区空', () => {
    const store = useWorkflowStore()
    expect(store.getRecordsBySession('sess-1')).toEqual([])
  })

  it('loadWorkflows 成功写入该 sid 分区', async () => {
    const records = [makeRecordWf(), makeRecordWf({ runId: 'wf-test-002' })]
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: records, oversize: false })

    const store = useWorkflowStore()
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toHaveLength(2)
  })

  it('loadWorkflows 失败时不覆盖现有分区', async () => {
    vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('rpc error'))

    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecordWf()])
    await store.loadWorkflows('sess-1')

    // M1 契约：失败不覆盖现有分区数据，设 loadError
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.loadErrorOf('sess-1')).toBe('rpc error')
  })

  it('clearWorkflows 清空所有分区 + 清 agentcall 映射', () => {
    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecordWf()])
    // 登记 agentcall 映射（U7 MUST_FIX 1）
    store.registerAgentCall('sess-1', agentCallVirtualId('ac-1'))
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.getAgentCallVirtualIdsByMain('sess-1')).toContain(agentCallVirtualId('ac-1'))

    store.clearWorkflows()

    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(store.getAgentCallVirtualIdsByMain('sess-1')).toEqual([])
  })

  it('RD-3#12: clearWorkflows 补齐 loading/error 两 facet（+ oversize），对齐 clearSession 全清', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = useWorkflowStore()
      seedRecords(store, 'sess-2', [makeRecordWf({ runId: 'wf-b' })])
      vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: true })
      await store.loadWorkflows('sess-2')
      expect(store.oversizeOf('sess-2')).toBe(true)

      vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('boom'))
      await store.loadWorkflows('sess-3')
      expect(store.loadErrorOf('sess-3')).toBe('boom')

      store.clearWorkflows()

      // records + loading/error + oversize 全清
      expect(store.getRecordsBySession('sess-2')).toEqual([])
      expect(store.isLoadingOf('sess-2')).toBe(false)
      expect(store.loadErrorOf('sess-3')).toBeNull()
      expect(store.oversizeOf('sess-2')).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ── found 会话存在性判定（待裁决项 4 行为锁，与 subagent store 同款）：runtime
// getWorkflows 以 found=false 显式标记「会话不在册」，「读不到会话」保留分区不覆盖，
// 「真实空列表」（found=true）直接覆盖。原连续空计数 strike 检查随歧义根治整体退役。

describe('workflow store — loadWorkflows found 会话存在性判定（待裁决项 4 行为锁）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('found=false（会话不在册）→ 保留分区不覆盖，不设 loadError（读不到 ≠ 数据为空）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false, found: false })

    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecordWf({ runId: 'wf-keep' })])
    await store.loadWorkflows('sess-1')

    // 分区保留：延迟落盘窗口的空结果不清掉已有记录
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.getRecordsBySession('sess-1')[0].runId).toBe('wf-keep')
    // 「不在册」不是错误态：不设 loadError，oversize 降级标志不置位
    expect(store.loadErrorOf('sess-1')).toBeNull()
    expect(store.oversizeOf('sess-1')).toBe(false)
    // 窗口结束后会话在册且数据为空（found=true）→ 正常覆盖（此时才是真实删空）
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false, found: true })
    await store.loadWorkflows('sess-1')
    expect(store.getRecordsBySession('sess-1')).toEqual([])
  })

  it('found=true 空列表 → 直接覆盖分区（真实删空语义，无需连续计数）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false, found: true })

    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecordWf({ runId: 'wf-gone' })])
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(store.loadErrorOf('sess-1')).toBeNull()
  })

  it('found 缺省（undefined，mock / 旧 runtime）→ 按 found 处理（空列表直接覆盖，兼容语义不变）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false })

    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecordWf({ runId: 'wf-old' })])
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toEqual([])
  })

  it('[RT-4#8] oversize=true：置降级标志 + 保留旧分区（不可用 ≠ 删空）', async () => {
    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecordWf({ runId: 'wf-keep' })])
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: true })

    await store.loadWorkflows('sess-1')
    await store.loadWorkflows('sess-1')
    expect(store.oversizeOf('sess-1')).toBe(true)
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)

    // 恢复正常：标志清除 + 正常覆盖
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecordWf({ runId: 'wf-new' })], oversize: false })
    await store.loadWorkflows('sess-1')
    expect(store.oversizeOf('sess-1')).toBe(false)
    expect(store.getRecordsBySession('sess-1')[0].runId).toBe('wf-new')

    // clearSession 释放 oversize 分区
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: true })
    await store.loadWorkflows('sess-1')
    store.clearSession('sess-1')
    expect(store.oversizeOf('sess-1')).toBe(false)
  })
})

// ── U7 MUST_FIX 1: agentcall 清理映射（deleteSession 清 agentcall 虚拟 key 唯一通路）──

describe('U7 MUST_FIX 1: agentcall 虚拟 key 清理映射', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('registerAgentCall 登记 virtualId，getAgentCallVirtualIdsByMain 反查', () => {
    const store = useWorkflowStore()
    const vid = agentCallVirtualId('ac-sess-1')

    store.registerAgentCall('main-1', vid)

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([vid])
  })

  it('同一 mainSession 多个 agentcall virtualId 都登记', () => {
    const store = useWorkflowStore()
    const vid1 = agentCallVirtualId('ac-1')
    const vid2 = agentCallVirtualId('ac-2')

    store.registerAgentCall('main-1', vid1)
    store.registerAgentCall('main-1', vid2)

    expect(store.getAgentCallVirtualIdsByMain('main-1').sort()).toEqual([vid1, vid2].sort())
  })

  it('不同 mainSession 独立分区，互不干扰', () => {
    const store = useWorkflowStore()
    store.registerAgentCall('main-1', agentCallVirtualId('ac-1'))
    store.registerAgentCall('main-2', agentCallVirtualId('ac-2'))

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([agentCallVirtualId('ac-1')])
    expect(store.getAgentCallVirtualIdsByMain('main-2')).toEqual([agentCallVirtualId('ac-2')])
  })

  it('clearAgentCallMapping 清指定 mainSession 的映射（deleteSession 路径）', () => {
    const store = useWorkflowStore()
    store.registerAgentCall('main-1', agentCallVirtualId('ac-1'))
    store.registerAgentCall('main-2', agentCallVirtualId('ac-2'))

    store.clearAgentCallMapping('main-1')

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([])
    // main-2 不受影响
    expect(store.getAgentCallVirtualIdsByMain('main-2')).toHaveLength(1)
  })

  it('registerAgentCall 幂等：同 virtualId 重复登记不重复', () => {
    const store = useWorkflowStore()
    const vid = agentCallVirtualId('ac-1')

    store.registerAgentCall('main-1', vid)
    store.registerAgentCall('main-1', vid)

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([vid])
  })

  it('未登记的 mainSession 反查返回空数组（deleteSession 安全 no-op）', () => {
    const store = useWorkflowStore()
    expect(store.getAgentCallVirtualIdsByMain('never')).toEqual([])
    // 清不存在的映射不抛错
    expect(() => store.clearAgentCallMapping('never')).not.toThrow()
  })
})

// ── clearSession per-session 分区释放 + W15 定时器防御性清理（fake timers）──

describe('workflow store — clearSession（per-session 分区释放，ADR-0049 AC-8）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('清除指定 sid 分区，不影响其他 sid', () => {
    const store = useWorkflowStore()
    seedRecords(store, 'session-1', [makeRecordWf({ runId: 'wf-a' })])
    seedRecords(store, 'session-2', [makeRecordWf({ runId: 'wf-b' })])

    store.clearSession('session-1')

    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(store.getRecordsBySession('session-2')).toHaveLength(1)
  })

  it('清除不存在的 sid 分区是 no-op（不抛错）', () => {
    const store = useWorkflowStore()
    expect(() => store.clearSession('never')).not.toThrow()
  })

  it('loading/error/oversize 三 facet 随分区一并清除（重新加载从干净态起步）', async () => {
    const store = useWorkflowStore()
    // oversize 标志置位
    seedRecords(store, 'session-1', [makeRecordWf({ runId: 'wf-keep' })])
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: true })
    await store.loadWorkflows('session-1')
    expect(store.oversizeOf('session-1')).toBe(true)

    store.clearSession('session-1')

    // 三 facet 全清（残留 oversize 会让重开后面板误显降级提示）
    expect(store.oversizeOf('session-1')).toBe(false)
    expect(store.loadErrorOf('session-1')).toBeNull()
    expect(store.isLoadingOf('session-1')).toBe(false)

    // 清除后重新加载：正常覆盖路径不受残留状态影响
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecordWf({ runId: 'wf-new' })], oversize: false })
    await store.loadWorkflows('session-1')
    expect(store.getRecordsBySession('session-1')[0].runId).toBe('wf-new')
    expect(store.oversizeOf('session-1')).toBe(false)
  })
})

describe('workflow store — triggerWorkflowReload（信号驱动重新拉取）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('running 信号：只立即拉一次，无延迟重试（[ADR-0112] 500ms flush 兜底重试已删）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecordWf()], oversize: false })
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    // 原延迟重试窗口内无第二次拉取
    await vi.advanceTimersByTimeAsync(600)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
    expect(sessionApi.getWorkflows).toHaveBeenCalledWith('session-1')
  })

  it('running 信号后列表为空：显式 warn（workflow-state-link 可能未落盘，缺失出声不补偿）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false })
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('workflow 列表为空'),
      'session-1',
    )
    warnSpy.mockRestore()
  })

  it('running 信号后有数据：不 warn（正常路径零噪音）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecordWf()], oversize: false })
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('非 running 信号：只立即拉一次', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecordWf()], oversize: false })
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'done')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })

  it('同 sid 连续 running 信号：共享在途拉取 + dirty 补充拉取一次（2 次 RPC，无延迟重试）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecordWf()], oversize: false })
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    // 第 2 次信号共享第 1 次在途拉取（置 dirty）；在途完成后 drain 补充拉取一次 → 共 2 次 RPC
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
  })
})

// ── [W0/D4] 拉取收敛：per-session in-flight 合并 + 可再武装 dirty 补充拉取 ──
// 设计锚点 workflow-step-visibility-data-source D4：renderer 信号一次性不可重放，
// 只合并不补充拉取会丢更新（起步竞态 / 终态吞没两个真实交织）；封顶版 dirty（只补一次）
// 会在补充拉取在途窗口复刻终态吞没，dirty 必须可再武装。RPC 用手动放行的 deferred 队列
// 精确控制在途窗口；队列空时同步抛错——幻影补充拉取经 loadError 可观测（非挂起等超时）。

describe('workflow store — [W0/D4] 拉取收敛（in-flight 合并 + dirty 补充拉取）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  interface WorkflowsResult {  // oe-exempt:20261027:test:
    workflows: WorkflowRunRecord[]
    oversize: boolean
  }
  interface DeferredRpc {  // oe-exempt:20261027:test:
    promise: Promise<WorkflowsResult>
    resolve: (v: WorkflowsResult) => void
    reject: (e: unknown) => void
  }

  const rpcQueue: DeferredRpc[] = []

  /** 入队一次受控 RPC（手动 resolve/reject 控制放行时序）；出队按调用序（FIFO） */
  function enqueueRpc(): DeferredRpc {
    let resolve!: (v: WorkflowsResult) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<WorkflowsResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    const deferred: DeferredRpc = { promise, resolve, reject }
    rpcQueue.push(deferred)
    return deferred
  }

  /** 排空微任务链（resolve 后 drain/补充拉取 RPC 都在微任务里，断言调用计数前先排空） */

  beforeEach(() => {
    rpcQueue.length = 0
    vi.mocked(sessionApi.getWorkflows).mockImplementation(() => {
      const next = rpcQueue.shift()
      if (!next) throw new Error('unexpected extra getWorkflows RPC (rpcQueue empty)')
      return next.promise
    })
  })

  /** 排空微任务链（resolve 后 drain/补充拉取 RPC 都在微任务里，断言调用计数前先排空） */
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0))
  }

  it('并发失效共享一次拉取：在途期间的新调用不另起 RPC、返回同一 promise；合并的 dirty 收敛为一次补充拉取', async () => {
    const d1 = enqueueRpc()
    const d2 = enqueueRpc()
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
    // 在途窗口内两次新调用（并发失效）：共享在途拉取，不另起 RPC（pinia 对 async action
    // 的返回值包一层 then，promise 对象身份断言不可用——以「不另起 RPC + 双方都收敛到
    // 补充拉取后终态」为可观测契约）
    const second = store.loadWorkflows('s1')
    const third = store.loadWorkflows('s1')
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
    expect(store.isLoadingOf('s1')).toBe(true)

    // 在途完成 → 两次合并信号收敛为一次补充拉取（3 信号 ≤ 2 次 RPC；无收敛则 3 次）
    d1.resolve({ workflows: [], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    d2.resolve({ workflows: [makeRecordWf()], oversize: false })
    await Promise.all([first, second, third])
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    expect(store.getRecordsBySession('s1')).toHaveLength(1)
  })

  it('起步竞态：run-created 拉取在途期间 record 落盘 → 空结果不滞留（补充拉取拾起新落盘数据）', async () => {
    const d1 = enqueueRpc()
    const d2 = enqueueRpc()
    const store = useWorkflowStore()
    // 第一次拉取（run-created 信号）在途——此刻返回空（record 尚未落盘）
    const created = store.loadWorkflows('s1')
    // record 落盘 → 新信号在途窗口内到达（合并置 dirty）
    const settled = store.loadWorkflows('s1')
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // stale 空结果完成 → dirty 补充拉取拾起已落盘的 record（无补充拉取则「run 在、0 步骤」空壳滞留）
    d1.resolve({ workflows: [], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    d2.resolve({ workflows: [makeRecordWf({ runId: 'wf-blind' })], oversize: false })
    await Promise.all([created, settled])
    expect(store.getRecordsBySession('s1')[0]?.runId).toBe('wf-blind')
  })

  it('终态吞没：最后终态信号合并进 stale 在途拉取 → 补充拉取送达终态（步骤不永久 running）', async () => {
    const staleRecord = makeRecordWf({
      runId: 'wf-term',
      status: 'running',
      agentCalls: [{ id: 0, agent: 'reviewer-1', status: 'running', phase: 'Review', sessionId: 'acs-1' }],
    })
    const d1 = enqueueRpc()
    const d2 = enqueueRpc()
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    // 最后一条终态信号在 stale 拉取在途窗口到达（合并进 stale 拉取——无 dirty 补充拉取则永久丢失）
    const terminal = store.loadWorkflows('s1')

    d1.resolve({ workflows: [staleRecord], oversize: false })
    d2.resolve({
      workflows: [
        makeRecordWf({
          runId: 'wf-term',
          status: 'done',
          reason: 'completed',
          agentCalls: [{ id: 0, agent: 'reviewer-1', status: 'completed', phase: 'Review', sessionId: 'acs-1' }],
        }),
      ],
      oversize: false,
    })
    await Promise.all([first, terminal])
    const final = store.getRecordsBySession('s1')[0]
    expect(final?.status).toBe('done')
    expect(final?.agentCalls[0]?.status).toBe('completed')
  })

  it('补充拉取在途窗口到达终态信号：dirty 可再武装（补充拉取的补充拉取），最终状态正确', async () => {
    const d1 = enqueueRpc()
    const d2 = enqueueRpc()
    const d3 = enqueueRpc()
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    // 信号 A：stale 在途窗口内到达 → dirty
    store.loadWorkflows('s1')
    d1.resolve({ workflows: [makeRecordWf({ runId: 'wf-r' })], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2) // 补充拉取 B 已起（在途）

    // 信号 C：补充拉取 B 在途窗口内到达 → 再置 dirty（可再武装语义的验证点；封顶版此处丢信号）
    store.loadWorkflows('s1')
    d2.resolve({ workflows: [makeRecordWf({ runId: 'wf-r', status: 'running' })], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3) // B 完成后 drain 判 dirty → 补充拉取 C
    d3.resolve({ workflows: [makeRecordWf({ runId: 'wf-r', status: 'done', reason: 'completed' })], oversize: false })
    await first
    expect(store.getRecordsBySession('s1')[0]?.status).toBe('done')
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3)
  })

  it('失败分支同样 drain：在途拉取失败不阻断 dirty 补充拉取（后续信号驱动的补充拉取照常送达）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const d1 = enqueueRpc()
      const d2 = enqueueRpc()
      const store = useWorkflowStore()
      const first = store.loadWorkflows('s1')
      const retry = store.loadWorkflows('s1') // 在途窗口内新信号 → dirty

      d1.reject(new Error('rpc down'))
      await flushMicrotasks()
      expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2) // 失败后 dirty 补充拉取照常起
      d2.resolve({ workflows: [makeRecordWf({ runId: 'wf-after-fail' })], oversize: false })
      await Promise.all([first, retry])
      expect(store.getRecordsBySession('s1')[0]?.runId).toBe('wf-after-fail')
      expect(store.loadErrorOf('s1')).toBeNull() // 补充拉取成功清错误
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ── [W0/D4] 三点簿记清理（clearWorkflows / clearSession / $dispose）无幻影补充拉取 ──

describe('workflow store — [W0/D4] 拉取收敛簿记三点清理（已删 session 的 dirty 不复活）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  interface WorkflowsResult {  // oe-exempt:20261027:test:
    workflows: WorkflowRunRecord[]
    oversize: boolean
  }
  interface DeferredRpc {  // oe-exempt:20261027:test:
    promise: Promise<WorkflowsResult>
    resolve: (v: WorkflowsResult) => void
  }

  /** 按 sid 路由的 RPC 队列（多 sid 并发用例的出队按会话键匹配，不受调用序干扰） */
  const rpcQueues = new Map<string, DeferredRpc[]>()

  function enqueueRpc(sid: string): DeferredRpc {
    let resolve!: (v: WorkflowsResult) => void
    const promise = new Promise<WorkflowsResult>((res) => {
      resolve = res
    })
    const deferred: DeferredRpc = { promise, resolve }
    const queue = rpcQueues.get(sid) ?? []
    queue.push(deferred)
    rpcQueues.set(sid, queue)
    return deferred
  }

  beforeEach(() => {
    rpcQueues.clear()
    vi.mocked(sessionApi.getWorkflows).mockImplementation((sid: string) => {
      const next = rpcQueues.get(sid)?.shift()
      if (!next) throw new Error(`unexpected extra getWorkflows RPC for ${sid} (rpcQueue empty)`)
      return next.promise
    })
  })

  /** 排空微任务链（同前述 describe：断言调用计数前先排空 resolve 后的微任务） */
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0))
  }

  it('clearSession：在途 + dirty 随分区释放，完成后无补充拉取（已删 session 的 dirty 不复活）', async () => {
    const d1 = enqueueRpc('s1')
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    store.loadWorkflows('s1') // 在途窗口内信号 → dirty 置位
    store.clearSession('s1')

    d1.resolve({ workflows: [makeRecordWf()], oversize: false })
    await first
    // 无补充拉取：RPC 恒 1 次；幻影补充拉取会打到空队列（同步抛错 → loadError 分区可观测）
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
    expect(store.loadErrorOf('s1')).toBeNull()
    expect(store.isLoadingOf('s1')).toBe(false)
  })

  it('clearWorkflows：全表簿记清理，在途完成无补充拉取', async () => {
    const d1 = enqueueRpc('s1')
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    store.loadWorkflows('s1')
    store.clearWorkflows()

    d1.resolve({ workflows: [makeRecordWf()], oversize: false })
    await first
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
    expect(store.loadErrorOf('s1')).toBeNull()
  })

  it('onScopeDispose（$dispose）：簿记清理，在途完成无补充拉取（HMR / store dispose）', async () => {
    const d1 = enqueueRpc('s1')
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    store.loadWorkflows('s1')
    store.$dispose()

    d1.resolve({ workflows: [makeRecordWf()], oversize: false })
    await first
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })

  it('per-session 键粒度：两 sid 并发拉取互不吞——各自在途、dirty 不跨 session 触发补充拉取', async () => {
    const dA1 = enqueueRpc('sa')
    const dA2 = enqueueRpc('sa')
    const dB1 = enqueueRpc('sb')
    const store = useWorkflowStore()
    const loadA = store.loadWorkflows('sa')
    const loadB = store.loadWorkflows('sb')
    // 全局单例键会在此合并成一次 RPC（sb 吞进 sa 的在途）——per-session 键各自在途
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    expect(sessionApi.getWorkflows).toHaveBeenNthCalledWith(1, 'sa')
    expect(sessionApi.getWorkflows).toHaveBeenNthCalledWith(2, 'sb')

    // sa 在途窗口内信号 → 仅 sa 置 dirty
    store.loadWorkflows('sa')
    // sa 完成 → 仅 sa 补充拉取（第 3 次 RPC）；sb 无 dirty → resolve 后无补充拉取
    dA1.resolve({ workflows: [makeRecordWf({ runId: 'wf-a1' })], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3)
    dA2.resolve({ workflows: [makeRecordWf({ runId: 'wf-a2' })], oversize: false })
    dB1.resolve({ workflows: [makeRecordWf({ runId: 'wf-b1' })], oversize: false })
    await Promise.all([loadA, loadB])
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3)
    expect(store.getRecordsBySession('sa')[0]?.runId).toBe('wf-a2')
    expect(store.getRecordsBySession('sb')[0]?.runId).toBe('wf-b1')
  })
})

// ── [P3/D6] progress 派生视图消费纯函数（drawer/tray 共用推导单点）──


const NOW = 1_000_000_000_000

describe('workflow store — [P3/D6] agentCallElapsedMs（每 ask 已执行时长槽）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  const startedIso = new Date(NOW - 30_000).toISOString()

  function callWith(overrides: Partial<WorkflowAgentCall>): WorkflowAgentCall {
    return { id: 0, agent: 'dev', status: 'running', startedAt: startedIso, ...overrides }
  }

  it('running + 可解析 startedAt → now - startedAt；负差钳 0', () => {
    expect(agentCallElapsedMs(callWith({}), NOW)).toBe(30_000)
    expect(agentCallElapsedMs(callWith({ startedAt: new Date(NOW + 5000).toISOString() }), NOW)).toBe(0)
  })

  it('非 running / 缺 startedAt / 坏时间串 → null（槽省略——旧快照缺省渲染路径）', () => {
    expect(agentCallElapsedMs(callWith({ status: 'done' }), NOW)).toBeNull()
    expect(agentCallElapsedMs(callWith({ startedAt: undefined }), NOW)).toBeNull()
    expect(agentCallElapsedMs(callWith({ startedAt: 'garbage' }), NOW)).toBeNull()
  })
})

// ── [可视化 D9] run 已用时长停走派生（overlay 壳 header 与实况面板 header 共用单点）──


describe('workflow store — [可视化 D9] deriveWorkflowRunElapsedMs（run 已用时长停走锚）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  const startedIso = new Date(NOW - 30_000).toISOString()

  function runWith(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
    return {
      runId: 'wf-x',
      scriptName: 'x',
      status: 'running',
      startedAt: startedIso,
      agentCalls: [],
      stateFilePath: '',
      ...overrides,
    }
  }

  it('running = 当前时刻滚动（now - startedAt）', () => {
    const run = runWith({ status: 'running' })
    expect(deriveWorkflowRunElapsedMs(run, NOW)).toBe(30_000)
    expect(deriveWorkflowRunElapsedMs(run, NOW + 5_000)).toBe(35_000)
  })

  it('terminal（done）= completedAt 锚停走；completedAt 不可解析回退 start', () => {
    const completedIso = new Date(NOW - 10_000).toISOString()
    expect(deriveWorkflowRunElapsedMs(runWith({ status: 'done', completedAt: completedIso }), NOW)).toBe(20_000)
    expect(deriveWorkflowRunElapsedMs(runWith({ status: 'done', completedAt: 'garbage' }), NOW)).toBe(0)
  })

  it('interrupted（无 completedAt）= health.lastProgressAt 锚停走（不计挂起时间）；缺省/早于 start → null（时长槽省略）', () => {
    const run = runWith({ status: 'interrupted', health: { lastProgressAt: NOW - 5_000 } })
    expect(deriveWorkflowRunElapsedMs(run, NOW)).toBe(25_000) // 停在最后进展时刻，now 推进不增长
    expect(deriveWorkflowRunElapsedMs(run, NOW + 60_000)).toBe(25_000)
    // lastProgressAt 缺省 / 早于 start → null：无可靠停走锚不展示为确定的 0 值（v2 事件
    // fold 派生视图恒不产出 health——中断 run 走此省略分支，消费方 '—'）
    expect(deriveWorkflowRunElapsedMs(runWith({ status: 'interrupted' }), NOW)).toBeNull()
    expect(deriveWorkflowRunElapsedMs(runWith({ status: 'interrupted', health: { lastProgressAt: 1 } }), NOW)).toBeNull()
  })

  it('startedAt 不可解析 → null（时长槽省略）', () => {
    expect(deriveWorkflowRunElapsedMs(runWith({ startedAt: 'garbage' }), NOW)).toBeNull()
  })
})

// ═══════════ 来源节：fileTree（round5 产物；中部 api/useToast mock 已上移产物顶部）═══════════


describe('fileTreeStore D-021 结构', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('nodeStates 是 Map<sid, Map<path, NodeState>>（对象化 + per-session）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loading' })
    store.setNodeState('s1', 'src', { status: 'loaded' })
    store.setNodeState('s2', 'lib', { status: 'error', reason: 'out_of_cwd' })

    // per-session 分桶
    expect(store.nodeStates.get('s1')?.get('src')).toEqual({ status: 'loaded' })
    expect(store.nodeStates.get('s2')?.get('lib')).toEqual({ status: 'error', reason: 'out_of_cwd' })
    // session 隔离
    expect(store.nodeStates.get('s1')?.get('lib')).toBeUndefined()
    expect(store.nodeStates.get('s2')?.get('src')).toBeUndefined()
  })

  it('getNodeState 无记录默认 unloaded', () => {
    const store = useFileTreeStore()
    expect(store.getNodeState('s1', 'any')).toEqual({ status: 'unloaded' })
  })

  it('setNodeState loaded + children 原子 merge（消除双源不一致）', () => {
    const store = useFileTreeStore()
    // 顶层 setTree 先建树
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    // setNodeState loaded 同 step merge children
    const children = [{ path: 'src/index.ts', name: 'index.ts', type: 'file' }]
    store.setNodeState('s1', 'src', { status: 'loaded' }, children)

    // tree 中 src 的 children 已 merge（不是 undefined）
    const tree = store.getTree('s1')!
    expect(tree[0].children).toEqual(children)
    // nodeStates 同步 loaded
    expect(store.getNodeState('s1', 'src').status).toBe('loaded')
  })

  it('setNodeState error 带 reason（来自 WS error code）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'secret', { status: 'error', reason: 'permission_denied' })
    expect(store.getNodeState('s1', 'secret')).toEqual({ status: 'error', reason: 'permission_denied' })
  })
})

describe('fileTreeStore T2.2 缓存复用', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('setTree 后 getTree 返回缓存', () => {
    const store = useFileTreeStore()
    const nodes = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    store.setTree('s1', nodes)
    expect(store.getTree('s1')).toEqual(nodes)
  })

  it('未缓存的 session getTree 返回 undefined', () => {
    const store = useFileTreeStore()
    expect(store.getTree('nope')).toBeUndefined()
  })
})

describe('fileTreeStore T2.6/T2.7/T2.8/T2.9 git overlay', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('T2.6 setGitOverlay 独立于 tree（overlay 先到后挂载）', () => {
    const store = useFileTreeStore()
    // overlay 先设，tree 未设
    store.setGitOverlay('s1', [{ path: 'src/x.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getGitStatus('s1', 'src/x.ts')?.status).toBe('modified')
    // tree 后设，overlay 不丢
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    expect(store.getGitStatus('s1', 'src/x.ts')?.status).toBe('modified')
  })

  it('T2.8/T2.8b 角标全态（M/A/D/U/untracked）', () => {
    const store = useFileTreeStore()
    const statuses: GitFileStatus[] = [
      { path: 'm.ts', xyCode: ' M', status: 'modified' },
      { path: 'a.ts', xyCode: 'A ', status: 'added' },
      { path: 'd.ts', xyCode: ' D', status: 'deleted' },
      { path: 'u.ts', xyCode: 'UU', status: 'unmerged' },
      { path: 'untracked.ts', xyCode: '??', status: 'untracked' },
    ]
    store.setGitOverlay('s1', statuses)
    for (const s of statuses) {
      expect(store.getGitStatus('s1', s.path)?.status).toBe(s.status)
    }
  })

  it('T2.7/T2.9 非 git 仓库 → 不调 setGitOverlay，getGitStatus 返回 undefined', () => {
    const store = useFileTreeStore()
    // 模拟 git.status isRepo=false → composable 不调 setGitOverlay
    store.setTree('s1', [{ path: 'x.ts', name: 'x.ts', type: 'file' }])
    expect(store.getGitStatus('s1', 'x.ts')).toBeUndefined()
    // 树仍渲染
    expect(store.getTree('s1')).toHaveLength(1)
  })

  it('gitOverlay per-session 分桶', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'a.ts', xyCode: ' M', status: 'modified' }])
    store.setGitOverlay('s2', [{ path: 'b.ts', xyCode: 'A ', status: 'added' }])
    expect(store.getGitStatus('s1', 'a.ts')?.status).toBe('modified')
    expect(store.getGitStatus('s2', 'a.ts')).toBeUndefined()
  })
})

describe('fileTreeStore T4.6 invalidate graceful', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('invalidate loaded → invalidated（不报错）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loaded' })
    store.invalidate('s1', ['src'])
    expect(store.getNodeState('s1', 'src').status).toBe('invalidated')
  })

  it('invalidate 未 loaded 的节点不变（只标 loaded→invalidated）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loading' })
    store.invalidate('s1', ['src'])
    expect(store.getNodeState('s1', 'src').status).toBe('loading')
  })

  it('invalidate 不存在的 session graceful（不报错）', () => {
    const store = useFileTreeStore()
    expect(() => store.invalidate('nope', ['any'])).not.toThrow()
  })
})

describe('fileTreeStore W2 getDirChangeCount（目录改动文件数徽章）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('统计 dirPath 子树内改动文件数（path 以 dirPath/ 开头）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/b.ts', xyCode: 'A ', status: 'added' },
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    // dirPath='src' → 'src/a.ts' + 'src/b.ts' = 2
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)
  })

  it('空 overlay / 不存在的 session → 0', () => {
    const store = useFileTreeStore()
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
  })

  it('嵌套子树也算（前缀匹配 dirPath/，含深层路径）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/c.ts', xyCode: ' M', status: 'modified' },
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    // dirPath='src' → 'src/a.ts' + 'src/utils/c.ts' = 2（深层也匹配 'src/' 前缀）
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)
  })

  it('兄弟同名前缀不误算（只算精确 dirPath/ 前缀，不算 src-other/）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src-other/b.ts', xyCode: ' M', status: 'modified' },
    ])
    // 'src-other/b.ts' 不应算进 'src/' 前缀（兄弟目录，非子树）
    expect(store.getDirChangeCount('s1', 'src')).toBe(1)
  })

  it('无改动 → 0（dirPath 子树下无匹配条目）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
  })
})

describe('fileTreeStore W15/D-7.1 徽章预聚合', () => {
  beforeEach(() => setActivePinia(createPinia()))

  /**
   * reference 实现 = 旧算法（setGitOverlay 前 per-row O(n) 前缀扫描），
   * 用于行为等价断言：预聚合后各目录计数与旧算法一致。
   */
  function legacyDirChangeCount(paths: string[], dirPath: string): number {
    const prefix = `${dirPath}/`
    return paths.filter((p) => p.startsWith(prefix)).length
  }

  it('行为等价：同 overlay 下各目录计数与旧前缀扫描算法一致', () => {
    const store = useFileTreeStore()
    const paths = [
      'src/a.ts',
      'src/b.ts',
      'src/utils/c.ts',
      'src/utils/deep/d.ts',
      'src-other/e.ts',
      'README.md',
      'docs/legacy/x.md',
      // [W15 审查] git status porcelain 默认把 untracked 目录折叠为带尾斜杠一条（'newdir/'），
      // 两种算法都应把目录自身计入 newdir（legacy：startsWith('newdir/') 命中自身；
      // 预聚合：首个 '/' 前缀即 'newdir'），父链无额外影响。
      'newdir/',
    ]
    store.setGitOverlay('s1', paths.map((p) => ({ path: p, xyCode: ' M', status: 'modified' })))

    // 覆盖：命中目录 / 嵌套目录 / 深层链 / 兄弟前缀 / 根（''）/ 无命中目录 / 文件路径入参 / 尾斜杠目录
    const dirs = [
      '',
      'src',
      'src/utils',
      'src/utils/deep',
      'src-other',
      'docs',
      'docs/legacy',
      'nonexistent',
      'README.md',
      'newdir',
    ]
    for (const dir of dirs) {
      expect(store.getDirChangeCount('s1', dir)).toBe(legacyDirChangeCount(paths, dir))
    }
  })

  it('O(1) 读取：getDirChangeCount 不触发 overlay 遍历（keys spy 零调用）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/b.ts', xyCode: ' M', status: 'modified' },
    ])

    // spy 预聚合完成后 overlay Map 的迭代入口——O(1) 路径不应触发任何遍历
    const overlayMap = store.gitOverlay.get('s1')!
    const keysSpy = vi.spyOn(overlayMap, 'keys')
    const valuesSpy = vi.spyOn(overlayMap, 'values')
    const entriesSpy = vi.spyOn(overlayMap, 'entries')
    const forEachSpy = vi.spyOn(overlayMap, 'forEach')

    // 多次行级读取（模拟多个目录行渲染）
    for (let i = 0; i < 10; i++) {
      store.getDirChangeCount('s1', 'src')
      store.getDirChangeCount('s1', 'src/utils')
    }
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)

    expect(keysSpy).not.toHaveBeenCalled()
    expect(valuesSpy).not.toHaveBeenCalled()
    expect(entriesSpy).not.toHaveBeenCalled()
    expect(forEachSpy).not.toHaveBeenCalled()
  })

  it('setGitOverlay 覆盖更新 → 预聚合重建（新计数替换旧计数）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/b.ts', xyCode: ' M', status: 'modified' },
    ])
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)

    // overlay 被新状态覆盖（如 ready 回写 / 重新拉取），计数跟随重建而非累加
    store.setGitOverlay('s1', [{ path: 'lib/c.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
    expect(store.getDirChangeCount('s1', 'lib')).toBe(1)
  })

  it('clearSession 清理预聚合分桶', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'src/a.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getDirChangeCount('s1', 'src')).toBe(1)
    store.clearSession('s1')
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
  })

  it('预聚合 per-session 分桶互不串扰', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'src/a.ts', xyCode: ' M', status: 'modified' }])
    store.setGitOverlay('s2', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/b.ts', xyCode: ' M', status: 'modified' },
    ])
    expect(store.getDirChangeCount('s1', 'src')).toBe(1)
    expect(store.getDirChangeCount('s2', 'src')).toBe(2)
  })
})

describe('fileTreeStore 展开态 rehydrate', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('addExpanded/getExpanded per-session', () => {
    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.addExpanded('s1', 'lib')
    expect(store.getExpanded('s1')).toEqual(new Set(['src', 'lib']))
    expect(store.getExpanded('s2')).toEqual(new Set())
  })

  it('removeExpanded 折叠', () => {
    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.removeExpanded('s1', 'src')
    expect(store.getExpanded('s1').has('src')).toBe(false)
  })

  it('clearSession 清理所有状态', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [])
    store.setNodeState('s1', 'x', { status: 'loaded' })
    store.setGitOverlay('s1', [])
    store.addExpanded('s1', 'x')
    store.clearSession('s1')
    expect(store.getTree('s1')).toBeUndefined()
    expect(store.nodeStates.has('s1')).toBe(false)
  })
})

describe('fileTreeStore detail 多文件 tab（display-containers W3 §6.3）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('selectFile：per-session 选中态 + 注入 tab（未开新增并激活）', () => {
    const store = useFileTreeStore()
    store.selectFile('s1', 'a.ts')
    store.selectFile('s1', 'b.ts')
    store.selectFile('s2', 'x.ts')

    // per-session 选中态（旧全局单值跨会话串线的终局解）
    expect(store.getSelectedPath('s1')).toBe('b.ts')
    expect(store.getSelectedPath('s2')).toBe('x.ts')
    // tab 注入（开序 + 激活）
    expect(store.getDetailTabs('s1').map((t) => t.path)).toEqual(['a.ts', 'b.ts'])
    expect(store.getDetailActivePath('s1')).toBe('b.ts')
    expect(store.getDetailTabs('s2').map((t) => t.path)).toEqual(['x.ts'])
  })

  it('注入语义：已开仅激活（不新增不重载）；forceDiff 升级未加载实例、已加载不改模式', () => {
    const store = useFileTreeStore()
    store.openDetailTab('s1', 'a.ts')
    store.updateDetailTab('s1', 'a.ts', { status: 'content', viewMode: 'preview' })

    // 已开已加载 → 仅激活（模式保持）
    store.openDetailTab('s1', 'a.ts', { forceDiff: true })
    expect(store.getDetailTabs('s1').length).toBe(1)
    expect(store.getDetailActivePath('s1')).toBe('a.ts')
    expect(store.getDetailTab('s1', 'a.ts')?.viewMode).toBe('preview')

    // 已开未加载（idle）→ forceDiff 升级为 diff（双通道同 tick 注入的修正式）
    store.openDetailTab('s1', 'b.ts')
    store.openDetailTab('s1', 'b.ts', { forceDiff: true })
    expect(store.getDetailTabs('s1').length).toBe(2)
    expect(store.getDetailTab('s1', 'b.ts')?.viewMode).toBe('diff')
    expect(store.getDetailTab('s1', 'b.ts')?.forceDiff).toBe(true)
  })

  it('closeDetailTab：激活者关闭激活右邻（无则左邻）；关闭选中文件清选中态', () => {
    const store = useFileTreeStore()
    store.selectFile('s1', 'a.ts')
    store.selectFile('s1', 'b.ts')
    store.selectFile('s1', 'c.ts')
    expect(store.getDetailActivePath('s1')).toBe('c.ts')

    // 关激活 c → 右邻不存在 → 左邻 b；c 是选中文件 → 选中态清
    store.closeDetailTab('s1', 'c.ts')
    expect(store.getDetailTabs('s1').map((t) => t.path)).toEqual(['a.ts', 'b.ts'])
    expect(store.getDetailActivePath('s1')).toBe('b.ts')
    expect(store.getSelectedPath('s1')).toBeNull()

    // 关非激活 a → 激活不变
    store.closeDetailTab('s1', 'a.ts')
    expect(store.getDetailActivePath('s1')).toBe('b.ts')

    // 关最后一个 → 空态
    store.closeDetailTab('s1', 'b.ts')
    expect(store.getDetailTabs('s1')).toEqual([])
    expect(store.getDetailActivePath('s1')).toBeNull()
  })

  it('selectFile(null sid) no-op；updateDetailTab 不复活已清分区', () => {
    const store = useFileTreeStore()
    store.selectFile(null, 'a.ts')
    expect(store.getDetailTabs('s1')).toEqual([])

    store.selectFile('s1', 'a.ts')
    store.clearSession('s1')
    // 迟到 RPC 回写不得复活已删 session 的分区（D-B2-1 同口径）
    store.updateDetailTab('s1', 'a.ts', { status: 'content' })
    expect(store.getDetailTabs('s1')).toEqual([])
    expect(store.getSelectedPath('s1')).toBeNull()
  })
})

// ══════════ 节 2/3 — 来源: chat-bash-review-fix.test.ts ══════════

describe('B1: streamingSessionIds 仅扫 role:assistant —— 纯 bash 不阻塞', () => {
  beforeEach(() => setActivePinia(createPinia()))

  beforeEach(() => setActivePinia(createPinia()))

  it('纯 bash 执行（streaming bash 消息，无 assistant streaming）→ isGenerating=false / isActive=false', () => {
    const store = useChatStore()
    const sid = 's-b1'
    // [W1 fix-chat-flow-order] bashStart 只写 ephemeral executingBash，不建消息项
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 30', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(0)

    // 核心断言：纯 bash 执行期间不应被当作 assistant 生成态
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false)
  })

  it('bash 完成后 isGenerating 仍为 false（无回归）', () => {
    const store = useChatStore()
    const sid = 's-b1-done'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hi', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: { sessionId: sid, command: 'echo hi', output: 'hi', exitCode: 0, cancelled: false, truncated: false, timestamp: 2000 },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false)
  })

  it('assistant streaming 仍被正确识别（回归防护：assistant 不被 bash 改动误伤）', () => {
    const store = useChatStore()
    const sid = 's-b1-assistant'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)
    expect(store.isActive(sid)).toBe(true)
  })
})

describe('M1: finalizeMessagesImpl 跳过 bash —— assistant error 不误杀共存 streaming bash', () => {
  beforeEach(() => setActivePinia(createPinia()))

  beforeEach(() => setActivePinia(createPinia()))

  it('assistant 与 bash 并发 → assistant error 收尾后，bash 仍 streaming，后续 bashResult 可正常收尾', () => {
    const store = useChatStore()
    const sid = 's-m1'
    // assistant turn streaming
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-streaming' },
    } as ServerMessage)
    // [W1 fix-chat-flow-order] bashStart 不建消息项——streaming bash 消息手动种子
    // （防御场景：entry 化后正常流转不产生，仅手动注入可验证 finalizeMessages 的跳过语义）
    store.setMessages(sid, [...store.getMessages(sid), {
      id: 'bash-m1',
      role: 'system',
      content: '',
      status: 'streaming',
      bashExecution: { command: 'longcmd', output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1000 },
    } as Message])

    const before = store.getMessages(sid)
    expect(before[0].status).toBe('streaming') // assistant
    expect(before[1].status).toBe('streaming') // bash

    // assistant error 收尾（finalizeSession('error') 走 finalizeMessagesImpl）
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'assistant boom' },
    } as ServerMessage)

    const after = store.getMessages(sid)
    // assistant 被收尾为 error
    expect(after[0].status).toBe('error')
    // 核心断言：bash 仍 streaming（不被 finalizeMessagesImpl 误杀）
    expect(after[1].status).toBe('streaming')
    expect(after[1].bashExecution?.cancelled).toBe(false)
  })

  it('entry 化形态：assistant streaming 中执行 bash → assistant error 后 bash 延迟帧照常 entry 入流', () => {
    const store = useChatStore()
    const sid = 's-m1b'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-streaming' },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'longcmd', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    // assistant error 收尾（run 崩溃），bash 执行态仍 ephemeral 存在
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'assistant boom' },
    } as ServerMessage)
    expect(getExecutingBash(sid)).toBeDefined()

    // 后续 bashResult 延迟帧到达（级联结束 flush）→ entry 入流 append（不依赖 streaming bash 消息）
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: { sessionId: sid, command: 'longcmd', output: 'real output', exitCode: 0, cancelled: false, truncated: false, timestamp: 2000 },
    } as ServerMessage)
    const final = store.getMessages(sid)
    expect(final).toHaveLength(2)
    expect(final[1].bashExecution?.output).toBe('real output')
    expect(final[1].status).toBe('complete')
    expect(getExecutingBash(sid)).toBeUndefined()
  })
})

describe('M2: message.complete 正常收尾 —— 状态复位且推进 10min 无二次收尾', () => {
  beforeEach(() => setActivePinia(createPinia()))

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('message.complete 收尾后状态复位，推进 10min 无二次收尾', () => {
    const store = useChatStore()
    const sid = 's-m2'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)

    // 正常 complete 收尾（reason='normal'）
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.getMessages(sid)[0].status).toBe('complete')

    // spy console.warn：finalizeSession 异常 reason 会打 dev warn（timeout 会命中此分支）。
    // message.complete 走 normal，不打 warn。断言推进 10min 后无任何异常收尾 warn（无二次收尾）。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 推进 10min + 1s（远超正常收尾所需时间）
    vi.advanceTimersByTime(600_000 + 1_000)

    // 核心断言：推进 10min 后无 timeout 收尾，消息保持 complete（未被二次收尾为 error）
    const timeoutWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('reason=timeout'))
    expect(timeoutWarns).toHaveLength(0)
    // 消息仍 complete（未被二次收尾为 error）
    expect(store.getMessages(sid)[0].status).toBe('complete')

    warnSpy.mockRestore()
  })
})

describe('B2: useChat.abortBash RPC 失败 → markBashError 写回 store 真 ref', () => {
  beforeEach(() => setActivePinia(createPinia()))

  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    vi.clearAllMocks()
  })

  it('abortBash RPC reject → executingBash 被清（markBashError 兜底），手动种子消息写回真 ref', async () => {
    apiMock.abortBash.mockRejectedValueOnce(new Error('rpc boom'))

    const { abortBash } = useChat()
    const store = useChatStore()
    const sid = 's-b2'

    // bashStart 写 ephemeral 执行态（模拟 bash 正在执行）+ 手动种子 streaming bash 消息
    //（防御路径：验证 markBashError 对真 ref 的写回在新形态下仍有效）
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 999', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    expect(getExecutingBash(sid)).toBeDefined()
    store.setMessages(sid, [{
      id: 'bash-b2',
      role: 'system',
      content: '',
      status: 'streaming',
      bashExecution: { command: 'sleep 999', output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1000 },
    } as Message])

    // abortBash RPC 失败 → catch 调 markBashError（B2 修复后写回 store 真 ref）
    await expect(abortBash(sid)).resolves.toBeUndefined()

    // 核心断言 1：executingBash 被清（abortBash RPC 失败时无 bashResult 帧到达的唯一兜底清点）
    expect(getExecutingBash(sid)).toBeUndefined()
    // 核心断言 2：手动种子消息被标 error（旧实现 { value: chat.messages } 写入丢失，
    // store 不会更新，消息会仍 streaming）。cancelled=true。
    const after = store.getMessages(sid)
    expect(after[0].status).toBe('error')
    expect(after[0].bashExecution?.cancelled).toBe(true)
    expect(after[0].error).toBe('rpc boom')
    // [chat-flow R4] 停止失败 toast 已删：错误文本经 markBashError 写入 bash 消息 error 字段
    // （上方断言 2 已覆盖），不再弹 toast
    expect(toastError).not.toHaveBeenCalled()
  })
})

// ══════════ 节 3/3 — 来源: quota-store.test.ts ══════════

describe('useQuotaStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const mockRow: NormalizedQuotaRow = {
    label: 'Zhipu Coding Plan',
    wins: [
      { pct: 68, resetSec: 4980 },
      { pct: 42, resetSec: 266400 },
      { pct: null, resetSec: null },
    ],
  }

  it('setCache + getEntry：写入后可读取', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)

    const entry = store.getEntry('zhipu')
    expect(entry).toBeDefined()
    expect(entry!.data).toEqual(mockRow)
    expect(entry!.lastFetchAt).toBe(1000)
  })

  it('getEntry：不存在的 key 返回 undefined', () => {
    const store = useQuotaStore()
    expect(store.getEntry('nonexistent')).toBeUndefined()
  })

  it('setCache：覆盖写入', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)
    store.setCache('zhipu', null, 2000)

    const entry = store.getEntry('zhipu')
    expect(entry!.data).toBeNull()
    expect(entry!.lastFetchAt).toBe(2000)
  })

  it('markPending：首次标记返回 true，重复标记返回 false', () => {
    const store = useQuotaStore()
    expect(store.markPending('zhipu')).toBe(true)
    expect(store.markPending('zhipu')).toBe(false)
    expect(store.isPending('zhipu')).toBe(true)
  })

  it('unmarkPending：取消后可重新标记', () => {
    const store = useQuotaStore()
    store.markPending('zhipu')
    store.unmarkPending('zhipu')
    expect(store.isPending('zhipu')).toBe(false)
    expect(store.markPending('zhipu')).toBe(true)
  })

  it('isPending：未标记的 key 返回 false', () => {
    const store = useQuotaStore()
    expect(store.isPending('zhipu')).toBe(false)
  })

  it('clearCache：清除指定 provider 缓存', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)
    store.clearCache('zhipu')
    expect(store.getEntry('zhipu')).toBeUndefined()
  })

  it('clearCache：不影响其他 provider', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)
    store.setCache('kimi', mockRow, 2000)
    store.clearCache('zhipu')
    expect(store.getEntry('zhipu')).toBeUndefined()
    expect(store.getEntry('kimi')).toBeDefined()
  })

  it('多 provider 隔离：pending 和 cache 互不干扰', () => {
    const store = useQuotaStore()
    store.markPending('zhipu')
    store.setCache('kimi', mockRow, 1000)

    expect(store.isPending('zhipu')).toBe(true)
    expect(store.isPending('kimi')).toBe(false)
    expect(store.getEntry('zhipu')).toBeUndefined()
    expect(store.getEntry('kimi')).toBeDefined()
  })
})

// ═══════════ 来源节：list-load-error ═══════════

function makeWorkflow(id: string): WorkflowRunRecord {
  return {
    runId: id,
    scriptName: `wf-${id}`,
    slug: '',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    stateFilePath: '',
    agentCalls: [],
  }
}


describe('U5: session store listLoadError（W2 / S5）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loadSessions 失败后 session.listLoadError 为非空错误消息', async () => {
    const scope = effectScope()
    scope.run(() => useSidebar())
    const session = useSessionStore()

    listMock.mockRejectedValue(new Error('server down'))
    // loadSessions 是 useSidebar 内部函数，通过重新调用触发
    // 需要直接调 useSidebar().loadSessions()
    const sidebar = scope.run(() => useSidebar())!
    await sidebar.loadSessions()

    expect(session.listLoadError).toBe('server down')
    scope.stop()
  })

  it('loadSessions 成功后 listLoadError 清空为 null', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    const session = useSessionStore()

    // 先失败
    listMock.mockRejectedValueOnce(new Error('fail'))
    await sidebar.loadSessions()
    expect(session.listLoadError).not.toBeNull()

    // 再成功
    listMock.mockResolvedValue([])
    await sidebar.loadSessions()
    expect(session.listLoadError).toBeNull()

    scope.stop()
  })
})

describe('U6: workflow store loadError（W2 / M1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loadWorkflows 失败后 loadError 含错误消息，records 保留旧数据', async () => {
    const store = useWorkflowStore()
    const sid = 's1'
    const record1 = makeWorkflow('w1')

    // 先成功加载一条数据（形状对齐 [RT-4#8] 结构化返回 { workflows, oversize }）
    getWorkflowsMock.mockResolvedValueOnce({ sessionId: sid, workflows: [record1], oversize: false })
    await store.loadWorkflows(sid)
    expect(store.getRecordsBySession(sid)).toHaveLength(1)

    // 再失败
    getWorkflowsMock.mockRejectedValue(new Error('timeout'))
    await store.loadWorkflows(sid)

    expect(store.loadErrorOf('s1')).toBe('timeout')
    // records 保留旧数据（未被清空）
    expect(store.getRecordsBySession(sid)).toEqual([record1])
    expect(store.isLoadingOf('s1')).toBe(false)
  })
})

describe('U7: subagent fetchAndInject fail-fast（W2 / M5）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('fetchAndInject 失败时 throw，setMessages 不被调用', async () => {
    const store = useSubagentStore()
    const setMessages = vi.fn()

    getSubagentHistoryMock.mockRejectedValue(new Error('rpc fail'))

    await expect(
      store.fetchAndInject('mainSid', 'subId', setMessages),
    ).rejects.toThrow('rpc fail')

    // setMessages 未被调用（不再静默注入空数组）
    expect(setMessages).not.toHaveBeenCalled()
  })
})
