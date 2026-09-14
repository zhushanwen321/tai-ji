/**
 * D6 历史增量 + 重建缓存测试（wave:perf-w20）。
 *
 * 覆盖（plan.md W20 验收）：
 * 1. 增量路径——第二次 getHistory 带 since 且返回增量条目 < 全量
 * 2. 空 entries 短路（R-12：不走尾读 fallback，直接返回缓存/空列表）
 * 3. "Entry not found" fallback 全量重拉（D6-4）+ 其他错误走尾读且缓存不动
 * 4. lastLeafId 随成功 getHistory 更新、removeSessionEntry（pi 退出汇聚点）清除
 * 5. HistoryRebuildCache LRU 容量帽 + mergeIncrementalMessages piEntryId 去重
 * 6. B8（memory-leak-remediation §3.3-B8）：单条目字节帽（超限不入缓存——「缓存从未
 *   存在」退化，重进走全量重建）+ reclaim 驱逐（驱逐后重激活全量重建并写回新缓存）
 *
 * mock 分层：
 * - client.getEntries：按调用序列返回真实响应形状 {data: {entries, leafId}}；
 *   "Entry not found" 走真实 reject 路径（new Error(msg.error)，与 rpc-client 一致）
 * - sessionStore.rebuildHistoryFromEntries：直通 mock（entry.id → piEntryId），
 *   只测 getHistory 的分支编排（since 传递/短路/fallback/缓存生命周期）
 * - getHistoryTailFromFile：模块级 spy（断言「不走尾读」的唯一可信证据）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-history-incremental.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { PiSessionEntry } from '../infra/pi/pi-protocol.js'

// spy 尾读 fallback（「不走尾读」的判定依据）
vi.mock('../services/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/session-history.js')>()
  return {
    ...actual,
    getHistoryTailFromFile: vi.fn(async () => ({ messages: [], truncated: true, loadedTurns: 0, totalTurnsEstimate: 0 })),
  }
})
const { getHistoryTailFromFile } = await import('../services/session-history.js')

// SUT 在 vi.mock 之后 import（session-service 内部引用 mocked 模块）
const { SessionService } = await import('../services/session/session-service.js')
const { HistoryRebuildCache, SessionHistoryReader, mergeIncrementalMessages } = await import('../services/session/history-rebuild-cache.js')
// Fix-1/7 回归用真实重建（不 mock rebuildHistoryFromEntries，验证孤儿回填补丢失工具输出）
const { rebuildHistoryFromEntries } = await import('../infra/pi/entry-tree-builder.js')

/**
 * 最小 PiSessionEntry（rebuildHistoryFromEntries 是直通 mock，只消费 id/parentId）。
 * parentId 默认 null——增量 delta 的首条 entry 必须显式传「上次缓存 leafId」，
 * 否则触发 Fix-2 parentId 不变量检测（丢缓存全量重建），非预期路径。
 */
function entry(id: string, parentId: string | null = null): PiSessionEntry {
  return { id, type: 'message', parentId, timestamp: '2026-08-16T00:00:00.000Z' } as unknown as PiSessionEntry
}

function msg(piEntryId: string) {
  return {
    id: `m-${piEntryId}`,
    role: 'user' as const,
    content: `content-${piEntryId}`,
    status: 'complete' as const,
    piEntryId,
    timestamp: 1,
  }
}

interface GetEntriesCall {
  since?: string
}

/**
 * 构造 SessionService + 可编排的 getEntries mock。
 * getEntriesScript 按调用序出队：每项是 {data} 成功响应或 Error（reject）。
 * 每次调用记录 since 参数（断言增量路径的传递）。
 * opts.realRebuild = true 时 rebuildHistoryFromEntries 用真实实现（entry-tree-builder），
 * 供 Fix-1/7 窗口语义回归（不 mock 重建，验证孤儿回填与 compaction 并入）。
 */
function makeService(
  getEntriesScript: Array<{ data?: { entries: PiSessionEntry[]; leafId: string | null } } | Error>,
  opts?: { realRebuild?: boolean },
) {
  const calls: GetEntriesCall[] = []
  const client = {
    getEntries: vi.fn(async (since?: string) => {
      calls.push({ since })
      const step = getEntriesScript.shift()
      if (step instanceof Error) throw step
      if (!step) throw new Error('getEntries script exhausted')
      return step
    }),
  } as unknown as IPiEngine

  const broker = { broadcast: vi.fn((_m: ServerMessage) => {}) } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  const sessionStore = {
    // 直通 mock：entry.id → Message.piEntryId（getHistory 的分支逻辑与重建实现解耦）；
    // realRebuild 时换真实 entry-tree-builder（含孤儿 toolResult 收集，Fix-1）
    rebuildHistoryFromEntries: opts?.realRebuild
      ? (entries: PiSessionEntry[]) => rebuildHistoryFromEntries(entries, null)
      : vi.fn((entries: PiSessionEntry[]) => ({
          messages: entries.map((e) => msg(e.id)),
          orphanToolResults: [],
        })),
    scanSessions: vi.fn(() => []),
    extractSessionOutcome: vi.fn(() => null),
    persistSessionEnd: vi.fn(),
  } as never

  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
    '/test/project-root',
    {} as never,
    { getDefaultModel: () => null } as never,
    sessionStore,
    { pruneStaleCache: vi.fn() } as never,
    {} as never,
  )
  return { svc, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── 单元：HistoryRebuildCache（D6-1 容量帽 LRU）────────────────

describe('HistoryRebuildCache', () => {
  it('超容量帽驱逐最久未访问的 session 条目（帽 8，对齐 renderer LRU 窗口）', () => {
    const cache = new HistoryRebuildCache()
    const e = () => ({ leafId: `leaf-${Math.random()}`, messages: [], truncated: false })
    for (let i = 0; i < 10; i++) cache.set(`s-${i}`, e())
    expect(cache.size).toBe(8)
    // 最久的 s-0/s-1 被驱逐，最新的 s-2..s-9 保留
    expect(cache.get('s-0')).toBeUndefined()
    expect(cache.get('s-1')).toBeUndefined()
    expect(cache.get('s-9')).toBeDefined()
  })

  it('get 刷新 LRU 位置——访问过的条目不被后续超帽驱逐', () => {
    const cache = new HistoryRebuildCache(2)
    const e = () => ({ leafId: 'l', messages: [], truncated: false })
    cache.set('a', e())
    cache.set('b', e())
    cache.get('a') // a 移到最近使用
    cache.set('c', e()) // 超帽驱逐 b（最久未访问），a 保留
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })

  it('delete 清除指定 session 条目', () => {
    const cache = new HistoryRebuildCache()
    cache.set('s', { leafId: 'l', messages: [], truncated: false })
    cache.delete('s')
    expect(cache.get('s')).toBeUndefined()
  })

  // ── B8：单条目字节帽（memory-leak-remediation §3.3-B8 候选 A）──

  it('B8：单条目超字节帽不入缓存（「缓存从未存在」退化）；帽下正常缓存', () => {
    // 字节帽注入 256B：单条 msg 序列化 ≈110B 在帽内；content 加长到 200B 后即超限
    const cache = new HistoryRebuildCache(8, 256)
    const bigMsg = { ...msg('e1'), content: 'x'.repeat(200) }
    cache.set('big', { leafId: 'l', messages: [bigMsg], truncated: false })
    expect(cache.size).toBe(0)
    expect(cache.get('big')).toBeUndefined()

    cache.set('small', { leafId: 'l', messages: [msg('e1')], truncated: false })
    expect(cache.get('small')).toBeDefined()
  })

  it('B8：超限写入同时摘除既有条目（防冻结基线：历史只增不减，保留旧条目会让增量 delta 从旧叶子无界增长）', () => {
    const cache = new HistoryRebuildCache(8, 256)
    cache.set('s', { leafId: 'l1', messages: [msg('e1')], truncated: false })
    expect(cache.size).toBe(1)

    const bigMsg = { ...msg('e2'), content: 'y'.repeat(200) }
    cache.set('s', { leafId: 'l2', messages: [bigMsg], truncated: false }) // 增量合并后超限

    expect(cache.get('s')).toBeUndefined() // 旧条目也被摘除，不冒充新基线
    expect(cache.size).toBe(0)
  })
})

// ── 单元：mergeIncrementalMessages（D6-3 piEntryId 去重）────────

describe('mergeIncrementalMessages', () => {
  it('同 piEntryId 跳过（不重复），新 piEntryId 追加尾部', () => {
    const cached = [msg('e1'), msg('e2')]
    const incremental = [msg('e2'), msg('e3')] // e2 已在缓存（compact/异常时序的重复兜底）
    const merged = mergeIncrementalMessages(cached, incremental)
    expect(merged.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e3'])
    // 不修改入参
    expect(cached).toHaveLength(2)
    expect(incremental).toHaveLength(2)
  })

  it('无 piEntryId 的增量消息防御性追加（宁可重复不可丢消息）', () => {
    const cached = [msg('e1')]
    const noId = { id: 'm-x', role: 'user' as const, content: 'x', status: 'complete' as const, timestamp: 1 }
    const merged = mergeIncrementalMessages(cached, [noId])
    expect(merged).toHaveLength(2)
  })

  it('幂等：同批增量重复合并无副作用', () => {
    const cached = [msg('e1')]
    const inc = [msg('e2')]
    const once = mergeIncrementalMessages(cached, inc)
    const twice = mergeIncrementalMessages(once, inc)
    expect(twice.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
  })
})

// ── 集成：SessionService.getHistory 三分支（D6 + R-12 + D6-4）────

describe('SessionService.getHistory —— D6 历史增量', () => {
  it('① 首次全量（无 since）→ 第二次带 since 增量且增量条目 < 全量，合并后缓存更新', async () => {
    // 首次：全量 5 条，leafId=leaf-1；第二次：since 增量 2 条（<5），leafId=leaf-2。
    // e6.parentId=leaf-1 满足 Fix-2 不变量（正常 append：delta 首条 parent = 缓存 leafId）
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1'), entry('e2'), entry('e3'), entry('e4'), entry('e5')], leafId: 'leaf-1' } },
      { data: { entries: [entry('e6', 'leaf-1'), entry('e7', 'e6')], leafId: 'leaf-2' } },
    ])

    const first = await svc.getHistory('s1')
    expect(first.messages).toHaveLength(5)
    expect(first.truncated).toBe(false)
    expect(calls[0]?.since).toBeUndefined() // 首次全量无 since

    const second = await svc.getHistory('s1')
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'])
    expect(second.truncated).toBe(false)
    // 第二次带 since=上次 leafId（增量窗口 2 条 < 全量 5 条）
    expect(calls[1]?.since).toBe('leaf-1')
    expect(second.messages).toHaveLength(7) // 5 缓存 + 2 增量（piEntryId 去重合并）
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
  })

  it('② R-12：增量空 entries 短路——直接返回缓存，不走尾读 fallback，getEntries 只调一次', async () => {
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-1' } },
      { data: { entries: [], leafId: 'leaf-1' } }, // 空增量 = leafId 未变 = 缓存新鲜
    ])

    await svc.getHistory('s2')
    const second = await svc.getHistory('s2')
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(second.truncated).toBe(false)
    expect(calls[1]?.since).toBe('leaf-1')
    expect(getHistoryTailFromFile).not.toHaveBeenCalled() // R-12：短路，不走尾读
  })

  it('② R-12（全量侧）：无缓存 + pi 返回空 entries → 返回空列表，不走尾读', async () => {
    const { svc } = makeService([{ data: { entries: [], leafId: null } }])
    const result = await svc.getHistory('s3')
    expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
  })

  it('③ D6-4：增量 "Entry not found" → 丢缓存 → 全量重拉并覆盖缓存', async () => {
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1')], leafId: 'leaf-1' } },
      new Error('Entry not found: leaf-1'), // since 失效（防御场景：缓存跨 pi 进程存活）
      { data: { entries: [entry('e1'), entry('e2'), entry('e3')], leafId: 'leaf-3' } }, // 全量重拉
      { data: { entries: [entry('e4', 'leaf-3')], leafId: 'leaf-4' } }, // 验证缓存已被全量结果覆盖（新基线 leaf-3）
    ])

    await svc.getHistory('s4') // 全量 → 缓存 {leaf-1, [e1]}
    const afterFallback = await svc.getHistory('s4') // Entry not found → 全量重拉 → {leaf-3, [e1,e2,e3]}
    expect(afterFallback.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e3'])
    expect(calls[1]?.since).toBe('leaf-1')
    expect(calls[2]?.since).toBeUndefined() // fallback 是全量（无 since）
    expect(getHistoryTailFromFile).not.toHaveBeenCalled() // fallback 是全量重拉，不是尾读

    // 缓存基线已更新为 leaf-3：下次走 since=leaf-3 增量
    const third = await svc.getHistory('s4')
    expect(calls[3]?.since).toBe('leaf-3')
    expect(third.messages).toHaveLength(4)
  })

  it('其他错误（非 Entry not found）→ 尾读降级，缓存不动（下次重试仍走 since）', async () => {
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1')], leafId: 'leaf-1' } },
      new Error('RPC command "get_entries" timed out after 60000ms'),
      { data: { entries: [entry('e2')], leafId: 'leaf-2' } }, // 缓存未丢：仍以 leaf-1 为基线走增量
    ])

    await svc.getHistory('s5')
    const degraded = await svc.getHistory('s5')
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1) // 现状同链降级（尾读）
    expect(degraded.truncated).toBe(true) // 尾读路径的截断标志（mock 尾读返回 truncated:true）
    expect(calls[1]?.since).toBe('leaf-1')

    // 缓存未被尾读结果覆盖：下次 getHistory 仍走 since 增量（基线还是 leaf-1）
    await svc.getHistory('s5')
    expect(calls[2]?.since).toBe('leaf-1')
  })

  it('⑤ lastLeafId 生命周期：removeSessionEntry（session 删除/pi 退出汇聚点）清除缓存 → 下次全量', async () => {
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1')], leafId: 'leaf-1' } },
      { data: { entries: [entry('e2')], leafId: 'leaf-2' } }, // 清除后的全量（脚本顺序：清后再 getHistory）
    ])

    await svc.getHistory('s6') // 全量 → 缓存 leaf-1
    expect(calls[0]?.since).toBeUndefined()

    svc.removeSessionEntry('s6') // pi 进程退出/删除汇聚点 → 缓存清除

    const after = await svc.getHistory('s6') // 无缓存 → 全量
    expect(calls[1]?.since).toBeUndefined()
    expect(after.messages.map((m) => m.piEntryId)).toEqual(['e2'])
  })

  it('离线路径（无 RPC client）：走尾读，不读不写缓存', async () => {
    // pm.getClient 返回 undefined 的独立环境
    const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
    const pm = { onSessionExit: vi.fn(), getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const svc = new SessionService(
      pm, broker,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/test', {} as never, {} as never,
      { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
      { pruneStaleCache: vi.fn() } as never, {} as never,
    )
    const result = await svc.getHistory('s-offline')
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ messages: [], truncated: true, loadedTurns: 0, totalTurnsEstimate: 0 })
  })

  it('Fix-2：delta 首条 parentId ≠ 缓存 leafId（branch）→ 丢缓存全量重拉，不合出混合历史', async () => {
    // pi append-only + branch（extension navigateTree）后：since=旧 leaf 不报 "Entry not found"，
    // 但新分支首条 entry 的 parentId 是 branch 点（e0）而非旧 leaf（e2）→ 不变量检测 → 全量
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1'), entry('e2')], leafId: 'e2' } }, // 全量，缓存 {e2, [e1,e2]}
      { data: { entries: [entry('b1', 'e0'), entry('b2', 'b1')], leafId: 'b2' } }, // 增量：head parentId=e0 ≠ e2
      { data: { entries: [entry('e1'), entry('e2'), entry('b1'), entry('b2')], leafId: 'b2' } }, // 全量重拉（新分支完整历史）
    ])

    await svc.getHistory('s-branch')
    const second = await svc.getHistory('s-branch')

    expect(calls[1]?.since).toBe('e2') // 第二拍确实走了增量（since 传递正确）
    expect(calls[2]?.since).toBeUndefined() // 不变量 violation → 丢缓存 → 全量重拉
    // 返回的是全量重拉结果（新分支权威视图），不是「缓存老分支尾 + 新分支」的拼接
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'b1', 'b2'])
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()

    // 缓存基线已被全量结果覆盖：下次走 since=b2 增量
    // （不需要第三次脚本——空 delta 短路即证明 since=b2 传递；此处直接断言第三次调用参数）
  })

  it('Fix-5：并发 getHistory 复用同一 inflight——getEntries 只调一次，两调用结果一致', async () => {
    // 脚本只有 1 个响应：若无 inflight 复用，第二个并发调用会 script exhausted reject
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1'), entry('e2')], leafId: 'e2' } },
    ])

    const [a, b] = await Promise.all([svc.getHistory('s-race'), svc.getHistory('s-race')])
    expect(calls).toHaveLength(1)
    expect(a).toEqual(b)
    expect(a.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
  })
})

// ── 集成：增量窗口语义（W20 review Fix-1/7，真实 rebuildHistoryFromEntries）────

describe('SessionService.getHistory —— 增量窗口语义（真实重建，不 mock rebuildHistoryFromEntries）', () => {
  /** 真实 pi message entry（type:'message'，透传 message 体）。 */
  function messageEntry(id: string, parentId: string | null, message: unknown): PiSessionEntry {
    return { type: 'message', id, parentId, timestamp: '2026-08-16T00:00:00.000Z', message } as unknown as PiSessionEntry
  }

  it('Fix-1：delta 以 toolResult 开头 → 孤儿回填到缓存 assistant 的 toolCall，输出不丢', async () => {
    // 场景：后台 session 生成中 getHistory 写缓存，leafId 切在 assistant(toolCalls) 与其
    // toolResults 之间（缓存 leafId=e2，但 t1 的 toolResult 尚未 append）→ 下次增量窗口
    // 以 toolResult(e3) 开头 → convertPiHistory 窗口局部配对失败 → 无 Fix-1 时 t1 永久无输出
    const userMsg = { role: 'user', content: [{ type: 'text', text: 'question' }], timestamp: 1 }
    const assistantToolCallMsg = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }],
      timestamp: 2,
    }
    const toolResultMsg = {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'RESULT-OUTPUT' }],
      timestamp: 3,
    }
    const assistantTextMsg = { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 4 }

    const { svc } = makeService([
      // 全量：user(e1) + assistant(e2, toolCall t1 无输出)，leafId=e2（切点场景基线）
      { data: { entries: [messageEntry('e1', null, userMsg), messageEntry('e2', 'e1', assistantToolCallMsg)], leafId: 'e2' } },
      // 增量：toolResult(e3) 开头（head parentId=e2 满足 Fix-2 不变量）+ assistant(e4)
      { data: { entries: [messageEntry('e3', 'e2', toolResultMsg), messageEntry('e4', 'e3', assistantTextMsg)], leafId: 'e4' } },
    ], { realRebuild: true })

    await svc.getHistory('s-fix1')
    const second = await svc.getHistory('s-fix1')

    // 合并结果：user(e1) + assistant(e2) + assistant(e4)（toolResult 不产独立消息）
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e4'])
    // 核心断言：缓存中 assistant(e2) 的 toolCall t1 拿到了窗口孤儿回填的输出
    const assistant = second.messages.find((m) => m.piEntryId === 'e2')
    expect(assistant?.toolCalls).toHaveLength(1)
    expect(assistant?.toolCalls?.[0]?.id).toBe('t1')
    expect(assistant?.toolCalls?.[0]?.output).toBe('RESULT-OUTPUT')
  })

  it('Fix-7：delta 以 compaction entry 开头 → compaction 系统消息正常并入缓存', async () => {
    const userMsg = { role: 'user', content: [{ type: 'text', text: 'question' }], timestamp: 1 }
    const assistantTextMsg = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 }
    const compactionEntry = {
      type: 'compaction',
      id: 'e2',
      parentId: 'e1',
      timestamp: '2026-08-16T00:00:01.000Z',
      summary: 'compacted-history',
      tokensBefore: 1000,
    } as unknown as PiSessionEntry

    const { svc } = makeService([
      { data: { entries: [messageEntry('e1', null, userMsg)], leafId: 'e1' } },
      { data: { entries: [compactionEntry, messageEntry('e3', 'e2', assistantTextMsg)], leafId: 'e3' } },
    ], { realRebuild: true })

    await svc.getHistory('s-fix7')
    const second = await svc.getHistory('s-fix7')

    // user + compaction 系统消息 + assistant（compaction 重建消息无 piEntryId → 防御追加）
    expect(second.messages).toHaveLength(3)
    expect(second.messages[0]?.piEntryId).toBe('e1')
    const compactionMsg = second.messages[1]
    expect(compactionMsg?.role).toBe('system')
    expect(compactionMsg?.content).toBe('compacted-history')
    expect(compactionMsg?.compactionSummary?.tokensBefore).toBe(1000)
    expect(second.messages[2]?.piEntryId).toBe('e3')
  })
})

// ── 集成：SessionHistoryReader B8 字节帽 + reclaim 驱逐（memory-leak-remediation §3.3-B8）──

describe('SessionHistoryReader —— B8 字节帽 + reclaim 驱逐', () => {
  /**
   * 直构 SessionHistoryReader（SUT = reader 编排 + 注入字节帽的缓存实例；
   * mock 分层同 makeService：getEntries 脚本出队 + rebuildHistoryFromEntries 直通）。
   */
  function makeReader(
    script: Array<{ data?: { entries: PiSessionEntry[]; leafId: string | null } } | Error>,
    opts?: { capBytes?: number },
  ) {
    const calls: GetEntriesCall[] = []
    const client = {
      getEntries: vi.fn(async (since?: string) => {
        calls.push({ since })
        const step = script.shift()
        if (step instanceof Error) throw step
        if (!step) throw new Error('getEntries script exhausted')
        return step
      }),
    } as unknown as IPiEngine
    const pm = {
      onSessionExit: vi.fn(),
      getClient: vi.fn(() => client),
    } as unknown as IProcessManager
    const sessionStore = {
      rebuildHistoryFromEntries: vi.fn((entries: PiSessionEntry[]) => ({
        messages: entries.map((e) => msg(e.id)),
        orphanToolResults: [],
      })),
      scanSessions: vi.fn(() => []),
      extractSessionOutcome: vi.fn(() => null),
      persistSessionEnd: vi.fn(),
    } as never
    const cache = new HistoryRebuildCache(8, opts?.capBytes)
    const reader = new SessionHistoryReader({ pm, sessionStore }, cache)
    return { reader, cache, calls }
  }

  it('B8-A：超限 session 不缓存——返回值不受影响，重进两次都走全量（无 since）', async () => {
    // 字节帽注入 16B：单条 msg 序列化 > 16B，两条必超限；返回值照常全量窗口
    const full = { data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-1' } }
    const { reader, cache, calls } = makeReader([full, { ...full }], { capBytes: 16 })

    const first = await reader.getHistory('s-cap')
    expect(first.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2']) // 返回值不受影响
    expect(cache.size).toBe(0) // 超限不入缓存

    const second = await reader.getHistory('s-cap') // 重进：无缓存可用 → 全量重建
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(calls.map((c) => c.since)).toEqual([undefined, undefined]) // 两次都无 since
    expect(cache.size).toBe(0)
    expect(getHistoryTailFromFile).not.toHaveBeenCalled() // 全量重建成功，不降级尾读
  })

  it('B8-C：reclaim 驱逐缓存条目——重激活走全量重建并写回新缓存（后续增量命中）', async () => {
    const full = { data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-1' } }
    const { reader, cache, calls } = makeReader([full, { ...full }, { data: { entries: [], leafId: 'leaf-1' } }])

    await reader.getHistory('s-re') // 首次全量 → 写缓存
    expect(cache.size).toBe(1)

    reader.onSessionReclaimed('s-re') // reclaim 驱逐（reclaimManagedSession 经 deps 接线）
    expect(cache.size).toBe(0)
    expect(cache.get('s-re')).toBeUndefined()

    const second = await reader.getHistory('s-re') // 重激活：无缓存 → 全量 → 写回新缓存
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(cache.size).toBe(1) // 全量重建写回

    const third = await reader.getHistory('s-re') // 后续：新缓存生效（since 增量 + 空 delta 短路）
    expect(calls.map((c) => c.since)).toEqual([undefined, undefined, 'leaf-1'])
    expect(third.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
  })
})
