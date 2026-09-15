/**
 * session 历史加载双预算窗口测试（u4b-history-budget，crash-resilience §3.3 D4）。
 *
 * 必测断言（impl-plan u4b 验收）：
 * - ① 预算内（<20 turns 且 <640KB）不截断：truncated:false、行为与现状一致（A6 回归）
 * - ② 超预算截断：truncated:true + loadedTurns/totalTurnsEstimate 正确
 * - ③ 单 turn 超预算完整放行（最近 turn 豁免字节条件，truncated/统计如实反映）
 * - ④ turn 内 entry 不切分（同 turn 的 toolCall/toolResult 不拆，entry 原子性）
 *
 * applyHistoryBudgetWindow 是纯函数（切分点在重建后的 Message[] 上，不依赖 pi 行为）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/history-budget-window.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '@taiji/shared'
import { HISTORY_BUDGET } from '@taiji/shared'
import { applyHistoryBudgetWindow } from '../history-rebuild-cache.js'

// ── fixture 工厂 ───────────────────────────────────────────────────

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
    // 病态前导：首条非 user（如增量合并边界的孤儿 toolResult 投影）
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

// ── helper：断言里重建期望值（避免复用同一对象引用造成 toEqual 恒真） ──
function userMsgDefined(content: string): Message {
  return { id: expect.any(String), role: 'user', content, status: 'complete', timestamp: expect.any(Number) } as unknown as Message
}
function assistantMsgDefined(content: string): Message {
  return { id: expect.any(String), role: 'assistant', content, status: 'complete', timestamp: expect.any(Number) } as unknown as Message
}
