/**
 * W1 红灯测试：tailReadHistory 尾读 + turn 边界截断。
 *
 * 对应 FR-3（tailReadHistory）+ AC-5/6/12/13。
 *
 * turn 定义（D11）：user message 到下一个 user message 之前（含其间的 assistant + tool_call + toolResult）。
 * tailReadHistory 从文件尾部倒扫，收集最近 maxTurns=20 个完整 turn，保证 assistant↔toolResult 配对完整。
 *
 * 核心防的 bug：
 * - AC-5：尾读返回的消息里 toolResult 必须能配对到 assistant（不能有孤立 toolResult）
 * - AC-6：文件不存在返回空数组不抛（pi 延迟写入）
 * - AC-12：文件末行损坏（JSON 不完整）不抛（复用 INVAR-tail-3 残行丢弃）
 * - turn 边界：不能截断在 turn 中间（如取到 toolResult 但丢了对应 assistant tool_call）
 *
 * [红灯说明] tailReadHistory 尚未实现，import 会 fail（模块导出不存在）。
 *
 * 运行：cd packages/runtime && npx vitest run test/tail-read-history.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { HISTORY_BUDGET, OUTBOUND_FRAME_TRUNCATE_BYTES } from '@taiji/shared'
import { tailReadHistory } from '../src/services/session-history.js'
import type { ISessionStore } from '../src/services/ports/session.js'

/**
 * mock sessionStore：convertHistory 透传 piMessages（不合并 toolResult），
 * 让测试能验证 tailReadHistory 的 turn 边界 + 配对完整性（转换前的原始数据）。
 */
function makePassthroughStore(): ISessionStore {
  return {
    scanSessions: () => [],
    convertHistory: (piMessages: unknown[]) => piMessages as never,
  } as unknown as ISessionStore
}

describe('W1 tailReadHistory 尾读 + turn 边界截断', () => {
  let tmpDir: string
  let store: ISessionStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tail-read-'))
    store = makePassthroughStore()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 构造一个 pi JSONL session 文件 */
  function writeSessionFile(lines: string[]): string {
    const filePath = join(tmpDir, 'session.jsonl')
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    return filePath
  }

  /** 造一个 user turn（user message + assistant with tool_call + toolResult） */
  function makeTurn(turnIdx: number): string[] {
    return [
      JSON.stringify({ type: 'message', id: `u-${turnIdx}`, message: { role: 'user', content: `user-${turnIdx}` } }),
      JSON.stringify({ type: 'message', id: `a-${turnIdx}`, message: { role: 'assistant', content: `assistant-${turnIdx}`, toolCalls: [{ id: `tc-${turnIdx}`, toolName: 'read', input: {} }] } }),
      JSON.stringify({ type: 'message', id: `tr-${turnIdx}`, message: { role: 'toolResult', toolCallId: `tc-${turnIdx}`, content: `result-${turnIdx}` } }),
    ]
  }

  it('AC-5: 加载最近 turn，toolResult 都能配对到 assistant（无孤立 toolResult）', async () => {
    // 造 25 个 turn（超过 maxTurns=20）
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    for (let i = 0; i < 25; i++) {
      lines.push(...makeTurn(i))
    }
    const filePath = writeSessionFile(lines)

    const { messages } = await tailReadHistory(filePath, store, 20)

    // 应加载最近 20 turn（每个 turn 3 条 message = 60 条）
    expect(messages.length).toBe(60)

    // AC-5 核心：每条 toolResult 都能配对到 assistant
    const assistantToolCallIds = new Set<string>()
    for (const msg of messages) {
      const m = msg as { role?: string; toolCalls?: { id: string }[] }
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) assistantToolCallIds.add(tc.id)
      }
    }
    for (const msg of messages) {
      const m = msg as { role?: string; toolCallId?: string }
      if (m.role === 'toolResult') {
        expect(assistantToolCallIds.has(m.toolCallId!)).toBe(true)
      }
    }
  })

  it('AC-5 边界：加载的 turn 数不超过 maxTurns', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    for (let i = 0; i < 30; i++) {
      lines.push(...makeTurn(i))
    }
    const filePath = writeSessionFile(lines)

    const { messages: messages5 } = await tailReadHistory(filePath, store, 5)
    // 5 turn × 3 message = 15 条（不含 session header）
    expect(messages5.length).toBeLessThanOrEqual(15)
  })

  it('N1: truncated 标志——文件 turn 数 > maxTurns 时 truncated=true', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    for (let i = 0; i < 25; i++) {
      lines.push(...makeTurn(i))
    }
    const filePath = writeSessionFile(lines)

    // 25 turn 文件取 20 turn → truncated=true
    const result20 = await tailReadHistory(filePath, store, 20)
    expect(result20.truncated).toBe(true)

    // 25 turn 文件取 30 turn（> 文件总量）→ truncated=false
    const result30 = await tailReadHistory(filePath, store, 30)
    expect(result30.truncated).toBe(false)
  })

  it('AC-6: 文件不存在返回空数组不抛', async () => {
    const noExist = join(tmpDir, 'never-exists.jsonl')
    await expect(tailReadHistory(noExist, store, 20)).resolves.toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
  })

  it('AC-12: 文件末行损坏（JSON 不完整）不抛异常', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      ...makeTurn(0),
    ]
    // 末行追加一个损坏的 JSON 片段（被切断）
    const filePath = join(tmpDir, 'session.jsonl')
    writeFileSync(filePath, lines.join('\n') + '\n' + '{"type":"message","id":"broken","message":{', 'utf-8')

    const { messages } = await tailReadHistory(filePath, store, 20)
    // 损坏行被跳过，正常 turn 的消息仍加载
    expect(messages.length).toBeGreaterThan(0)
  })

  it('turn 边界对齐：不截断在 turn 中间（取到 toolResult 不丢 assistant）', async () => {
    // 构造 22 个 turn，验证尾部第一个 turn 的 assistant 也被加载（不只有 toolResult）
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    for (let i = 0; i < 22; i++) {
      lines.push(...makeTurn(i))
    }
    const filePath = writeSessionFile(lines)

    const { messages } = await tailReadHistory(filePath, store, 20)
    // 验证 turn 2（第 3 个 turn，索引从 0 计：0..21，取尾部 2..21）的 assistant 在结果里
    const hasTurn2Assistant = messages.some(
      (m) => (m as { role?: string; content?: string }).role === 'assistant' && (m as { content?: string }).content === 'assistant-2',
    )
    expect(hasTurn2Assistant).toBe(true)
    // turn 1（被截掉的）的 assistant 不应在结果里
    const hasTurn1Assistant = messages.some(
      (m) => (m as { role?: string; content?: string }).role === 'assistant' && (m as { content?: string }).content === 'assistant-1',
    )
    expect(hasTurn1Assistant).toBe(false)
  })

  it('小文件（< 20 turn）加载全部', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      ...makeTurn(0),
      ...makeTurn(1),
    ]
    const filePath = writeSessionFile(lines)

    const { messages } = await tailReadHistory(filePath, store, 20)
    // 2 turn × 3 message = 6 条
    expect(messages.length).toBe(6)
  })

  it('compaction/custom_message entry 也被保留（AGENTS.md 关键规则 9 可重开恢复）', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'compaction', summary: '压缩摘要', tokensBefore: 10000, timestamp: '2025-01-01T00:00:01Z' }),
      JSON.stringify({ type: 'custom_message', customType: 'subagent-bg-notify', content: '通知内容', timestamp: '2025-01-01T00:00:02Z' }),
      ...makeTurn(0),
    ]
    const filePath = writeSessionFile(lines)

    const { messages } = await tailReadHistory(filePath, store, 20)
    // compaction + custom_message + 1 turn(3条) = 5 条
    expect(messages.length).toBe(5)
    const types = messages.map((m) => (m as { role?: string }).role)
    expect(types).toContain('compactionSummary')
    expect(types).toContain('custom')
  })

  it('W-Runtime2: 大文件（fileSize > TAIL_WINDOW）尾窗口含足够 turn 时 truncated=true（didFullRead=false 保守判定）', async () => {
    // maxTurns=20 → TAIL_WINDOW = max(256KB, 20*32KB) = 640KB。要触发尾读-only 路径（不走 fallback 全量读），
    // 需 fileSize > 640KB 且尾窗口（640KB）内 >= 20 个 turn（否则会 fallback 全量读 → didFullRead=true）。
    // 构造：25 个 turn，每个 turn 用大 payload 撑大文件（user content 塞 ~30KB 文本），
    // 总大小 ≈ 25 * 30KB = 750KB > 640KB。尾 640KB 窗口含尾部约 21 turn > 20 → 不 fallback。
    const padding = 'x'.repeat(30 * 1024) // 30KB padding per user message
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    for (let i = 0; i < 25; i++) {
      // 自定义 turn：user message 带 padding（撑大文件），后跟 assistant + toolResult
      lines.push(
        JSON.stringify({ type: 'message', id: `u-${i}`, message: { role: 'user', content: `user-${i}-${padding}` } }),
        JSON.stringify({ type: 'message', id: `a-${i}`, message: { role: 'assistant', content: `assistant-${i}`, toolCalls: [{ id: `tc-${i}`, toolName: 'read', input: {} }] } }),
        JSON.stringify({ type: 'message', id: `tr-${i}`, message: { role: 'toolResult', toolCallId: `tc-${i}`, content: `result-${i}` } }),
      )
    }
    const filePath = writeSessionFile(lines)

    const result = await tailReadHistory(filePath, store, 20)
    // W-Runtime2 核心：尾窗口只读了文件尾部（didFullRead=false），窗口外 turn 数未知，
    // 即使尾窗口内 turn 数 >= maxTurns 也保守认定 truncated=true（宁可多显示「加载更多」也别漏）。
    expect(result.truncated).toBe(true)
    // 尾窗口含足够 turn，应加载 maxTurns 个 turn（每个 3 条 = 60 条）
    expect(result.messages.length).toBe(60)
  })
})

/**
 * 离线尾读字节预算 + truncated 精确判定（crash-resilience §3.3 D4 / A6 一致性审查修复）。
 *
 * 修复的两个缺陷：
 * 1. 离线尾读缺字节预算：doGetHistory 离线 fallback 原样透传 query（maxBytes=undefined）
 *    → 仅按 turn 数截取，20 个大 turn（合计 >32MB）的 session.history reply 被
 *    payload_too_large 拒绝且 truncated 未置位（「加载更早」入口不存在）——历史打不开。
 *    修复后离线路径传 maxBytes 缺省 HISTORY_BUDGET.MAX_BYTES（与游标分支同源），且
 *    collectRecentTurnEntriesFromTail 的预算语义与活跃路径 applyHistoryBudgetWindow
 *    对齐：首个 turn 豁免、后续 turn 超界不入窗（窗口总字节 ≤ 预算）。
 * 2. 恰好 maxTurns turns 的文件 truncated 误报：原实现凑够 turn 数即停 → stopped=true →
 *    truncated=true，而文件实无更早历史（A6 要求无截断提示）。修复后凑够 turn 数只停止
 *    收集，继续向前确认是否真有更早 turn 边界：扫到文件头仍无 → false；发现边界或
 *    32MB 上限截停无法确认 → true。
 */
describe('D4 离线尾读字节预算 + A6 truncated 精确判定', () => {
  let tmpDir: string
  let store: ISessionStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tail-read-budget-'))
    store = makePassthroughStore()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function writeSessionFile(lines: string[]): string {
    const filePath = join(tmpDir, 'session-budget.jsonl')
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    return filePath
  }

  /** 与上方 W1 describe 同款的小 turn（3 行：user + assistant(tool_call) + toolResult） */
  function makeTurn(turnIdx: number): string[] {
    return [
      JSON.stringify({ type: 'message', id: `u-${turnIdx}`, message: { role: 'user', content: `user-${turnIdx}` } }),
      JSON.stringify({ type: 'message', id: `a-${turnIdx}`, message: { role: 'assistant', content: `assistant-${turnIdx}`, toolCalls: [{ id: `tc-${turnIdx}`, toolName: 'read', input: {} }] } }),
      JSON.stringify({ type: 'message', id: `tr-${turnIdx}`, message: { role: 'toolResult', toolCallId: `tc-${turnIdx}`, content: `result-${turnIdx}` } }),
    ]
  }

  /** 带 padding 的 turn（user message 塞大 payload 撑体积，assistant + toolResult 同 makeTurn 形态） */
  function makePaddedTurn(turnIdx: number, padding: string): string[] {
    return [
      JSON.stringify({ type: 'message', id: `u-${turnIdx}`, message: { role: 'user', content: `user-${turnIdx}-${padding}` } }),
      JSON.stringify({ type: 'message', id: `a-${turnIdx}`, message: { role: 'assistant', content: `assistant-${turnIdx}` } }),
      JSON.stringify({ type: 'message', id: `tr-${turnIdx}`, message: { role: 'toolResult', toolCallId: `tc-${turnIdx}`, content: `result-${turnIdx}` } }),
    ]
  }

  function makeHeader(): string {
    return JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' })
  }

  function responseBytes(messages: unknown[]): number {
    return messages.reduce<number>((sum, m) => sum + Buffer.byteLength(JSON.stringify(m), 'utf-8'), 0)
  }

  it('D4: 20 个大 turn（fixture 合计 >32MB）→ truncated=true 且窗口字节 ≤ 预算+首 turn 豁免（远低于 32MB，非 payload_too_large）', async () => {
    // 每个 turn ≈ 1.7MB（user content padding 主导），20 turn 合计 ≈ 34MB > 32MB 出站帧截断档：
    // 无字节预算时整个文件会被收集进 reply → payload_too_large 拒绝且 truncated 未置位。
    const padding = 'x'.repeat(1700 * 1024)
    const lines: string[] = [makeHeader()]
    for (let i = 0; i < 20; i++) lines.push(...makePaddedTurn(i, padding))
    const filePath = writeSessionFile(lines)

    const result = await tailReadHistory(filePath, store, HISTORY_BUDGET.RECENT_TURNS, { maxBytes: HISTORY_BUDGET.MAX_BYTES })

    // 首 turn（最新）超预算仍完整放行（首 turn 豁免），预算在其后的 turn 边界处停止
    expect(result.truncated).toBe(true)
    expect(result.loadedTurns).toBe(1)
    // 窗口字节 ≤ 预算 + 首 turn 原始行体积（mapper 重建的 message 不新增大字段，同量级）
    const firstTurnRawBytes = lines.slice(1, 4).reduce((s, l) => s + Buffer.byteLength(l, 'utf-8') + 1, 0)
    const totalBytes = responseBytes(result.messages)
    expect(totalBytes).toBeLessThanOrEqual(HISTORY_BUDGET.MAX_BYTES + firstTurnRawBytes)
    // 非 payload_too_large：窗口 reply 远低于 32MB 出站帧截断档（未修复时 ≈34MB 必然越限）
    expect(totalBytes).toBeLessThan(OUTBOUND_FRAME_TRUNCATE_BYTES)
  })

  it('D4 语义对齐: 超界 turn 不入窗（与活跃路径 applyHistoryBudgetWindow 一致，窗口总字节 ≤ 预算）', async () => {
    // 6 turns × ~200KB，maxBytes=640KB：最近 3 turns（~600KB）入窗后，第 4 新的 turn
    // 会使累计超预算 → 不入窗（回退该 turn 行）。旧实现会把超界 turn 完整放行（窗口
    // ~800KB > 预算），与活跃路径「accBytes + turnBytes > maxBytes 即截取」不一致。
    const padding = 'x'.repeat(200 * 1024)
    const lines: string[] = [makeHeader()]
    for (let i = 0; i < 6; i++) lines.push(...makePaddedTurn(i, padding))
    const filePath = writeSessionFile(lines)

    const result = await tailReadHistory(filePath, store, HISTORY_BUDGET.RECENT_TURNS, { maxBytes: HISTORY_BUDGET.MAX_BYTES })

    expect(result.truncated).toBe(true)
    expect(result.loadedTurns).toBe(3)
    expect(responseBytes(result.messages)).toBeLessThanOrEqual(HISTORY_BUDGET.MAX_BYTES)
  })

  it('D4 回退后窗口完整性：窗口首消息为 user（turn 边界）且 entry parentId 链前驱在窗内可追溯', async () => {
    // 与「D4 语义对齐」同款预算场景（6 turns × ~200KB，640KB 预算在第 4 新 turn 边界
    // 超界 → 回退该 turn）：fixture 额外带真实 pi 文件形态的 id/parentId 线性链
    // （每条 entry 的 parentId = 前一条 entry 的 id），验证回退的 turn 原子性——
    // 窗口是链的连续段（无中途截断），链上断点只允许出现在窗口首 entry（其父在窗外）。
    const padding = 'x'.repeat(200 * 1024)
    const lines: string[] = [makeHeader()]
    const parentById = new Map<string, string | null>()
    let prevId: string | null = null
    for (let i = 0; i < 6; i++) {
      const turnDefs: Array<{ id: string; role: string; content: string }> = [
        { id: `u-${i}`, role: 'user', content: `user-${i}-${padding}` },
        { id: `a-${i}`, role: 'assistant', content: `assistant-${i}` },
        { id: `tr-${i}`, role: 'toolResult', content: `result-${i}` },
      ]
      for (const def of turnDefs) {
        parentById.set(def.id, prevId)
        prevId = def.id
        lines.push(
          JSON.stringify({
            type: 'message',
            id: def.id,
            parentId: parentById.get(def.id),
            timestamp: '2025-01-01T00:00:00Z',
            message: { role: def.role, content: def.content },
          }),
        )
      }
    }
    const filePath = writeSessionFile(lines)

    // store 桩捕获 mapper 产出的平行 entryIds（message 体不带 entry 身份，链断言经此透出）
    const seenEntryIds: string[][] = []
    const capturingStore: ISessionStore = {
      scanSessions: () => [],
      convertHistory: (piMessages: unknown[], entryIds?: string[]) => {
        seenEntryIds.push(entryIds ? [...entryIds] : [])
        return piMessages as never
      },
    } as unknown as ISessionStore

    const result = await tailReadHistory(filePath, capturingStore, HISTORY_BUDGET.RECENT_TURNS, {
      maxBytes: HISTORY_BUDGET.MAX_BYTES,
    })

    // budget 停止回退已发生（回退第 4 新 turn，窗口 = 最近 3 turns）
    expect(result.truncated).toBe(true)
    expect(result.loadedTurns).toBe(3)
    // 断言 1：窗口首消息为 user（turn 边界）——回退不切在 turn 中间
    expect((result.messages[0] as { role?: string }).role).toBe('user')
    // 断言 2：parentId 链前驱可追溯——除窗口首 entry（其父在窗外）外，每条 entry 的
    // parentId 恰为窗口内前一条 entry 的 id（链段连续，turn 原子性未被回退破坏）
    const windowIds = seenEntryIds[seenEntryIds.length - 1]!
    expect(windowIds).toHaveLength(result.messages.length)
    expect(windowIds[0]).toBe('u-3')
    for (let i = 1; i < windowIds.length; i++) {
      expect(parentById.get(windowIds[i]!)).toBe(windowIds[i - 1])
    }
  })

  it('A6: 恰好 20 turns 的小文件 → truncated=false（实无更早历史，不误报「加载更早」）', async () => {
    const lines: string[] = [makeHeader()]
    for (let i = 0; i < 20; i++) lines.push(...makeTurn(i))
    const filePath = writeSessionFile(lines)

    const result = await tailReadHistory(filePath, store, 20)

    // 修复前：凑够 20 turns 即停 → stopped=true → truncated=true（误报）
    // 修复后：停止收集后继续确认扫描，扫到文件头无更早 turn 边界 → false
    expect(result.truncated).toBe(false)
    expect(result.messages.length).toBe(60)
    expect(result.totalTurnsEstimate).toBe(20)
  })

  it('A6: 40 turns 文件取 20 → truncated=true（确认扫描发现更早 turn 边界）', async () => {
    const lines: string[] = [makeHeader()]
    for (let i = 0; i < 40; i++) lines.push(...makeTurn(i))
    const filePath = writeSessionFile(lines)

    const result = await tailReadHistory(filePath, store, 20)

    expect(result.truncated).toBe(true)
    expect(result.messages.length).toBe(60)
  })
})
