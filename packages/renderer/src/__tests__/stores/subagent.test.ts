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
import type { MockInstance } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSubagentStore } from '@/stores/subagent'
import type { SubagentRecord, Message } from '@xyz-agent/shared'

// mock sessionApi（loadSubagents / fetchAndInject / cancelSubagent 内部调用）
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  getSubagents: vi.fn(),
  getSubagentHistory: vi.fn(),
  subagentAction: vi.fn(),
}))

// subagent store 经 @/api 门面导入 session，需把门面 session 指回上面 mock 的 domains 命名空间，
// 保证 store 与断言用的是同一个 vi.fn()。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@xyz-agent/core/transport/api/domains/session')
  return { ...actual, session }
})

import * as sessionApi from '@xyz-agent/core/transport/api/domains/session'

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
    vi.mocked(sessionApi.getSubagents).mockResolvedValue(records)

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
    expect(store.loadError).toBe('network')
    expect(store.isLoading).toBe(false)
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

// ── 空结果守卫接线冒烟（R7 归一）：strike 机制全部行为（阈值计数 / 非空打断重置 /
// reset 清零 / 分区空放行 / warn 文案结构）直测锁定在
// __tests__/lib/partitioned-session-records.test.ts（守卫工厂单源，S4 A1；不 import store，无环）。
// 此处只证明守卫经本 store 接线真实可达：strike 放行路径 + catch 重置路径；
// clearSession 联动见下方 clearSession describe 的簿记用例。
// 背景（sidebar-sync-plan P1 + R1 business-logic S3）：runtime getSubagents 读盘失败时
// catch 降级返回 []，连续 2 次空才判真实删空覆盖分区，瞬时读失败不得清掉分区历史。

describe('subagent store — loadSubagents 空结果守卫（接线冒烟）', () => {
  let warnSpy: MockInstance

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('连续第 2 次 RPC 空 → 判真实删空，清分区（strike 1/2 保留 → 2/2 放行全程经 store 可达 + 接线 tag）', async () => {
    vi.mocked(sessionApi.getSubagents).mockResolvedValue([])

    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-keep' })])
    await store.loadSubagents('session-1') // strike 1/2：保留
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)
    // 接线参数：warn 前缀含 store 传入的 logTag + fetchLabel（文案结构归共享直测）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[subagent-store] getSubagents returned empty list'),
      'session-1',
    )
    await store.loadSubagents('session-1') // strike 2/2：真实删空判定，放行覆盖
    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('clearing partition'),
      'session-1',
    )
    // 守卫不是错误态：不设 loadError
    expect(store.loadError).toBeNull()
  })

  it('RPC 失败（catch）→ strike 重置，不让连接故障累计出误清分区', async () => {
    const store = useSubagentStore()
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-keep' })])

    vi.mocked(sessionApi.getSubagents).mockResolvedValue([]) // strike 1/2
    await store.loadSubagents('session-1')
    vi.mocked(sessionApi.getSubagents).mockRejectedValue(new Error('network'))
    await store.loadSubagents('session-1') // catch → strike 重置
    vi.mocked(sessionApi.getSubagents).mockResolvedValue([]) // 重新 strike 1/2，仍保留
    await store.loadSubagents('session-1')

    expect(store.getRecordsBySession('session-1')).toHaveLength(1)
    expect(store.getRecordsBySession('session-1')[0].subagentId).toBe('bg-keep')
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

  it('strike 簿记随分区清除：clearSession 后重新预置分区，strike 从 0 重新计（不残留旧计数）', async () => {
    // R3 test-coverage S1 + R7 接线冒烟：reset 语义（清零后重新计数）归共享直测
    // （partitioned-session-records.test.ts），此处锁 clearSession 接线确实调了 reset——
    // 若 clearSession 漏调 strikeGuard.reset，残留计数让重新预置后的首次空结果直接
    // strike 2/2 误判删空 → 分区保留断言红。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useSubagentStore()
    vi.mocked(sessionApi.getSubagents).mockResolvedValue([])

    // 预置非空分区 → strike 1/2：空结果保留
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-keep' })])
    await store.loadSubagents('session-1')
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)

    // clearSession：分区 + strike 簿记一并清除
    store.clearSession('session-1')
    expect(store.getRecordsBySession('session-1')).toEqual([])

    // 重新预置非空分区 → 第 1 次空结果从 strike 1 重新计（保留分区 + warn 明示 1/2）。
    // 残留计数场景（clearSession 漏删）此步为 strike 2/2 → 分区被清 → 断言红
    store.applyRecords('session-1', [makeRecord({ subagentId: 'bg-keep-2' })])
    await store.loadSubagents('session-1')
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)
    expect(store.getRecordsBySession('session-1')[0].subagentId).toBe('bg-keep-2')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty strike 1/2'), 'session-1')

    // 再 1 次空 → strike 2/2 判真实删空放行（重新计数的完整语义闭环）
    await store.loadSubagents('session-1')
    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('clearing partition'), 'session-1')
    warnSpy.mockRestore()
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
    // 返回值契约：调用方（u2 编排层）据此判定分区是否种兑底
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
// store 内 import * as events from '@xyz-agent/core/transport/api'，此处 mock events.on 捕获 WS handler。
// E-4：双键订阅（主 sid = 旧 widget 通道帧路由 key；虚拟分区 id = tee 帧路由 key），
// 每次 subscribeStream 消耗 events.on 两次。
vi.mock('@xyz-agent/core/transport/api', () => ({
  on: vi.fn(),
}))

import * as events from '@xyz-agent/core/transport/api'

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
