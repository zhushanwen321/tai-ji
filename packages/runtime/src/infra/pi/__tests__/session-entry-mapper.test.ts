/**
 * mapSessionEntries 单测（converter M1）。
 *
 * 覆盖 design.json TC1-TC4：
 * - TC1：四类 entry 映射 + custom 分流 + label 跳过
 * - TC2：完成通知 custom_message display 覆写 false（引用 shared COMPLETE_NOTIFY_CUSTOM_TYPES SSOT）
 * - TC3：平行 entryIds 与 messages 对齐
 * - TC4：畸形 data 降级（custom_message 无 content、custom 无 data，不抛错）
 *
 * 测试框架：vitest（从 vitest 导入），运行：npx vitest run，禁止 node:test。
 */
import { describe, it, expect } from 'vitest'
import { applyEntryEndTimes, mapSessionEntries } from '../session-entry-mapper.js'
import type { Message } from '@taiji/shared'
import type {
  PiSessionEntry,
  PiSessionMessageEntry,
  PiSessionCustomEntry,
  PiSessionCompactionEntry,
  PiSessionBranchSummaryEntry,
  PiSessionCustomMessageEntry,
  PiSessionLabelEntry,
  PiHistoryMessage,
} from '../pi-protocol.js'

// ── factories ──────────────────────────────────────────────────────

function msgEntry(id: string, role: 'user' | 'assistant' = 'user', text = `msg-${id}`): PiSessionMessageEntry {
  const historyMsg: PiHistoryMessage = {
    role,
    content: [{ type: 'text', text }],
    timestamp: 1000,
  }
  return { type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', message: historyMsg }
}

function compactionEntry(id: string, summary = `compact-${id}`, tokensBefore = 5000): PiSessionCompactionEntry {
  return { type: 'compaction', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', summary, firstKeptEntryId: 'k1', tokensBefore }
}

function branchSummaryEntry(id: string, fromId = 'f1', summary = `branch-${id}`): PiSessionBranchSummaryEntry {
  return { type: 'branch_summary', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', fromId, summary }
}

function customMessageEntry(
  id: string,
  customType: string,
  opts: { content?: string; display?: boolean; details?: Record<string, unknown> } = {},
): PiSessionCustomMessageEntry {
  return {
    type: 'custom_message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    customType,
    content: opts.content ?? `content-${id}`,
    ...(opts.display !== undefined && { display: opts.display }),
    ...(opts.details !== undefined && { details: opts.details }),
  }
}

function customEntry(id: string, customType: string, data: unknown): PiSessionCustomEntry {
  return { type: 'custom', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', customType, data }
}

function labelEntry(id: string): PiSessionLabelEntry {
  return { type: 'label', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', label: 'bookmark', targetId: 't1' }
}

// ── TC1：四类 entry 映射 + custom 分流 + label 跳过 ─────────────────

describe('TC1 四类 entry 映射 + custom 分流', () => {
  it('message/compaction/branch_summary/custom_message 进 messages（顺序保持）；custom 进 customDataEntries；label 跳过', () => {
    const entries: PiSessionEntry[] = [
      msgEntry('e1'),
      compactionEntry('e2'),
      customEntry('e3', 'taiji.client-msg-id', { clientUuid: 'u1' }),
      customMessageEntry('e4', 'status-bar'),
      branchSummaryEntry('e5'),
      labelEntry('e6'), // 应被跳过
    ]

    const { messages, customDataEntries } = mapSessionEntries(entries)

    // messages 含 4 条伪消息（label 跳过、custom 分流，不计入 messages）
    expect(messages).toHaveLength(4)
    // 顺序保持：message → compaction → custom_message → branch_summary
    expect((messages[0] as PiHistoryMessage).role).toBe('user')
    expect((messages[0] as { content: unknown[] }).content[0]).toMatchObject({ type: 'text', text: 'msg-e1' })
    expect((messages[1] as { role: string }).role).toBe('compactionSummary')
    expect((messages[2] as { role: string }).role).toBe('custom')
    expect((messages[3] as { role: string }).role).toBe('branchSummary')

    // custom 进 customDataEntries（不进 messages）
    expect(customDataEntries).toHaveLength(1)
    expect(customDataEntries[0].customType).toBe('taiji.client-msg-id')
    expect(customDataEntries[0].data).toEqual({ clientUuid: 'u1' })
  })

  it('message 透传 message 体（引用相等，不注入 __entryId）', () => {
    const entry = msgEntry('e1', 'assistant', 'hello')
    const { messages } = mapSessionEntries([entry])
    // 透传 = 直接传 message 体引用（浅拷贝不必要，消费侧只读）
    expect(messages[0]).toBe(entry.message)
    // 不注入 __entryId（M1 改用平行 entryIds）
    expect('__entryId' in (messages[0] as object)).toBe(false)
  })

  it('compaction → { role, summary, tokensBefore, timestamp }', () => {
    const { messages } = mapSessionEntries([compactionEntry('e1', '摘要', 9999)])
    const m = messages[0] as { role: string; summary: string; tokensBefore: number; timestamp: number }
    expect(m).toMatchObject({ role: 'compactionSummary', summary: '摘要', tokensBefore: 9999 })
    expect(typeof m.timestamp).toBe('number')
  })

  it('branch_summary → { role, summary, fromId, timestamp }', () => {
    const { messages } = mapSessionEntries([branchSummaryEntry('e1', 'fromX', '分支摘要')])
    const m = messages[0] as { role: string; summary: string; fromId: string; timestamp: number }
    expect(m).toMatchObject({ role: 'branchSummary', summary: '分支摘要', fromId: 'fromX' })
    expect(typeof m.timestamp).toBe('number')
  })

  it('空数组 → 三个产物都为空', () => {
    const result = mapSessionEntries([])
    expect(result.messages).toEqual([])
    expect(result.entryIds).toEqual([])
    expect(result.customDataEntries).toEqual([])
  })
})

// ── TC2：完成通知 custom_message display 覆写 false（方案 Z）────────

describe('TC2 完成通知 custom_message display 覆写 false', () => {
  it('subagent-bg-notify：pi 持久化 display:true → 覆写为 false', () => {
    const { messages } = mapSessionEntries([
      customMessageEntry('e1', 'subagent-bg-notify', { content: 'done', display: true }),
    ])
    expect((messages[0] as { display: boolean }).display).toBe(false)
  })

  it('workflow-result：pi 持久化 display:true → 覆写为 false', () => {
    const { messages } = mapSessionEntries([
      customMessageEntry('e1', 'workflow-result', { content: 'ok', display: true }),
    ])
    expect((messages[0] as { display: boolean }).display).toBe(false)
  })

  it('非完成通知 custom_message：display 不覆写（保留 pi 持久化值）', () => {
    const { messages } = mapSessionEntries([
      customMessageEntry('e1', 'status-bar', { content: 'x', display: true }),
    ])
    expect((messages[0] as { display: boolean }).display).toBe(true)
  })

  it('完成通知无 display 字段时仍覆写为 false（不依赖 pi 持久化值）', () => {
    const { messages } = mapSessionEntries([
      customMessageEntry('e1', 'subagent-bg-notify', { content: 'done' }),
    ])
    expect((messages[0] as { display: boolean }).display).toBe(false)
  })
})

// ── TC3：平行 entryIds 与 messages 对齐 ────────────────────────────

describe('TC3 平行 entryIds 与 messages 对齐', () => {
  it('entryIds[i] = messages[i] 来源 entry 的 id；长度一致', () => {
    const entries: PiSessionEntry[] = [
      msgEntry('m1'),
      compactionEntry('c1'),
      customMessageEntry('cm1', 'status-bar'),
      branchSummaryEntry('b1'),
      msgEntry('m2', 'assistant'),
    ]
    const { messages, entryIds } = mapSessionEntries(entries)

    expect(entryIds).toHaveLength(messages.length)
    expect(entryIds).toEqual(['m1', 'c1', 'cm1', 'b1', 'm2'])
  })

  it('custom/label 不产生 entryId（不进 messages，不对齐）', () => {
    const entries: PiSessionEntry[] = [
      msgEntry('m1'),
      customEntry('d1', 'taiji.client-msg-id', {}),
      labelEntry('l1'),
      compactionEntry('c1'),
    ]
    const { messages, entryIds } = mapSessionEntries(entries)

    expect(messages).toHaveLength(2)
    expect(entryIds).toEqual(['m1', 'c1'])
  })
})

// ── TC4：畸形 data 降级（不抛错）──────────────────────────────────

describe('TC4 畸形 data 降级', () => {
  it('custom_message 无 content → content 默认空串，不抛错', () => {
    // 模拟 session JSONL 截断/损坏：custom_message entry 缺 content 字段。
    // 类型契约（PiSessionCustomMessageEntry.content: string）描述 pi 正常输出，
    // mapper 作为系统边界必须对畸形数据降级，故测试用 as 模拟不合规输入。
    const malformed = [
      { type: 'custom_message', id: 'e1', parentId: null, timestamp: '2026-01-01T00:00:00Z', customType: 'status-bar' },
    ] as unknown as PiSessionEntry[]

    const { messages } = mapSessionEntries(malformed)
    const m = messages[0] as { content: string; display?: boolean }
    expect(m.content).toBe('')
    // 非完成通知 + 无 display → display undefined（不覆写）
    expect(m.display).toBeUndefined()
  })

  it('custom_message content 为非字符串（number）→ 默认空串', () => {
    const malformed = [
      { type: 'custom_message', id: 'e1', parentId: null, timestamp: '2026-01-01T00:00:00Z', customType: 'x', content: 123 },
    ] as unknown as PiSessionEntry[]

    const { messages } = mapSessionEntries(malformed)
    expect((messages[0] as { content: string }).content).toBe('')
  })

  it('custom 无 data → 仍进 customDataEntries，不抛错', () => {
    const malformed = [
      { type: 'custom', id: 'e1', parentId: null, timestamp: '2026-01-01T00:00:00Z', customType: 'taiji.client-msg-id' },
    ] as unknown as PiSessionEntry[]

    const { customDataEntries } = mapSessionEntries(malformed)
    expect(customDataEntries).toHaveLength(1)
  })

  it('compaction 缺 timestamp → 兜底 Date.now()，不抛错', () => {
    const malformed = [
      { type: 'compaction', id: 'e1', parentId: null, summary: 's', firstKeptEntryId: 'k', tokensBefore: 1 },
    ] as unknown as PiSessionEntry[]

    const before = Date.now()
    const { messages } = mapSessionEntries(malformed)
    const ts = (messages[0] as { timestamp: number }).timestamp
    const after = Date.now()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})

// ── applyEntryEndTimes：产出结束时刻回填（整个 agent-turn 聚合口径的时间轴右端）──────
//
// 语义：pi 在 appendMessage（message_end 之后）写 entry → entry.timestamp ≈ 该 assistant
// 消息产出结束；body message.timestamp 是其开始。两者差值即生成时长，是「单条 assistant 的
// turn 恒显 1s」修复的数据源。展示字段回填，不进 reducer（保 apply-entry 两路喂入同构）。

describe('applyEntryEndTimes assistant 产出结束时刻回填', () => {
  const ENTRY_TS = '2026-01-01T00:01:00.000Z'
  const ENTRY_MS = new Date(ENTRY_TS).getTime()

  function assistantMsg(over: Partial<Message> = {}): Message {
    return { id: 'm1', role: 'assistant', content: 'hi', status: 'complete', timestamp: ENTRY_MS - 5_000, ...over }
  }

  /** message entry 工厂（entry 时间戳独立于消息体时间戳） */
  function entryWithTs(id: string, role: 'user' | 'assistant'): PiSessionEntry {
    return { type: 'message', id, parentId: null, timestamp: ENTRY_TS, message: { role, content: [], timestamp: ENTRY_MS - 5_000 } as PiHistoryMessage }
  }

  it('assistant 消息按 piEntryId 回填 entry 时间戳（ISO → ms）——同一条消息 live/reload 同一语义', () => {
    const msgs = [assistantMsg({ piEntryId: 'e1' })]
    applyEntryEndTimes(msgs, [entryWithTs('e1', 'assistant')])
    expect(msgs[0].endedAt).toBe(ENTRY_MS)
  })

  it('user 消息不回填（无「产出结束」语义，不得污染「已工作」时长起点/终点）', () => {
    const msgs: Message[] = [{ id: 'u1', piEntryId: 'e1', role: 'user', content: [], status: 'complete', timestamp: ENTRY_MS - 5_000 }]
    applyEntryEndTimes(msgs, [entryWithTs('e1', 'user')])
    expect(msgs[0].endedAt).toBeUndefined()
  })

  it('entry 时间戳早于消息开始（时钟回拨/畸形数据）→ 不回填（消费侧回退 timestamp）', () => {
    const msgs = [assistantMsg({ piEntryId: 'e1', timestamp: ENTRY_MS + 1_000 })]
    applyEntryEndTimes(msgs, [entryWithTs('e1', 'assistant')])
    expect(msgs[0].endedAt).toBeUndefined()
  })

  it('窗口内无对应 entry（截断窗口）/ 无 piEntryId → 不回填（降级 = 修复前行为）', () => {
    const noEntry = [assistantMsg({ piEntryId: 'e-missing' })]
    applyEntryEndTimes(noEntry, [entryWithTs('e1', 'assistant')])
    expect(noEntry[0].endedAt).toBeUndefined()

    const noPiEntryId = [assistantMsg()]
    applyEntryEndTimes(noPiEntryId, [entryWithTs('e1', 'assistant')])
    expect(noPiEntryId[0].endedAt).toBeUndefined()
  })

  it('空 entries → 早退不抛错（空 session / 全非 message entry）', () => {
    const msgs = [assistantMsg({ piEntryId: 'e1' })]
    expect(() => applyEntryEndTimes(msgs, [])).not.toThrow()
    expect(msgs[0].endedAt).toBeUndefined()
  })
})
