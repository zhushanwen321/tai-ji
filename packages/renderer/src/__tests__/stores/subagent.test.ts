// @vitest-environment node

/**
 * subagent store 单测 —— state / getters / actions 覆盖（数据加载层）。
 *
 * 覆盖（U7 后保留的数据加载层）：
 * - records 初值空数组
 * - loadSubagents 成功写入 records + 失败清空
 * - clearSubagents 清空 records + 停止所有 streaming
 * - clearSession per-session 分区释放
 * - isRunning 读 records status
 * - hasRunning 分区是否有 running
 * - cancelSubagent RPC + 乐观更新
 * - fetchAndInject fail-fast + setMessages（空历史不擦分区，返回拉取的 history）
 *
 * [HISTORICAL] overlay viewing 用例（selectSubagent/backToMain/isViewing/getViewingSubagentId/
 * getActiveSubagentVirtualId/getCurrentSubagent/per-panel getters）已随 U7 overlay 移除删除。
 * subagent 详情现走 drawer SubagentTab（直接 fetchAndInject + subscribeStream），不经 store
 * viewing 状态机。
 *
 * 运行：npx vitest run src/__tests__/stores/subagent.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSubagentStore } from '@/stores/subagent'
import type { SubagentRecord, Message } from '@taiji/shared'

// mock sessionApi（loadSubagents / fetchAndInject / cancelSubagent 内部调用）
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getSubagents: vi.fn(),
  getSubagentHistory: vi.fn(),
  subagentAction: vi.fn(),
}))

// subagent store 经 @/api 门面导入 session，需把门面 session 指回上面 mock 的 domains 命名空间，
// 保证 store 与断言用的是同一个 vi.fn()。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

import * as sessionApi from '@taiji/core/transport/api/domains/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 构造测试 SubagentRecord */
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
  it('recordsBySession 初值为空 Map', () => {
    const store = useSubagentStore()
    expect(store.getRecordsBySession('session-1')).toEqual([])
  })
})

describe('subagent store — loadSubagents', () => {
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
// 原连续空计数 strike 守卫随歧义根治整体退役（原 sidebar-sync-plan P1 + R1
// business-logic S3 的补偿，其补偿对象已不存在）。

describe('subagent store — loadSubagents found 会话存在性判定（待裁决项 4 行为锁）', () => {
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

    // 空结果不写入：E-4 已投影内容不被擦除（drawer-blank-fix §6.2）
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

// ── subscribeStream / stopStream（W4 收口机制 + U8 drawer scope token + E-4 双订阅适配）──
//
// store 内 import * as events from '@taiji/core/transport/api'，此处 mock events.on 捕获 WS handler。
// E-4：双键订阅（主 sid = 旧 widget 通道帧路由 key；虚拟分区 id = tee 帧路由 key），
// 每次 subscribeStream 消耗 events.on 两次。
vi.mock('@taiji/core/transport/api', () => ({
  on: vi.fn(),
}))

import * as events from '@taiji/core/transport/api'

describe('subagent store — subscribeStream / stopStream（streaming 订阅生命周期）', () => {
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

    // 两个 key 的 handler 同语义：帧类型 / recordId 过滤 + delta 经 chat 回调收口（W4）。
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

  it('lines === undefined（assistant 定稿清除帧）→ finalize 收口，不停订阅不 refetch（E-4 / R1 消解）', async () => {
    const store = useSubagentStore()
    const { getVirtualKeyHandler, unsubSpies, chat } = subscribe(store)

    getVirtualKeyHandler()({ type: 'subagent.stream_delta', payload: { recordId: 'bg-1', lines: undefined } })

    // 收口 streaming 实体（chat store sealed 收口）
    expect(chat.finalizeSubagentStream).toHaveBeenCalledWith('subagent:session-1:bg-1')
    // 订阅保留（续聊轮后续 delta 仍可达）+ 无 refetch（定稿由 entry 帧投影链覆盖）
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
    // 宽口径（running 字面）不计 stopReason——SubagentTab 订阅语义保留（死亡纳管态仍可被接管链活动）
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

