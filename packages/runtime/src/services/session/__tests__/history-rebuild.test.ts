/**
 * SessionHistoryReader 直测（S6 迁出批 2）：history 域读编排——getHistory 三分支重建
 * （缓存增量 / RPC 全量 / 尾读降级）+ parentId 不变量 + Entry-not-found 自愈 +
 * inflight 合并 + [u6] 游标翻页（crash-resilience §3.3 D4 中期）+ onSessionDisposed 清理
 * （getFullHistory 文件直读已随全量通路退役，用例同点退役）。
 *
 * 分层（G2：import 无 session-service，stub 面 = deps 2 方法 + session-history 模块）：
 * - mock 层 = deps（pm.getClient / sessionStore.rebuild/scan）与 session-history 的
 *   尾读/全量文件读；三分支编排、LRU 缓存、mergeIncrementalMessages 去重等生产逻辑真实执行。
 * - entry→Message 转换链（rebuildHistoryFromEntries）由 session-history 域自身测试覆盖，
 *   此处以可编程 mock 替换，断言集中在编排分支选择与缓存状态迁移。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '@taiji/shared'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import { getHistoryTailFromFile } from '../../session-history.js'
import { SessionHistoryReader } from '../history-rebuild-cache.js'

vi.mock('../../session-history.js', () => ({
  // [u6] getHistoryFromFilePath 不再被 history-rebuild-cache 消费（getFullHistory 退役），
  // mock 同点移除；①档函数本体保留（session-records 的 subagent/agentcall 通路消费）。
  getHistoryTailFromFile: vi.fn(async () => ({ messages: [{ id: 'tail-1', role: 'user', content: 'tail', status: 'complete', timestamp: 1 } as Message], truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })),
}))

// session-history 模块级 mock：调用计数跨用例累积，前置清零（r1-S16 尾读用例引入后
// 「not.toHaveBeenCalled」类断言会被先前用例的历史调用打穿）
beforeEach(() => {
  vi.mocked(getHistoryTailFromFile).mockClear()
})

/** pi entry 最小形态（编排只消费 parentId / 传给 rebuild mock）。 */
function entry(id: string, parentId: string | null): Record<string, unknown> {
  return { type: 'message', id, parentId, timestamp: '2026-08-19T00:00:00Z' }
}

function msg(id: string, piEntryId?: string): Message {
  return { id, role: 'user', content: `content-${id}`, status: 'complete', timestamp: 1, piEntryId } as Message
}

/** get_entries RPC 返回形态（pi GetEntriesResponse：{entries, leafId}）。 */
type GetEntriesResult = { data?: { entries?: Array<Record<string, unknown>>; leafId?: string | null } }

function makeReader(rebuildImpl?: (entries: Array<Record<string, unknown>>) => Message[]) {
  const client = {
    getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [], leafId: null } }) as GetEntriesResult),
  }
  const rebuild = vi.fn((entries: Array<Record<string, unknown>>): { messages: Message[]; orphanToolResults: [] } => ({
    // 缺省实现：每 entry 产一条消息，piEntryId = entry.id
    messages: (rebuildImpl ?? ((es) => es.map((e) => msg(`m-${String(e.id)}`, String(e.id)))))(entries),
    orphanToolResults: [],
  }))
  const sessionStore = {
    scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>),
    rebuildHistoryFromEntries: rebuild,
  } as unknown as ISessionStore
  const reader = new SessionHistoryReader({
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore,
  })
  return { reader, client, rebuild, sessionStore }
}

describe('分支 3：全量重建（无缓存）', () => {
  it('client 活跃：getEntries 全量 → rebuild → 写缓存并返回浅拷贝', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValue({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    const result = await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenCalledWith()
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1'])
    expect(result.truncated).toBe(false)
    // 返回浅拷贝：就地 push 不打穿缓存基底
    result.messages.push(msg('intruder'))
    const again = await reader.getHistory('s1')
    // 第二次走缓存增量（空增量 = 新鲜短路），内容仍是原两条基线 + 无 intruder
    expect(again.messages.some((m) => m.id === 'intruder')).toBe(false)
  })

  it('边界（r1-S16）：缓存存在但 leafId 为 null → 跳过增量直接全量重建（分支 1/2 与 3 交界）', async () => {
    const { reader, client, rebuild } = makeReader()
    // 首轮建缓存：leafId null（pi 未给叶子 id）但 messages 非空 → 缓存条目 leafId=null
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null)], leafId: null } })
    await reader.getHistory('s1')
    // 第二轮：cached 存在但 leafId null → 不走 since 增量，重新全量拉取重建
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null), entry('e2', 'e1')], leafId: 'e2' } })
    const result = await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenLastCalledWith() // 全量调用（无 since 参数）
    expect(rebuild).toHaveBeenCalledTimes(2)
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1', 'm-e2'])
  })

  it('R-12：RPC entries 空 → 短路返回空列表（不走尾读）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: null } })
    const result = await reader.getHistory('s1')
    expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
  })

  it('全量 getEntries 抛错（分支 3 catch，r1-S16）→ 尾读降级', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockRejectedValue(new Error('pi internal error'))
    const degraded = await reader.getHistory('s1')
    expect(degraded.truncated).toBe(true)
    expect(degraded.messages.map((m) => m.id)).toEqual(['tail-1'])
  })
})

describe('分支 1/2：缓存命中 → since 增量', () => {
  it('空增量 = 缓存新鲜：R-12 短路返回缓存，零重建零尾读', async () => {
    const { reader, client, rebuild } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null), entry('e2', 'e1')], leafId: 'e2' } })
    await reader.getHistory('s1') // 建缓存
    client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: 'e2' } })
    const result = await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenLastCalledWith('e2')
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1', 'm-e2'])
    expect(rebuild).toHaveBeenCalledTimes(1) // 增量窗口未重建
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
  })

  it('增量非空且 parentId 不变量成立：merge 合并入缓存并推进 leafId', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e2', 'e1')], leafId: 'e2' } })
    const result = await reader.getHistory('s1')
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1', 'm-e2'])
    expect(result.truncated).toBe(false)
    // 缓存已推进：下次增量以新 leafId 为 since
    client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: 'e2' } })
    await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenLastCalledWith('e2')
  })

  it('增量消息与缓存 piEntryId 重复时去重（D6-3，mergeIncrementalMessages 真跑）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null), entry('e2', 'e1')], leafId: 'e2' } })
    await reader.getHistory('s1')
    // 增量窗口首条 parent 匹配缓存 leafId，窗口尾部混入已缓存的 e2（pi slice 异常时序防御）
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e3', 'e2'), entry('e2', 'e1')], leafId: 'e3' } })
    const result = await reader.getHistory('s1')
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1', 'm-e2', 'm-e3'])
  })

  it('parentId 不变量违反（branch/rewrite）：丢缓存 fall-through 全量重建', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    // delta 首条 parent ≠ 缓存 leafId → 丢缓存 → 同次调用内全量重建
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) return { data: { entries: [entry('branch-head', 'old-point')], leafId: 'branch-head' } } as GetEntriesResult
      return { data: { entries: [entry('r1', null), entry('r2', 'r1')], leafId: 'r2' } } as GetEntriesResult
    })
    const result = await reader.getHistory('s1')
    expect(result.messages.map((m) => m.id)).toEqual(['m-r1', 'm-r2'])
    expect(client.getEntries).toHaveBeenCalledWith()
  })

  it('增量 Entry not found：丢缓存 → 全量重拉（D6-4 自愈）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) throw new Error('Entry not found: e1')
      return { data: { entries: [entry('f1', null)], leafId: 'f1' } } as GetEntriesResult
    })
    const result = await reader.getHistory('s1')
    expect(result.messages.map((m) => m.id)).toEqual(['m-f1'])
  })

  it('增量其他错误：尾读降级 + 缓存保留（下次重试仍走 since）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    client.getEntries.mockRejectedValueOnce(new Error('rpc timeout'))
    const degraded = await reader.getHistory('s1')
    expect(degraded.truncated).toBe(true)
    expect(degraded.messages.map((m) => m.id)).toEqual(['tail-1'])
    // 缓存未被丢弃：恢复后重试走 since
    client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: 'e1' } })
    const retry = await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenLastCalledWith('e1')
    expect(retry.truncated).toBe(false)
  })
})

describe('无 client（离线 session）与全量文件读', () => {
  it('无 RPC client：直接尾读降级（不读不写缓存）', async () => {
    const reader = new SessionHistoryReader({
      pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
      sessionStore: {} as unknown as ISessionStore,
    })
    const result = await reader.getHistory('s1')
    expect(result.truncated).toBe(true)
    expect(getHistoryTailFromFile).toHaveBeenCalled()
  })

  // ── [u6] 游标翻页（crash-resilience §3.3 D4 中期；必测断言①⑥）──

  it('游标翻页：缓存命中 → 全量基线切前缀，返回锚点前最近 limitTurns turns（零 RPC）', async () => {
    const { reader, client } = makeReader()
    // 5 turn 基线（rebuild mock 每 entry 产一条 user 消息 = 每 entry 一个 turn）
    client.getEntries.mockResolvedValue({
      data: { entries: [entry('e1', null), entry('e2', 'e1'), entry('e3', 'e2'), entry('e4', 'e3'), entry('e5', 'e4')], leafId: 'e5' },
    })
    await reader.getHistory('s1') // 建缓存（全量基线）
    client.getEntries.mockClear()
    const page = await reader.getHistory('s1', { cursor: 'e5', limitTurns: 2 })
    // 缓存基线直读，零 RPC（锚前内容 append-only，对基线新鲜度不敏感）
    expect(client.getEntries).not.toHaveBeenCalled()
    // 锚点 e5 之前最近 2 turns = e3、e4（e5 自身不返回——已在 renderer 分区）
    expect(page.messages.map((m) => m.id)).toEqual(['m-e3', 'm-e4'])
    expect(page.truncated).toBe(true) // 锚前仍有更早 turn（e1、e2）
    expect(page.loadedTurns).toBe(2)
    expect(page.totalTurnsEstimate).toBe(4) // 锚前缀内精确 turn 总数
  })

  it('游标翻页：翻页到头（锚点为最早 turn）→ 前缀空 → 空页 + truncated=false', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValue({
      data: { entries: [entry('e1', null), entry('e2', 'e1')], leafId: 'e2' },
    })
    await reader.getHistory('s1')
    const page = await reader.getHistory('s1', { cursor: 'e1' })
    expect(page.messages).toEqual([])
    expect(page.truncated).toBe(false)
    expect(page.loadedTurns).toBe(0)
  })

  it('游标翻页：cursor 未命中（已被清理）→ 空页 + truncated=false，不报错', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValue({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    const page = await reader.getHistory('s1', { cursor: 'gone-entry' })
    expect(page.messages).toEqual([])
    expect(page.truncated).toBe(false)
  })

  it('游标翻页：无缓存 → getEntries 全量重建写缓存后切前缀；RPC 失败 → 文件游标读降级', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValue({
      data: { entries: [entry('e1', null), entry('e2', 'e1'), entry('e3', 'e2')], leafId: 'e3' },
    })
    const page = await reader.getHistory('s1', { cursor: 'e3', limitTurns: 1 })
    expect(client.getEntries).toHaveBeenCalledWith() // 无缓存 → 全量重建
    expect(page.messages.map((m) => m.id)).toEqual(['m-e2'])
    expect(page.truncated).toBe(true)

    // RPC 失败（无缓存）→ 文件游标读降级（cursor/maxBytes 透传）
    const { reader: reader2, client: client2 } = makeReader()
    client2.getEntries.mockRejectedValue(new Error('rpc down'))
    await reader2.getHistory('s1', { cursor: 'e9', maxBytes: 123 })
    expect(getHistoryTailFromFile).toHaveBeenCalledWith(
      's1',
      expect.anything(),
      20, // limitTurns 缺省回落 HISTORY_BUDGET.RECENT_TURNS
      { cursor: 'e9', maxBytes: 123 },
    )
  })

  it('游标翻页：离线 session（无 client）→ 文件游标读', async () => {
    const reader = new SessionHistoryReader({
      pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
      sessionStore: {} as unknown as ISessionStore,
    })
    await reader.getHistory('s1', { cursor: 'e2' })
    expect(getHistoryTailFromFile).toHaveBeenCalledWith('s1', expect.anything(), 20, { cursor: 'e2', maxBytes: expect.any(Number) })
  })
})

describe('inflight 合并与 onSessionDisposed', () => {
  it('并发 getHistory 同 session 共享一次 RPC（W20 Fix-5）', async () => {
    const { reader, client } = makeReader()
    let release!: (v: GetEntriesResult) => void
    client.getEntries.mockImplementation(async () => new Promise<GetEntriesResult>((resolve) => { release = resolve }))
    const p1 = reader.getHistory('s1')
    const p2 = reader.getHistory('s1')
    release({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(client.getEntries).toHaveBeenCalledTimes(1)
    expect(r1).toEqual(r2)
  })

  it('onSessionDisposed：清缓存（后续 getHistory 走全量而非增量）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValue({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    reader.onSessionDisposed('s1')
    client.getEntries.mockClear()
    await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenCalledWith() // 无缓存 → 全量（无参调用）
  })

  it('onSessionDisposed：未缓存 session 幂等 no-op', () => {
    const { reader } = makeReader()
    expect(() => reader.onSessionDisposed('s-none')).not.toThrow()
  })
})
