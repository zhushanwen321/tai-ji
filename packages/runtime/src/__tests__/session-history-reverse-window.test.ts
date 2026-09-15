/**
 * ①档预检逆序窗口 + ②档尾读分块扩窗测试（u4b-history-budget，crash-resilience §3.3 D5）。
 *
 * 必测断言（impl-plan u4b 验收）：
 * - ⑤ ①档大文件逆序窗口：>32MB fixture（tmpdir 自建自删、真实 JSONL 行形态）→
 *   statSync 预检超 READ_PRECHECK_MAX_BYTES → 逆序分块读返回最近预算窗口 + truncated
 *   标记（不拒绝）；消费方语义：[u6] 游标翻页文件读 / getSubagentHistory 同链路（①档底座）
 * - ⑥ ②档分块扩窗：尾部凑够 20 turns 不触全量（结果只有 20 turns 即为证据——全量读
 *   会返回全部 turns）；凑不够到 32MB 上限返回部分 + truncated
 * - ⑦ 行边界对齐由 history-reverse-read.test.ts 单元覆盖（此处端到端复验）
 *
 * fixture 构造对齐 A11 声明：首行 type:'session' header + 真实 entry 形态拼接 +
 * 尾部 turn 密度（保证「凑 20 turns」路径被真实触发而非 truncated 短路）。
 * 测试框架：vitest；大文件写入 tmpdir（fs-guard 白名单）自建自删。
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-history-reverse-window.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
import { getHistoryFromFilePath, tailReadHistory } from '../services/session-history.js'
import { PiSessionStore } from '../infra/pi/session-store.js'
import type { ISessionStore } from '../services/ports/session.js'

let tmpDir: string
const realStore: ISessionStore = new PiSessionStore()

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-history-reverse-window-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── fixture 构造（真实 JSONL 行形态，A11 同型）────────────────────

function headerLine(sessionId: string): string {
  return JSON.stringify({ type: 'session', id: sessionId, cwd: '/proj', timestamp: '2026-01-01T00:00:00Z' })
}

function msgLine(id: string, role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00Z',
    message: { role, content: [{ type: 'text', text }], timestamp: 1000 },
  })
}

function turnLines(startIdx: number, padBytes = 64): string[] {
  return [
    msgLine(`e${startIdx}`, 'user', `question-${startIdx}`),
    // assistant 行带 padding（真实 entry 的工具输出/回复体量形态）
    msgLine(`e${startIdx + 1}`, 'assistant', `answer-${startIdx}-` + 'x'.repeat(padBytes)),
  ]
}

/** 小 session（预算内）：首行 header + n 个 turn。 */
function writeSmallSession(name: string, turns: number): string {
  const lines = [headerLine('sid-small')]
  for (let i = 0; i < turns; i++) lines.push(...turnLines(i * 2))
  const filePath = join(tmpDir, name)
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  return filePath
}

/**
 * 大 session：header + preTurns 个大 turn（每 turn 约 bigPadBytes 字节）+ tailTurns 个
 * 小 turn（尾部密度）。返回 { filePath, fileSize, tailUserIds }。
 */
function writeBigSession(opts: { sessionId: string; preTurns: number; bigPadBytes: number; tailTurns: number }): {
  filePath: string
  fileSize: number
} {
  const lines = [headerLine(opts.sessionId)]
  for (let i = 0; i < opts.preTurns; i++) lines.push(...turnLines(i * 2, opts.bigPadBytes))
  const base = opts.preTurns * 2
  for (let i = 0; i < opts.tailTurns; i++) lines.push(...turnLines(base + i * 2, 64))
  const filePath = join(tmpDir, `${opts.sessionId}.jsonl`)
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  return { filePath, fileSize: statSync(filePath).size }
}

// ════════════════════════════════════════════════════════════════════
// ①档：getHistoryFromFilePath statSync 预检 + 逆序窗口（断言⑤）
// ════════════════════════════════════════════════════════════════════

describe('①档预检回归：<32MB 行为与现状一致', () => {
  it('小文件全量返回、truncated:false', async () => {
    const filePath = writeSmallSession('small-1.jsonl', 5)
    const { messages, truncated } = await getHistoryFromFilePath(filePath, realStore)
    expect(truncated).toBe(false)
    expect(messages).toHaveLength(10) // 5 turn × (user + assistant)
    expect(messages[0]).toMatchObject({ role: 'user' })
  })
})

describe('①档超预检阈值：逆序窗口（断言⑤）', () => {
  it('>32MB fixture：返回最近 20 turns 预算窗口 + truncated:true（不拒绝）', async () => {
    // 30 个大 turn（各 ~1.2MB，总 ≈ 36MB > 32MB）+ 尾部 25 个小 turn
    const { filePath, fileSize } = writeBigSession({ sessionId: 'big-1', preTurns: 30, bigPadBytes: 1150 * 1024, tailTurns: 25 })
    expect(fileSize).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)

    const { messages, truncated } = await getHistoryFromFilePath(filePath, realStore)

    // 不拒绝：给出最近预算窗口（尾部 25 个小 turn 中的最近 20 个）
    expect(truncated).toBe(true)
    expect(messages).toHaveLength(20 * 2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    // 窗口是尾部（最新）turn：包含最后一个小 turn，不含头部大 turn 内容
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('answer-') })
    for (const m of messages) {
      expect((m.content as string).length).toBeLessThan(2000) // 大 turn 未被读入
    }
  })

  it('>32MB fixture 凑不够 20 turns：读满 32MB 上限返回已凑部分 + truncated', async () => {
    // 6 个 turn 各 ~8MB（总 48MB > 32MB）：读满上限也只有 ~4 个 turn
    const { filePath } = writeBigSession({ sessionId: 'big-2', preTurns: 6, bigPadBytes: 7800 * 1024, tailTurns: 0 })

    const { messages, truncated } = await getHistoryFromFilePath(filePath, realStore)

    expect(truncated).toBe(true)
    // 已凑部分：至少 1 个完整 turn（>32MB/8MB），且窗口起点对齐 turn 边界（entry 原子性）
    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    // 读取量受 32MB 上限：未返回全部 6 个 turn
    expect(messages.length).toBeLessThan(12)
  })

  it('>32MB 且尾部 turn 超 MAX_BYTES 字节帽：窗口在 turn 边界受帽截断（首 turn 豁免）+ truncated', async () => {
    // 17 个 turn 各 ~2MB（总 ~34MB > 32MB 触发①档），单 turn ~2MB > 640KB 字节帽：
    // 首 turn 豁免完整入窗，第 2 个 turn 边界处超帽 → 停止。无字节帽时读满 32MB
    // 可凑 ~4 turns（对齐上一用例 big-2 行为）——有帽时仅 1 turn 即为受帽截断的行为证据
    const { filePath, fileSize } = writeBigSession({ sessionId: 'big-cap', preTurns: 17, bigPadBytes: 2048 * 1024, tailTurns: 0 })
    expect(fileSize).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)

    // ①档返回形状 HistoryFileReadResult（messages + truncated）
    const { messages, truncated } = await getHistoryFromFilePath(filePath, realStore)

    expect(messages).toHaveLength(2) // 首 turn 豁免入窗（1 turn = 2 条），后续超帽不入窗
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(messages[1]).toMatchObject({ role: 'assistant' })
    // 窗口是尾部（最新）turn，且内容完整未被帽切断（单行字节完整交付）
    expect(String(messages[1].content)).toContain('answer-32')
    expect(truncated).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════
// ②档：tailReadHistory 分块扩窗（断言⑥）
// ════════════════════════════════════════════════════════════════════

describe('②档分块扩窗（断言⑥）', () => {
  it('尾部凑不够 20 turns 触发扩窗：第二块凑够即停（不触全量——全量读会返回 64 条）', async () => {
    // 尾部 12 个小 turn（不足 20）+ 20 个大 turn（各 ~120KB，每 turn 2 行）：
    // 第一块 1MB 只能凑到 ~16 turns → 必须向前扩第二块才凑够（扩窗路径真实触发）
    const { filePath } = writeBigSession({ sessionId: 'expand-1', preTurns: 20, bigPadBytes: 120 * 1024, tailTurns: 12 })

    const { messages, truncated, loadedTurns, totalTurnsEstimate } = await tailReadHistory(filePath, realStore)

    // 「不触全量」的行为证据：全文件 32 turns × 2 = 64 条，窗口只有 20 turns × 2
    expect(messages).toHaveLength(20 * 2)
    expect(truncated).toBe(true)
    expect(loadedTurns).toBe(20)
    // 未读到文件头：totalTurnsEstimate 是诚实下界（= loadedTurns）
    expect(totalTurnsEstimate).toBe(20)
    // 窗口 = 尾部最近 turns（最新 turn 在尾部）
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' })
  })

  it('小文件（≤一块）：读到文件头，turn ≤ 20 → truncated:false（现状回归）', async () => {
    const filePath = writeSmallSession('expand-2.jsonl', 5)
    const { messages, truncated, loadedTurns, totalTurnsEstimate } = await tailReadHistory(filePath, realStore)
    expect(truncated).toBe(false)
    expect(loadedTurns).toBe(5)
    expect(totalTurnsEstimate).toBe(5) // 读到头 = 精确总量
    expect(messages).toHaveLength(10)
  })

  it('凑不够 20 turns 到 32MB 上限：返回已凑部分 + truncated + 窗口起点对齐 turn 边界', async () => {
    // 6 个 turn 各 ~8MB（48MB）：32MB 上限内凑不满 20 turns
    const { filePath } = writeBigSession({ sessionId: 'expand-3', preTurns: 6, bigPadBytes: 7800 * 1024, tailTurns: 0 })

    const { messages, truncated } = await tailReadHistory(filePath, realStore)

    expect(truncated).toBe(true)
    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages[0]).toMatchObject({ role: 'user' }) // 残 turn 段被对齐丢弃（entry 原子性）
    expect(messages.length).toBeLessThan(12) // 未凑满 20 turns
  })
})
