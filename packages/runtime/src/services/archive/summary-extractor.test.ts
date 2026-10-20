import { describe, expect, it } from 'vitest'
import { extractArchiveSummary } from './summary-extractor.js'

/**
 * 摘要提取器单测（session-archive 设计 §7 D4 验收条款五类用例）：
 * user entry 开新 turn / turn 无 agent 文本 → agent:null / 纯图片 user 空串 /
 * 非 message entry（compaction·usage·model_change 等）跳过 / agent 文本取从后向前
 * 第一个非空块。
 *
 * 输入形态 = parseJsonl 产物（unknown[]），fixture 直接以 pi JSONL entry 字面量
 * 构造（PiSessionEntry 的运行时形态），不引入 pi 类型依赖——被测函数按运行时
 * 收窄消费，测试同口径。
 */

const TS = '2026-10-20T00:00:00.000Z'

function msgEntry(id: string, role: string, content: unknown): unknown {
  return { type: 'message', id, parentId: null, timestamp: TS, message: { role, content } }
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

function imageBlock(): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data: '<base64>', mimeType: 'image/png' }
}

function toolCallBlock(): { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } {
  return { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls' } }
}

function compactionEntry(id: string): unknown {
  return { type: 'compaction', id, parentId: null, timestamp: TS, summary: '压缩摘要', firstKeptEntryId: 'e1', tokensBefore: 100 }
}

function usageEntry(id: string): unknown {
  return { type: 'usage', id, parentId: null, timestamp: TS, kind: 'cache_warm', provider: 'p', model: 'm', usage: {} }
}

/** PiSessionEntry 联合外的未建模 entry 类型（pi 还会写 model_change/session_info 等）。 */
function unmodeledEntry(id: string, type: string): unknown {
  return { type, id, parentId: null, timestamp: TS }
}

describe('extractArchiveSummary（D4 摘要算法）', () => {
  it('空输入与无 user entry 输入 → 空 turns', () => {
    expect(extractArchiveSummary([])).toEqual({ turns: [] })
    expect(extractArchiveSummary([msgEntry('a1', 'assistant', [textBlock('无用户提问的孤儿回复')])])).toEqual({ turns: [] })
  })

  it('user entry 开新 turn：按 user 边界切分，各 turn 携带自己的 agent 文本', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('第一个问题')]),
      msgEntry('a1', 'assistant', [textBlock('第一个回答')]),
      msgEntry('u2', 'user', [textBlock('第二个问题')]),
      msgEntry('a2', 'assistant', [textBlock('第二个回答')]),
    ])
    expect(summary).toEqual({
      turns: [
        { user: '第一个问题', agent: '第一个回答' },
        { user: '第二个问题', agent: '第二个回答' },
      ],
    })
  })

  it('user content 为 string 形态 → 直取；blocks 形态 → text 块拼接（\\n join）', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', '字符串形态的用户消息'),
      msgEntry('u2', 'user', [textBlock('第一段'), imageBlock(), textBlock('第二段')]),
    ])
    expect(summary.turns.map((t) => t.user)).toEqual(['字符串形态的用户消息', '第一段\n第二段'])
  })

  it('纯图片/附件 user 消息 → user 为空串（不产 turn 之外的行为）', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [imageBlock(), imageBlock()]),
      msgEntry('a1', 'assistant', [textBlock('回答')]),
    ])
    expect(summary.turns).toEqual([{ user: '', agent: '回答' }])
  })

  it('turn 无 agent 文本（user 后直接下一个 user / 只有工具调用）→ agent: null', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题一（无回复即被追问）')]),
      msgEntry('u2', 'user', [textBlock('问题二')]),
      msgEntry('a2', 'assistant', [toolCallBlock()]),
      msgEntry('r2', 'toolResult', [textBlock('工具输出不是 agent 发言')]),
      msgEntry('u3', 'user', [textBlock('问题三')]),
    ])
    expect(summary.turns).toEqual([
      { user: '问题一（无回复即被追问）', agent: null },
      { user: '问题二', agent: null },
      { user: '问题三', agent: null },
    ])
  })

  it('非 message entry 跳过：compaction/usage/model_change/custom 穿插不断 turn、不贡献文本', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      compactionEntry('c1'),
      usageEntry('us1'),
      unmodeledEntry('mc1', 'model_change'),
      unmodeledEntry('cm1', 'custom_message'),
      unmodeledEntry('si1', 'session'),
      msgEntry('a1', 'assistant', [textBlock('压缩点之后的结论')]),
    ])
    // compaction 不作边界（对齐 D4：与 session-reader compaction 断点语义刻意不同）
    expect(summary.turns).toEqual([{ user: '问题', agent: '压缩点之后的结论' }])
  })

  it('agent 文本取从后向前第一个非空块：多 assistant entry 取最终结论段', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [textBlock('初步分析')]),
      msgEntry('a2', 'assistant', [toolCallBlock()]),
      msgEntry('a3', 'assistant', [textBlock('最终结论')]),
    ])
    expect(summary.turns[0]?.agent).toBe('最终结论')
  })

  it('从后向前扫描跳过空白块与无 text 块的 assistant：回退取更早的非空结论', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [textBlock('早期结论')]),
      msgEntry('a2', 'assistant', [toolCallBlock()]),
      msgEntry('a3', 'assistant', [textBlock('   \n  ')]),
    ])
    expect(summary.turns[0]?.agent).toBe('早期结论')
  })

  it('同一 assistant entry 多 text 块 → 取最后一个非空块（= 从后向前第一个）', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [textBlock('块一'), textBlock(''), textBlock('块二')]),
    ])
    expect(summary.turns[0]?.agent).toBe('块二')
  })

  it('role 边界：toolResult 与 system message 不贡献 agent 文本', () => {
    const summary = extractArchiveSummary([
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [toolCallBlock()]),
      msgEntry('r1', 'toolResult', [textBlock('工具结果文本')]),
      msgEntry('s1', 'system', [textBlock('系统消息文本')]),
    ])
    expect(summary.turns[0]?.agent).toBeNull()
  })

  it('首个 user 边界前的孤儿段不属于任何 turn：其 assistant 文本不出现在任何 turn', () => {
    const summary = extractArchiveSummary([
      msgEntry('a0', 'assistant', [textBlock('头部孤儿段')]),
      compactionEntry('c0'),
      msgEntry('u1', 'user', [textBlock('问题')]),
      msgEntry('a1', 'assistant', [textBlock('回答')]),
    ])
    expect(summary.turns).toEqual([{ user: '问题', agent: '回答' }])
  })

  it('非 object 畸形行（parseJsonl 可能产出裸值）与畸形 message 形态跳过', () => {
    const summary = extractArchiveSummary([
      '裸字符串行',
      42,
      null,
      { type: 'message', id: 'x1', parentId: null, timestamp: TS }, // message 字段缺失
      { type: 'message', id: 'x2', parentId: null, timestamp: TS, message: { role: 'user' } }, // content 缺失 → user ''
      msgEntry('a1', 'assistant', [textBlock('回答')]),
    ])
    expect(summary.turns).toEqual([{ user: '', agent: '回答' }])
  })
})
