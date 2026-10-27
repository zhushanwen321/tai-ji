import { IPiEngine, type IProcessManager } from '../../ports/pi-engine.js';
import type { ISessionStore } from '../../ports/session.js';
import { getHistoryTailFromFile } from '../../session-history.js';
import { HistoryRebuildCache, SessionHistoryReader, applyHistoryBudgetWindow } from '../history-rebuild-cache.js';
import { SessionEntryRemovalOrchestrator, type SessionEntryRemovalDeps } from '../session-entry-removal.js';
import { countSessionMessagesInFile } from '../session-message-count.js';
import type { IManagedSessionView } from '../types.js';
import { HISTORY_BUDGET, type CrashJournalEvent, type Message, type SessionSummary } from '@taiji/shared';
import { createZcodeEngine, registerZcodeEngine, routeEngine } from '@zhushanwen/subagent-core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/session/__tests__/history-budget-window.test.ts
// ======================================================================

// ── fixture 工厂 ───────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
let seq = 0

function userMsg(text = 'u'): Message {
  return { id: `m-${seq++}`, role: 'user', content: text, status: 'complete', timestamp: 1 }
}

function assistantMsg(text = 'a'): Message {
  return { id: `m-${seq++}`, role: 'assistant', content: text, status: 'complete', timestamp: 2 }
}

/** 带 toolCall 的 assistant + 对应 toolResult（同 turn 内的 entry 原子组）。 */
function toolTurnPair(toolCallId: string, output: string): Message[] {
  return [
    {
      id: `m-${seq++}`,
      role: 'assistant',
      content: '',
      status: 'complete',
      timestamp: 3,
      toolCalls: [{ id: toolCallId, toolName: 'read', input: { file: 'a.ts' }, output, status: 'completed', startTime: 1, endTime: 2 }],
    },
    { id: `m-${seq++}`, role: 'assistant', content: '', status: 'complete', timestamp: 4, toolCalls: [] },
  ]
}

/** 一个 turn = 1 条 user + 1 条 assistant（小内容）。 */
function smallTurn(text: string): Message[] {
  return [userMsg(text), assistantMsg(`reply-${text}`)]
}


/** 估算单消息 wire 字节（与实现同口径）。 */
function msgBytes(m: Message): number {
  return Buffer.byteLength(JSON.stringify(m), 'utf-8')
}


// ── helper：断言里重建期望值（避免复用同一对象引用造成 toEqual 恒真） ──
function userMsgDefined(content: string): Message {
  return { id: expect.any(String), role: 'user', content, status: 'complete', timestamp: expect.any(Number) } as unknown as Message
}

function assistantMsgDefined(content: string): Message {
  return { id: expect.any(String), role: 'assistant', content, status: 'complete', timestamp: expect.any(Number) } as unknown as Message
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('history-budget-window', () => {
describe('断言①：预算内不截断（truncated:false，A6 回归）', () => {
  it('5 turns 全部入窗（<20 turns 且 <640KB）→ 返回全量、loadedTurns=totalTurnsEstimate', () => {
    const turns = Array.from({ length: 5 }, (_, i) => smallTurn(`t${i}`)).flat()

    const result = applyHistoryBudgetWindow(turns)

    expect(result.truncated).toBe(false)
    expect(result.messages).toEqual(turns) // 全量返回（数组级浅拷贝、内容一致）
    expect(result.loadedTurns).toBe(5)
    expect(result.totalTurnsEstimate).toBe(5)
  })

  it('恰好 20 turns 且字节未超 → 仍不截断（边界内）', () => {
    const turns = Array.from({ length: HISTORY_BUDGET.RECENT_TURNS }, (_, i) => smallTurn(`t${i}`)).flat()

    const result = applyHistoryBudgetWindow(turns)

    expect(result.truncated).toBe(false)
    expect(result.messages).toEqual(turns)
    expect(result.loadedTurns).toBe(HISTORY_BUDGET.RECENT_TURNS)
  })

  it('窗口扩到最老 turn 时带上前导孤儿段（startIdx=0，不误报 truncated）', () => {
    // 病态前导：首条非 user（如增量合并边界的孤儿 toolResult 派生视图）
    const orphan = assistantMsg('orphan-tail')
    const turns = Array.from({ length: 3 }, (_, i) => smallTurn(`t${i}`)).flat()
    const all = [orphan, ...turns]

    const result = applyHistoryBudgetWindow(all)

    expect(result.truncated).toBe(false)
    expect(result.messages[0]).toEqual(orphan)
  })
})
describe('断言②：超预算截断（truncated:true + loadedTurns/totalTurnsEstimate 正确）', () => {
  it('30 turns（turn 数超 20）→ 最近 20 turns、truncated:true、totalTurnsEstimate=30', () => {
    const turns = Array.from({ length: 30 }, (_, i) => smallTurn(`t${i}`)).flat()

    const result = applyHistoryBudgetWindow(turns)

    expect(result.truncated).toBe(true)
    expect(result.loadedTurns).toBe(20)
    expect(result.totalTurnsEstimate).toBe(30)
    // 窗口起点 = 第 11 个 turn 的 user（从尾数第 20 个 turn 边界，turn 编号 t10）
    expect(result.messages[0]).toMatchObject({ role: 'user', content: 't10' })
    expect(result.messages).toHaveLength(20 * 2)
    // 恒含最新 turn（尾部不丢）
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'reply-t29' })
  })

  it('字节预算截断：20+ turns 但每 turn ~100KB → 只放最近 6 turns（640KB 帽）', () => {
    const pad = 'x'.repeat(100 * 1024)
    const turns = Array.from({ length: 12 }, (_, i) => [userMsg(`big-${i}`), assistantMsg(pad)]).flat()

    const result = applyHistoryBudgetWindow(turns)

    expect(result.truncated).toBe(true)
    // 从新到旧累加：每 turn ≈ 100KB，640KB 帽容纳 6 个 turn（第 7 个超）
    expect(result.loadedTurns).toBe(6)
    // 6 turn 窗口总字节 ≤ 预算（实现精确逐 turn 计入）
    const windowBytes = result.messages.reduce((acc, m) => acc + msgBytes(m), 0)
    expect(windowBytes).toBeLessThanOrEqual(HISTORY_BUDGET.MAX_BYTES)
    // 窗口 = 最新 6 个 turn（t6..t11）
    expect(result.messages[0]).toMatchObject({ role: 'user', content: 'big-6' })
    expect(result.totalTurnsEstimate).toBe(12)
  })

  it('40 turns 大文件 → totalTurnsEstimate 精确（全量 Message[] 上计数）', () => {
    const turns = Array.from({ length: 40 }, (_, i) => smallTurn(`t${i}`)).flat()
    const result = applyHistoryBudgetWindow(turns)
    expect(result.totalTurnsEstimate).toBe(40)
    expect(result.loadedTurns).toBe(20)
  })
})
describe('断言③：单 turn 超预算完整放行', () => {
  it('唯一 turn 自身超 640KB → 完整放行、truncated:false、warn 反映超出', () => {
    const big = 'x'.repeat(700 * 1024)
    const turn = [userMsg('huge'), assistantMsg(big)]

    const result = applyHistoryBudgetWindow(turn)

    // 单 turn 豁免字节条件：完整返回（对话可见性连续），无更早历史 → truncated:false
    expect(result.messages).toEqual(turn)
    expect(result.truncated).toBe(false)
    expect(result.loadedTurns).toBe(1)
    expect(result.totalTurnsEstimate).toBe(1)
  })

  it('最新 turn 超预算 + 更早 2 个小 turn → 窗口只含大 turn、truncated:true', () => {
    const big = 'x'.repeat(700 * 1024)
    const messages = [...smallTurn('old-1'), ...smallTurn('old-2'), userMsg('huge'), assistantMsg(big)]

    const result = applyHistoryBudgetWindow(messages)

    expect(result.truncated).toBe(true)
    expect(result.loadedTurns).toBe(1)
    expect(result.totalTurnsEstimate).toBe(3)
    // 大 turn 完整放行（不因超预算被切）
    expect(result.messages).toEqual([userMsgDefined('huge'), assistantMsgDefined(big)])
    // 字节统计如实反映超出：窗口字节 > 预算（warn 日志路径）
    const windowBytes = result.messages.reduce((acc, m) => acc + msgBytes(m), 0)
    expect(windowBytes).toBeGreaterThan(HISTORY_BUDGET.MAX_BYTES)
  })
})
describe('断言④：turn 内 entry 不切分（entry 原子性）', () => {
  it('超预算截断后窗口边界恒落在 turn 起点：toolCall 与 toolResult 同 turn 不拆', () => {
    // turn1..turn9 小；最新 turn 含 toolCall+toolResult + 大输出（自身超预算也被放行）
    const messages: Message[] = []
    for (let i = 1; i <= 9; i++) messages.push(...smallTurn(`t${i}`))
    const bigOutput = 'o'.repeat(700 * 1024)
    messages.push(userMsg('tool-turn'))
    messages.push(...toolTurnPair('tc-atomic-1', bigOutput))

    const result = applyHistoryBudgetWindow(messages)

    expect(result.truncated).toBe(true)
    expect(result.loadedTurns).toBe(1)
    // 窗口 = 完整最新 turn：toolCall（含大 output）与后续消息同在，不被从中间切开
    const withTool = result.messages.find((m) => m.toolCalls?.length)
    expect(withTool?.toolCalls?.[0]).toMatchObject({ id: 'tc-atomic-1', output: bigOutput })
  })

  it('turn 数截断：窗口起点必为 user 消息（切在 turn 边界，不落在 turn 中间）', () => {
    const messages: Message[] = []
    for (let i = 0; i < 25; i++) messages.push(...smallTurn(`t${i}`))

    const result = applyHistoryBudgetWindow(messages)

    expect(result.truncated).toBe(true)
    expect(result.messages[0].role).toBe('user') // 窗口起点 = turn 边界
    // 窗口内 turn 数恰好 20，每 turn 的 user/assistant 相邻完整
    expect(result.messages).toHaveLength(40)
    for (let i = 0; i < 40; i += 2) {
      expect(result.messages[i].role).toBe('user')
      expect(result.messages[i + 1].role).toBe('assistant')
    }
  })
})
describe('病态输入兜底', () => {
  it('空数组 → 全零结果', () => {
    expect(applyHistoryBudgetWindow([])).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
  })

  it('无 user 消息（纯 assistant/custom 窗口）→ 整段视为一个 turn 完整放行', () => {
    const messages = [assistantMsg('a1'), assistantMsg('a2')]
    const result = applyHistoryBudgetWindow(messages)
    expect(result.messages).toEqual(messages)
    expect(result.truncated).toBe(false)
    expect(result.loadedTurns).toBe(1)
    expect(result.totalTurnsEstimate).toBe(1)
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/history-rebuild.test.ts
// ======================================================================

vi.mock('../../session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-history.js')>()
  return { ...actual, // [u6] getHistoryFromFilePath 不再被 history-rebuild-cache 消费（getFullHistory 退役），
  // mock 同点移除；①档函数本体保留（session-records 的 subagent/agentcall 通路消费）。
  getHistoryTailFromFile: vi.fn(async () => ({ messages: [{ id: 'tail-1', role: 'user', content: 'tail', status: 'complete', timestamp: 1 } as Message], truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })), }
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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('history-rebuild', () => {
// session-history 模块级 mock：调用计数跨用例累积，前置清零（r1-S16 尾读用例引入后
// 「not.toHaveBeenCalled」类断言会被先前用例的历史调用打穿）
beforeEach(() => {
  vi.mocked(getHistoryTailFromFile).mockClear()
})
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

  it('增量 Entry not found：丢缓存 → 全量重新拉取（D6-4 自愈）', async () => {
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
// ════════════════════════════════════════════════════════════════════
// 活跃路径裁剪接入（message-revoke U6a）：调用点契约 = 仅全量重建裁剪、增量不裁剪
// ════════════════════════════════════════════════════════════════════
// get_entries 返回全文件 entries + leafId；全量重建路径（rebuildFullHistoryAndCache）在
// 调用点预过滤（port 签名不含 leafId，预过滤与 rebuildHistoryFromEntries 第三参等价——
// 同一 computeActivePathEntries SSOT）。缓存基线 = 完整活跃路径派生视图。

describe('活跃路径裁剪接入（message-revoke U6a）', () => {
  it('全量重建调用点：有分支 entries + leafId → rebuild 收到裁剪后 entries，旧分支不进缓存基线', async () => {
    const { reader, client, rebuild } = makeReader()
    // 单根链式树：e1(root) → e2(旧分支尾) / b1(e1) → b2(新分支尾，leafId)
    client.getEntries.mockResolvedValue({
      data: { entries: [entry('e1', null), entry('e2', 'e1'), entry('b1', 'e1'), entry('b2', 'b1')], leafId: 'b2' },
    })
    const result = await reader.getHistory('s1')

    // rebuild（port 直通 mock）收到的是裁剪后活跃路径子集（e2 旧分支被滤）
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(rebuild).toHaveBeenCalledWith([entry('e1', null), entry('b1', 'e1'), entry('b2', 'b1')], null)
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1', 'm-b1', 'm-b2'])
  })

  it('全量重建调用点：leafId null（缺省）→ rebuild 收到全量 entries（现行为回归）', async () => {
    const { reader, client, rebuild } = makeReader()
    const full = [entry('e1', null), entry('e2', 'e1')]
    client.getEntries.mockResolvedValue({ data: { entries: full, leafId: null } })
    await reader.getHistory('s1')
    expect(rebuild).toHaveBeenCalledWith(full, null)
  })

  it('增量路径不裁剪（反直觉契约锚）：delta 条目原样进 rebuild，不做 leafId 回溯', async () => {
    // 契约（设计 D3/U6 定死）：delta 是活跃路径的后缀切片（Fix-2 不变量保证首条 parent =
    // 缓存 leafId），构造性全在活跃路径上；裁剪是「回溯到根」的全树语义，在窗口切片上
    // 执行会把窗口边界误当树边界。canary 构造：delta 内混一条 parent 指向集合外的条目
    // （d2.parent=missing）——若增量被误接 leafId 裁剪，d2 的回溯链在窗口内断裂会把 d1
    // 误滤（链 missing→d2 只含 d2）；不裁剪时 d1/d2 全部进入合并。
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null), entry('e2', 'e1')], leafId: 'e2' } })
    await reader.getHistory('s1') // 建缓存 {leafId: e2}
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('d1', 'e2'), entry('d2', 'missing')], leafId: 'd2' } })
    const second = await reader.getHistory('s1')
    // 增量条目全量并入（d1 不因窗口内回溯断裂被滤）
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'd1', 'd2'])
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/history-rebuild-clearall.test.ts
// ======================================================================

function entry_m2(): { leafId: string | null; messages: []; truncated: boolean } {
  return { leafId: 'leaf-1', messages: [], truncated: false }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('history-rebuild-clearall', () => {
describe('HistoryRebuildCache.clearAll（u7c memory-relief 可回收物 ①）', () => {
  it('清空全部条目并返回清除条目数', () => {
    const cache = new HistoryRebuildCache()
    cache.set('a', entry_m2())
    cache.set('b', entry_m2())
    cache.set('c', entry_m2())

    expect(cache.clearAll()).toBe(3)
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBeUndefined()
  })

  it('空缓存 clearAll 返回 0（幂等，重复 relief 不误报）', () => {
    const cache = new HistoryRebuildCache()
    expect(cache.clearAll()).toBe(0)
    cache.set('a', entry_m2())
    expect(cache.clearAll()).toBe(1)
    expect(cache.clearAll()).toBe(0)
  })
})
describe('SessionHistoryReader.clearHistoryCache 透传出口（组合根 onRelief 接线点）', () => {
  it('出口在场且转发 clearAll（窄注入 deps 仅类型约束，clearAll 不触达 deps）', () => {
    const reader = new SessionHistoryReader({
      pm: {} as IProcessManager,
      sessionStore: {} as ISessionStore,
    })
    expect(reader.clearHistoryCache()).toBe(0)
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-message-count.test.ts
// ======================================================================

let base: string | null = null


function fixturePath(name: string): string {
  if (!base) base = mkdtempSync(join(tmpdir(), 'taiji-session-message-count-'))
  return join(base, name)
}


/** pi 1.0 FileEntry 形态的最小 JSONL 行构造（SessionHeader / SessionEntry 联合各成员） */
const lines = {
  header: { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-10-12T00:00:00Z', cwd: '/p' },
  userMessage: { type: 'message', id: 'e1', parentId: null, timestamp: 't', message: { role: 'user', content: '你好', timestamp: 1 } },
  assistantMessage: { type: 'message', id: 'e2', parentId: 'e1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: '回复' }], model: 'm', provider: 'p', usage: {}, timestamp: 2 } },
  toolResultMessage: { type: 'message', id: 'e3', parentId: 'e2', timestamp: 't', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 } },
  systemMessage: { type: 'message', id: 'e4', parentId: 'e2', timestamp: 't', message: { role: 'system', content: 'sys', timestamp: 4 } },
  thinkingLevelChange: { type: 'thinking_level_change', id: 'e5', parentId: 'e2', timestamp: 't', thinkingLevel: 'high' },
  modelChange: { type: 'model_change', id: 'e6', parentId: 'e2', timestamp: 't', provider: 'p', modelId: 'm2' },
  usage: { type: 'usage', id: 'e7', parentId: 'e2', timestamp: 't', kind: 'cache_warm', provider: 'p', model: 'm', usage: {} },
  compaction: { type: 'compaction', id: 'e8', parentId: 'e2', timestamp: 't', summary: '摘要', firstKeptEntryId: 'e1', tokensBefore: 100 },
  sessionInfo: { type: 'session_info', id: 'e9', parentId: null, timestamp: 't', name: '我的会话' },
  custom: { type: 'custom', id: 'e10', parentId: 'e2', timestamp: 't', customType: 'x', data: {} },
  customMessage: { type: 'custom_message', id: 'e11', parentId: 'e2', timestamp: 't', customType: 'x', content: 'ctx', display: false },
  contextEdit: { type: 'context_edit', id: 'e12', parentId: 'e2', timestamp: 't', targetId: 'e1', replacement: null },
  label: { type: 'label', id: 'e13', parentId: null, timestamp: 't', targetId: 'e1', label: '书签' },
} as const


function jsonlOf(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-count', () => {
afterEach(() => {
  if (base) {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    base = null
  }
})
describe('countSessionMessagesInFile 计数口径', () => {
  it('混合条目：只计 user/assistant message entry（header/toolResult/system/其余 entry 类型不计）', async () => {
    const file = fixturePath('mixed.jsonl')
    writeFileSync(file, jsonlOf(
      lines.header,
      lines.userMessage,
      lines.assistantMessage,
      lines.toolResultMessage,
      lines.systemMessage,
      lines.thinkingLevelChange,
      lines.modelChange,
      lines.usage,
      lines.compaction,
      lines.sessionInfo,
      lines.custom,
      lines.customMessage,
      lines.contextEdit,
      lines.label,
    ))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(2)
  })

  it('多轮交替消息：每条 user/assistant 各计 1', async () => {
    const file = fixturePath('turns.jsonl')
    writeFileSync(file, jsonlOf(
      lines.header,
      lines.userMessage,
      lines.toolResultMessage,
      lines.assistantMessage,
      lines.userMessage,
      lines.assistantMessage,
    ))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(4)
  })

  it('损坏行（非法 JSON / 半写尾行）跳过不中断计数', async () => {
    const file = fixturePath('corrupted.jsonl')
    writeFileSync(file, jsonlOf(lines.header, lines.userMessage) + '{"type":"message","id":"half",\n' + jsonlOf(lines.assistantMessage))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(2)
  })

  it('空行与空白行不计（合法 JSONL 形态容忍）', async () => {
    const file = fixturePath('blank-lines.jsonl')
    writeFileSync(file, '\n' + JSON.stringify(lines.userMessage) + '\n\n   \n' + JSON.stringify(lines.assistantMessage) + '\n')

    await expect(countSessionMessagesInFile(file)).resolves.toBe(2)
  })

  it('纯 header 文件（pi 延迟写入后未产生消息的合法形态）→ 0', async () => {
    const file = fixturePath('header-only.jsonl')
    writeFileSync(file, jsonlOf(lines.header))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(0)
  })
})
describe('countSessionMessagesInFile 失败语义', () => {
  it('文件不存在（pi 延迟写入窗口）→ 0 不报错', async () => {
    const file = fixturePath('not-exist.jsonl')
    rmSync(file, { force: true }) // 确保不存在

    await expect(countSessionMessagesInFile(file)).resolves.toBe(0)
  })

  it('目录路径（EISDIR 读失败）→ 上抛（错误回传 renderer 占位，非 ENOENT 归 0）', async () => {
    const dir = fixturePath('a-dir.jsonl')
    mkdirSync(dir, { recursive: true })

    await expect(countSessionMessagesInFile(dir)).rejects.toThrow()
  })
})
describe('countSessionMessagesInFile 大文件流式读', () => {
  it('多行 fixture（6000 entry）流式计数正确（实现侧 createReadStream+readline 恒定内存）', async () => {
    const file = fixturePath('large.jsonl')
    const parts: string[] = [JSON.stringify(lines.header)]
    // 2000 轮对话 = 4000 条计数消息 + 2000 条 toolResult（不计）+ header
    for (let i = 0; i < 2000; i++) {
      parts.push(JSON.stringify(lines.userMessage))
      parts.push(JSON.stringify(lines.toolResultMessage))
      parts.push(JSON.stringify(lines.assistantMessage))
    }
    writeFileSync(file, parts.join('\n') + '\n')

    await expect(countSessionMessagesInFile(file)).resolves.toBe(4000)
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-entry-removal.test.ts
// ======================================================================

// ── Mocks（路径相对本测试文件，解析后与被测模块的 import 同一文件）──

const journalAppends: CrashJournalEvent[] = []

vi.mock('../../../infra/crash-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/crash-journal.js')>()
  return { ...actual, getCrashJournal: () => ({ append: (e: CrashJournalEvent) => { journalAppends.push(e) } }), }
})


vi.mock('../background-task-reaper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../background-task-reaper.js')>()
  return {
    ...actual,
    reapSessionBackgroundTasks: vi.fn(async () => undefined),
  }
})


vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/mock/pi-agent-dir', }
})


function makeSession(id: string): IManagedSessionView {
  return {
    id,
    cwd: '/test',
    label: id,
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
  } as unknown as IManagedSessionView
}


function makeDeps(overrides: Partial<SessionEntryRemovalDeps> = {}): SessionEntryRemovalDeps & {
  calls: string[]
  destroyedHandler: ReturnType<typeof vi.fn>
} {
  const sessions = new Map<string, IManagedSessionView>([
    ['s1', makeSession('s1')],
    ['s2', makeSession('s2')],
  ])
  const calls: string[] = []
  const destroyedHandler = vi.fn((summary: SessionSummary) => { calls.push(`destroyed:${summary.id}`) })
  const deps: SessionEntryRemovalDeps = {
    getSession: (id) => sessions.get(id),
    removeEntry: (id) => { sessions.delete(id); calls.push(`removeEntry:${id}`) },
    toSummary: (session) => { calls.push(`toSummary:${session.id}`); return { id: session.id } as unknown as SessionSummary },
    cancelRespawn: (id) => { calls.push(`cancelRespawn:${id}`) },
    clearSessionViewed: (id) => { calls.push(`clearViewed:${id}`) },
    fireOnSessionDelete: (id) => { calls.push(`onDelete:${id}`) },
    getOnSessionDestroyedHandlers: () => [destroyedHandler],
    unwatchBackgroundTasks: (id) => { calls.push(`unwatch:${id}`) },
    disposeHistoryReader: (id) => { calls.push(`disposeHistory:${id}`) },
    disposeTraceSync: (id) => { calls.push(`disposeTrace:${id}`) },
    disposeProjection: (id) => { calls.push(`disposeProjection:${id}`) },
    disposeRecords: (id) => { calls.push(`disposeRecords:${id}`) },
    clearMessageBusSession: (id) => { calls.push(`clearBus:${id}`) },
    ...overrides,
  }
  return { ...deps, calls, destroyedHandler }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-entry-removal', () => {
describe('SessionEntryRemovalOrchestrator 销毁链单步隔离（RT-4#1）', () => {
  beforeEach(() => {
    journalAppends.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('mock 门禁：reaper 必须被 vi.mock 拦截（hermetic 前提，防路径写错静默失效）', async () => {
    const reaperModule = await import('../background-task-reaper.js')
    expect(vi.isMockFunction(reaperModule.reapSessionBackgroundTasks)).toBe(true)
  })

  it('dispose 抛错：该步降级日志+journal，后续步骤继续收敛（removeEntry / 其余 dispose / bus 清理必达）', () => {
    const deps = makeDeps({
      disposeProjection: () => { throw new Error('projection dispose exploded') },
    })
    const orchestrator = new SessionEntryRemovalOrchestrator(deps)

    expect(() => orchestrator.remove('s1')).not.toThrow()

    // 抛错步之前的步骤全部完成
    expect(deps.calls).toContain('toSummary:s1')
    expect(deps.calls).toContain('removeEntry:s1')
    // 抛错步之后的步骤不被打断（终态必达）
    expect(deps.calls).toContain('disposeRecords:s1')
    expect(deps.calls).toContain('clearBus:s1')
    expect(deps.destroyedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
    // 失败落 crash journal（RT-4#1：失败记 journal）
    expect(journalAppends).toContainEqual(expect.objectContaining({
      layer: 'runtime',
      event: 'crash',
      reason: 'destroy-chain-step-failed',
      sessionId: 's1',
    }))
  })

  it('其余 session 不受累：s1 链抛错后，s2 的 remove 全链正常完成', () => {
    const s2Trace: string[] = []
    const deps = makeDeps({
      disposeTraceSync: (id) => {
        if (id === 's1') throw new Error('trace dispose exploded for s1')
        s2Trace.push(id)
      },
    })
    const orchestrator = new SessionEntryRemovalOrchestrator(deps)

    orchestrator.remove('s1')
    orchestrator.remove('s2')

    // s2 全链完成（含抛错步之后的全部步骤）
    expect(s2Trace).toEqual(['s2'])
    expect(deps.calls).toContain('disposeProjection:s2')
    expect(deps.calls).toContain('disposeRecords:s2')
    expect(deps.calls).toContain('clearBus:s2')
    expect(deps.calls).toContain('removeEntry:s2')
    expect(deps.destroyedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }))
  })

  it('toSummary 抛错：destroyedSummary 降级最小形状，条目删除与销毁扇出不被打断', () => {
    const deps = makeDeps({
      toSummary: () => { throw new Error('git reader exploded') },
    })
    const orchestrator = new SessionEntryRemovalOrchestrator(deps)

    expect(() => orchestrator.remove('s1')).not.toThrow()

    expect(deps.calls).toContain('removeEntry:s1')
    // 销毁通知仍发出（最小形状：id + dead 兜底字段，宁发少知不发错）
    expect(deps.destroyedHandler).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1',
      status: 'dead',
      label: 's1',
    }))
    expect(journalAppends).toContainEqual(expect.objectContaining({
      reason: 'destroy-chain-step-failed',
      sessionId: 's1',
    }))
  })

  it('全链无异常：零隔离 journal 行（deleted journal 照常，隔离路径不产生噪音事件）', () => {
    const orchestrator = new SessionEntryRemovalOrchestrator(makeDeps())
    orchestrator.remove('s1')
    // 第 1 步 deleted journal 行恒在（D1 唯一挂点）；无任何 destroy-chain-step-failed 行
    expect(journalAppends).toEqual([
      expect.objectContaining({ layer: 'pi', event: 'deleted', sessionId: 's1' }),
    ])
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/d8-compat.test.ts
// ======================================================================

const FIXTURE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-engine-cli.mjs')


let tmpDir: string

let dataDir: string

const savedEnv = new Map<string, string | undefined>()


function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}


/** fake CLI 直跑（协议往返真实；envEcho 白名单回显供透传断言）。 */
function fakeCliEnvEcho(opts: {
  cliPath?: string
  processEnv?: Record<string, string | undefined>
  engineDataDir: string
}): Promise<Record<string, string | undefined>> {
  const cliPath = opts.cliPath ?? FIXTURE_CLI
  const engine = createZcodeEngine({
    engineDataDir: () => opts.engineDataDir,
    ...(opts.cliPath !== undefined ? { cliPath } : {}),
    ...(opts.processEnv !== undefined ? { processEnv: opts.processEnv } : {}),
  })
  // RemoteEngine.read 的应答是 SessionView 结构断言——fixture 在 read 应答里附
  // envEcho 白名单摘要（initialize 应答与 read 应答共享同一进程 env）。
  // read 前置 ensureConnected → initialize；此处直接取 view 上的 envEcho 附加字段。
  return engine
    .read({ data: { v: 1, engineId: 'zcode', sessionRef: { sessionId: 's-d8' }, adapterVersion: 'd8-test' } })
    .then((view) => (view as unknown as { envEcho?: Record<string, string | undefined> }).envEcho ?? {})
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('d8-compat', () => {
afterEach(() => {
  setEnv('FAKE_READ_MODE', 'ok')
})
// [密闭化] 宿主注入的引擎执行器/发现根（打包态 TaiJi 会话 env：TAIJI_AGENT_ENGINE_NODE
// 指向 Electron 主二进制）会把 hostKindOf 嗅探到 pi-extension 分支——用主二进制当
// node 执行器 spawn fake CLI，进程立即 exit 0 → engine_crashed。测试恒用 standalone
// 语义（PATH node），剥这两个 env（afterAll 经 savedEnv 恢复）。
beforeAll(() => {
  setEnv('TAIJI_AGENT_ENGINE_NODE', undefined)
  setEnv('TAIJI_AGENT_ENGINE_ROOTS', undefined)
})
// cliPath 直接以文件形态被 EngineClient spawn——需要可执行位（运行时自愈，
// 不改 repo 内文件 mode；协议测试文件的拷贝路径已单独 chmod）。
beforeAll(() => {
  fs.chmodSync(FIXTURE_CLI, 0o755)
})
afterAll(async () => {
  for (const [key, value] of savedEnv) setEnv(key, value)
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('W8 D8 兼容公共部分薄壳', () => {
  it('createZcodeEngine 返回 RemoteEngine(zcode)：read 走协议（cliPath 指向 fake CLI）', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
    const engine = createZcodeEngine({ engineDataDir: () => dataDir, cliPath: FIXTURE_CLI })
    expect(engine.id).toBe('zcode')
    const view = await engine.read({
      data: { v: 1, engineId: 'zcode', sessionRef: { sessionId: 's-1' }, adapterVersion: 'd8-test' },
    })
    expect(view.turns[0]?.text).toBe('fake turn') // 协议 read 生效（非 inproc / 非降级）
    expect(view.source).toBe('native')
  }, 20_000)

  it('registerZcodeEngine 薄壳：确保 zcode descriptor 注册（routeEngine 行为范围断言）', async () => {
    tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = dataDir ?? path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
    registerZcodeEngine()
    // routeEngine 注入 probe stub（注册断言只看 has 校验与 get 装配，不 spawn）。
    const result = await routeEngine({
      routing: { callEngine: 'zcode' },
      probe: async () => ({ ok: true, engineVersion: 'stub', checks: [] }),
    })
    expect(result.engineId).toBe('zcode')
  }, 20_000)

  it('deps.sources 不跨进程：传入被忽略不抛（协议不变量 5）', () => {
    const engine = createZcodeEngine({
      engineDataDir: () => '/tmp/w8-d8-sources',
      cliPath: FIXTURE_CLI,
      sources: { configPath: '/should/not/cross' } as unknown as never,
    })
    expect(engine.id).toBe('zcode')
  })

  it('createZcodeEngine 携带部署形态翻译面：vendored manifest modelTranslation → translateModelRef 查表改写', () => {
    // 不传 cliPath：走 vendored 相对定位读 packages/zcode-subagent-cli/package.json
    // （manifest 声明 modelTranslation）；构造同步不 spawn，翻译面为纯查表。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-translation-'))
    try {
      const engine = createZcodeEngine({ engineDataDir: () => dir })
      expect(typeof engine.translateModelRef).toBe('function')
      // vendored 包声明的目标段（ADR-0142 D1 已发布形态）
      expect(engine.translateModelRef!('zai-coding-cn/glm-5.3-flash')).toBe(
        'account:bigmodel-individual-coding-plan/glm-5.3-flash',
      )
      // 表外 provider / 无 provider 段 → 恒等透传（幂等）
      expect(engine.translateModelRef!('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat')
      expect(engine.translateModelRef!('glm-5.3-flash')).toBe('glm-5.3-flash')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
describe('W8 D8 引擎子进程 L0 env 注入', () => {
  it('数据根经 L0 显式注入（deps.engineDataDir → TAIJI_AGENT_DATA_DIR）', async () => {
    tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = dataDir ?? path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
    const envEcho = await fakeCliEnvEcho({ engineDataDir: dataDir, cliPath: FIXTURE_CLI })
    expect(envEcho['TAIJI_AGENT_DATA_DIR']).toBe(dataDir)
  }, 20_000)
})
});
