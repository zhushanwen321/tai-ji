/**
 * A21 entry→TraceRow kind 映射单测（§3.4 渲染模型 12 kind 全覆盖 + 损坏行占位）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mapSessionTraceRows, resolveTraceRowKind, SYSTEM_PROMPT_CUSTOM_TYPE } from '../trace-rows'
import { parseSessionTraceJsonl } from '../parse-jsonl'
import type { TraceFileEntry } from '../types'

const FIXTURES = new URL('../__fixtures__/', import.meta.url)

function loadRows(name: string, opts: { sessionEnd?: boolean; leafId?: string } = {}) {
  const text = readFileSync(new URL(name, FIXTURES), 'utf8')
  const sessionEnd = opts.sessionEnd
    ? (JSON.parse(readFileSync(new URL(`${name}.meta.json`, FIXTURES), 'utf8')) as {
        type: 'session_end'
        outcome: 'done' | 'error' | 'stopped'
        reason?: string
        timestamp?: string
      })
    : undefined
  return mapSessionTraceRows({ lines: parseSessionTraceJsonl(text), sessionEnd, leafId: opts.leafId })
}

function rowBySeq(rows: ReturnType<typeof loadRows>, seq: number) {
  return rows.find((r) => r.seq === seq)
}

describe('A21 entry→TraceRow kind 映射（12 kind 全覆盖 + 损坏行占位）', () => {
  it('synthetic-full-kinds：12 种 kind 全出现且逐行映射正确（含 leafId 下的 inContext/shadowed）', () => {
    const rows = loadRows('synthetic-full-kinds.jsonl', { sessionEnd: true, leafId: 'u4' })

    const kindSeq = rows.map((r) => `${r.seq}:${r.kind}`).join(' ')
    // 19 行 JSONL（含 handoff_marker 尾行）+ 1 行 sidecar = 20 行台账
    expect(rows).toHaveLength(20)
    expect(kindSeq).toBe(
      [
        '1:SESSION', '2:SYSTEM', '3:LIFECYCLE', '4:LIFECYCLE', '5:USER', '6:ASSISTANT',
        '7:TOOL', '8:BASH', '9:NOTICE', '10:NOTICE', '11:USER', '12:COMPACTED', '13:BRANCH',
        '14:USER', '15:LIFECYCLE', '16:LIFECYCLE', '17:DATA', '18:USER', '19:BOUNDARY', '20:BOUNDARY',
      ].join(' '),
    )

    // 12 kind 全出现（sidecar 行补齐 BOUNDARY）
    const kinds = new Set(rows.map((r) => r.kind))
    for (const kind of [
      'SESSION', 'SYSTEM', 'USER', 'ASSISTANT', 'TOOL', 'BASH',
      'NOTICE', 'COMPACTED', 'BRANCH', 'LIFECYCLE', 'DATA', 'BOUNDARY',
    ] as const) {
      expect(kinds.has(kind), `kind ${kind} 应出现`).toBe(true)
    }

    // context 边界标注：leafId=u4，压缩点 c1 firstKept=u2
    // inContext = {c1, u2, bs1, u3, u4}；shadowed = 可进类型且在压缩区 {u1, a1, tr1, b1, cm1, mcx1}
    const inContextKeys = rows.filter((r) => r.inContext).map((r) => r.key).sort()
    expect(inContextKeys).toEqual(['bs1', 'c1', 'u2', 'u3', 'u4'])
    const shadowedKeys = rows.filter((r) => r.shadowed).map((r) => r.key).sort()
    expect(shadowedKeys).toEqual(['a1', 'b1', 'cm1', 'mcx1', 'tr1', 'u1'])
    // 不可进类型（SYSTEM/DATA/LIFECYCLE/SESSION）不影子化
    expect(rowBySeq(rows, 2)?.shadowed).toBe(false) // SYSTEM
    expect(rowBySeq(rows, 17)?.shadowed).toBe(false) // DATA
  })

  it('synthetic-full-kinds：行摘要数据提取（headline/meta 关键字段）', () => {
    const rows = loadRows('synthetic-full-kinds.jsonl', { leafId: 'u4' })
    expect(rowBySeq(rows, 1)?.meta.parentSession).toBe('/Users/dev/work/demo/older-session.jsonl')
    expect(rowBySeq(rows, 1)?.meta.forkEntryId).toBe('a-old')
    expect(rowBySeq(rows, 2)?.headline).toBe('system prompt v2')
    expect(rowBySeq(rows, 2)?.meta.reason).toBe('resume')
    expect(rowBySeq(rows, 6)?.meta.model).toBe('demo-model')
    expect(rowBySeq(rows, 6)?.meta.toolCalls).toBe(1)
    expect(rowBySeq(rows, 6)?.meta.thinkingBlocks).toBe(1)
    // usage 标量（fixture 该行 usage 只有 input/output；缺省字段不进 meta）
    expect(rowBySeq(rows, 6)?.meta.inputTokens).toBe(100)
    expect(rowBySeq(rows, 6)?.meta.outputTokens).toBe(50)
    expect(rowBySeq(rows, 6)?.meta.cacheReadTokens).toBeUndefined()
    expect(rowBySeq(rows, 7)?.meta.toolName).toBe('read')
    expect(rowBySeq(rows, 7)?.meta.isError).toBe(false)
    expect(rowBySeq(rows, 8)?.headline).toBe('npm test')
    expect(rowBySeq(rows, 8)?.meta.exitCode).toBe(0)
    expect(rowBySeq(rows, 12)?.meta.tokensBefore).toBe(99999)
    expect(rowBySeq(rows, 12)?.meta.firstKeptEntryId).toBe('u2')
    expect(rowBySeq(rows, 15)?.meta.name).toBe('demo-session')
    expect(rowBySeq(rows, 16)?.meta.label).toBe('检查点')
  })

  it('custom_message 与 message(role=custom) 两种 NOTICE 形态均可渲染（display 保留在 meta）', () => {
    const rows = loadRows('synthetic-full-kinds.jsonl', { leafId: 'u4' })
    const noticeRows = rows.filter((r) => r.kind === 'NOTICE')
    expect(noticeRows.map((r) => r.key)).toEqual(['cm1', 'mcx1'])
    expect(rowBySeq(rows, 9)?.meta.display).toBe(true)
    expect(rowBySeq(rows, 10)?.meta.customType).toBe('demo:msg-role')
  })

  it('损坏行：占位可见、行号与原文保留、seq 连续、其余行不受影响', () => {
    const rows = loadRows('real-lifecycle-small.bad-lines.jsonl')
    // 源 10 行 + 注入 2 行 = 12 行台账，seq 连续
    expect(rows).toHaveLength(12)
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))

    const malformed = rows.filter((r) => r.kind === 'MALFORMED')
    expect(malformed.map((r) => r.lineNumber)).toEqual([3, 8])
    expect(malformed[0]?.raw).toBe('{"type": "message", "id": "broken-truncat')
    expect(malformed[1]?.raw).toBe('not a json line at all')
    expect(malformed.every((r) => r.entry === undefined && r.inContext === false && r.shadowed === false)).toBe(true)
    // 损坏行不吞掉邻居：第 4 行仍是正常 entry
    expect(rowBySeq(rows, 4)?.kind).not.toBe('MALFORMED')
  })

  it('sidecar session_end：追加尾部 BOUNDARY 行（source=sidecar，outcome/reason 进 meta）', () => {
    const rows = loadRows('synthetic-full-kinds.jsonl', { sessionEnd: true, leafId: 'u4' })
    const last = rows[rows.length - 1]
    expect(last.kind).toBe('BOUNDARY')
    expect(last.source).toBe('sidecar')
    expect(last.key).toBe('sidecar:session_end')
    expect(last.meta.outcome).toBe('done')
    expect(last.lineNumber).toBeUndefined()
  })

  it('handoff_marker（JSONL 行，无 id）：BOUNDARY 行可见，handedOffTo 进 meta', () => {
    const rows = loadRows('synthetic-full-kinds.jsonl', { leafId: 'u4' })
    const handoff = rows.find((r) => r.kind === 'BOUNDARY' && r.source === 'jsonl')
    expect(handoff?.key).toBe('line:19')
    expect(handoff?.meta.handedOffTo).toBe('s-next-session')
    expect(handoff?.inContext).toBe(false)
  })

  it('real-mixed-kinds（真实脱敏数据）：kind 分布与源文件 entry 类型分布一致', () => {
    const rows = loadRows('real-mixed-kinds.jsonl')
    const count = (kind: string) => rows.filter((r) => r.kind === kind).length
    // 源分布：session 1 / message:user 3 / assistant 28 / toolResult 34 / custom 44 /
    // custom_message 2 / model_change 2 / thinking_level_change 2 / session_info 8
    expect(count('SESSION')).toBe(1)
    expect(count('USER')).toBe(3)
    expect(count('ASSISTANT')).toBe(28)
    expect(count('TOOL')).toBe(34)
    expect(count('DATA')).toBe(44)
    expect(count('NOTICE')).toBe(2)
    expect(count('LIFECYCLE')).toBe(12) // model_change 2 + thinking_level_change 2 + session_info 8
    expect(rows).toHaveLength(124)
  })

  it('real-fork-header：SESSION 行 parentSession（sessionId fallback 形态）与 forkEntryId 可见', () => {
    const rows = loadRows('real-fork-header.jsonl')
    expect(rows[0]?.kind).toBe('SESSION')
    expect(rows[0]?.meta.parentSession).toBe('s-fork-src')
    expect(rows[0]?.meta.forkEntryId).toBe('a1')
  })

  it('real-mixed-kinds：完整 usage（cacheRead + cost.total）标量进 meta + 输入侧合计', () => {
    const rows = loadRows('real-mixed-kinds.jsonl')
    const row = rows.find((r) => r.key === 'cd0cdf60')
    expect(row?.kind).toBe('ASSISTANT')
    expect(row?.meta.inputTokens).toBe(43549)
    expect(row?.meta.outputTokens).toBe(70)
    expect(row?.meta.cacheReadTokens).toBe(512)
    expect(row?.meta.cacheWriteTokens).toBe(0)
    // 互斥桶合计（pi-ai 归一化语义）：43549 + 512 + 0
    expect(row?.meta.inputTotal).toBe(44061)
    expect(row?.meta.reasoningTokens).toBe(9)
    expect(row?.meta.costTotal).toBe(0)
  })

  it('resolveTraceRowKind 单点映射（含未知类型兜底不丢失）', () => {
    expect(resolveTraceRowKind({ type: 'session', version: 3 } as TraceFileEntry)).toBe('SESSION')
    expect(
      resolveTraceRowKind({ type: 'custom', id: 'x', parentId: null, timestamp: 't', customType: SYSTEM_PROMPT_CUSTOM_TYPE }),
    ).toBe('SYSTEM')
    expect(resolveTraceRowKind({ type: 'custom', id: 'x', parentId: null, timestamp: 't', customType: 'other' })).toBe('DATA')
    expect(
      resolveTraceRowKind({ type: 'message', id: 'x', parentId: null, timestamp: 't', message: { role: 'bashExecution' } }),
    ).toBe('BASH')
    // pi 未来新增 entry 类型：DATA 兜底（G1 不丢失）
    expect(resolveTraceRowKind({ type: 'future_entry', id: 'x', parentId: null, timestamp: 't' })).toBe('DATA')
  })
})
