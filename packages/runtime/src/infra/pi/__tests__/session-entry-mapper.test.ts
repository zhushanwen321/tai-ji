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
import { describe, it, expect, vi } from 'vitest'
import { applyEntryEndTimes, computeActivePathEntries, mapSessionEntries } from '../session-entry-mapper.js'
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

  it('RT-3#6：compaction 缺 timestamp → 省略 timestamp 字段（不伪造时刻），warn 计数', () => {
    const malformed = [
      { type: 'compaction', id: 'e1', parentId: null, summary: 's', firstKeptEntryId: 'k', tokensBefore: 1 },
    ] as unknown as PiSessionEntry[]

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { messages } = mapSessionEntries(malformed)
      // 旧兜底 Date.now() 已禁（伪造原始时刻不可追溯）：字段省略，消费侧 lift 单点兜底
      expect('timestamp' in (messages[0] as Record<string, unknown>)).toBe(false)
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('missing or malformed timestamp'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('RT-3#6：畸形 timestamp（不可解析串）→ 省略字段（NaN 不入产物，不抛错）', () => {
    const malformed = [
      { type: 'branch_summary', id: 'e1', parentId: null, timestamp: 'not-a-date', fromId: 'f', summary: 's' },
      { type: 'custom_message', id: 'e2', parentId: null, timestamp: '2026-13-45T99:99:99Z', customType: 't', content: 'c' },
    ] as unknown as PiSessionEntry[]

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { messages } = mapSessionEntries(malformed)
      expect('timestamp' in (messages[0] as Record<string, unknown>)).toBe(false)
      expect('timestamp' in (messages[1] as Record<string, unknown>)).toBe(false)
      const warn = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('mapSessionEntries'))
      expect(warn).toBeDefined()
      expect(warn).toContain('2 entry/entries')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('RT-3#6：合法 timestamp 正常产出（正向对照，字段仍在）', () => {
    const { messages } = mapSessionEntries([compactionEntry('e-ok')])
    expect((messages[0] as { timestamp: number }).timestamp).toBe(new Date('2026-01-01T00:00:00Z').getTime())
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

  it('RT-3#6：entry timestamp 畸形（不可解析/非字符串）→ 不回填 endedAt（NaN 不得入产物）+ warn', () => {
    const msgs = [assistantMsg({ piEntryId: 'e1' })]
    const badEntries = [
      { type: 'message', id: 'e1', parentId: null, timestamp: 'not-a-date', message: { role: 'assistant', content: [], timestamp: 1 } },
      { type: 'message', id: 'e2', parentId: null, timestamp: 12345, message: { role: 'assistant', content: [], timestamp: 1 } },
    ] as unknown as PiSessionEntry[]
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      applyEntryEndTimes(msgs, badEntries)
      expect(msgs[0].endedAt).toBeUndefined()
      const warn = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('applyEntryEndTimes'))
      expect(warn).toBeDefined()
      expect(warn).toContain('2 entry/entries')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── 活跃路径裁剪（message-revoke U6a）：computeActivePathEntries + mapSessionEntries leafId ──

describe('computeActivePathEntries（活跃路径裁剪纯函数，message-revoke U6a）', () => {
  /**
   * 有分支 fixture（真实 pi 撤回形态，单根链式树）：
   * r(root) → u1 → a1 → [旧分支 m1(被撤消息) → a2(其回复)] / [label(撤回锚，parent=a1) → u2 → a3]
   * leafId = a3（文件尾）；被撤子树 {m1, a2} 按文件序在 label 之前但不在活跃路径上。
   */
  function branchedEntries(): PiSessionEntry[] {
    const withParent = (e: PiSessionEntry, parentId: string | null): PiSessionEntry => ({ ...e, parentId })
    return [
      withParent(msgEntry('r', 'user', 'root'), null),
      withParent(msgEntry('u1', 'user', '第一句'), 'r'),
      withParent(msgEntry('a1', 'assistant', '回复一'), 'u1'),
      // 旧分支（被撤）：撤回 m1 → 叶子回退到其父 a1
      withParent(msgEntry('m1', 'user', '发错的'), 'a1'),
      withParent(msgEntry('a2', 'assistant', '对发错的回复'), 'm1'),
      // label entry（撤回持久化锚，parent = 回退后叶子 a1）+ 新分支
      withParent({ type: 'label', id: 'lbl', timestamp: '2026-01-01T00:00:00Z', label: 'taiji:revoked', targetId: 'm1' } as PiSessionEntry, 'a1'),
      withParent(msgEntry('u2', 'user', '撤回后新消息'), 'lbl'),
      withParent(msgEntry('a3', 'assistant', '新回复'), 'u2'),
    ]
  }

  it('有分支：leafId 沿 parentId 回溯，旧分支条目被滤，输出保持输入（文件）序', () => {
    const out = computeActivePathEntries(branchedEntries(), 'a3')
    expect(out.map((e) => e.id)).toEqual(['r', 'u1', 'a1', 'lbl', 'u2', 'a3'])
    expect(out.some((e) => e.id === 'm1' || e.id === 'a2')).toBe(false)
  })

  it('无分支（链式单根）：leafId 缺省与传「文件尾 entry id」输出逐条一致（回归不变）', () => {
    const linear = [
      { ...msgEntry('e1', 'user'), parentId: null },
      { ...msgEntry('e2', 'assistant'), parentId: 'e1' },
      { ...msgEntry('e3', 'user'), parentId: 'e2' },
    ]
    const untouched = computeActivePathEntries(linear, undefined)
    expect(untouched).toBe(linear) // 缺省 = 原数组原样返回（同一引用）
    expect(computeActivePathEntries(linear, 'e3')).toEqual(linear) // 尾 id = 全链，逐条一致
  })

  it('leafId 指向中间节点：裁剪到该节点为止（leafId 驱动，非文件序）', () => {
    const out = computeActivePathEntries(branchedEntries(), 'a1')
    expect(out.map((e) => e.id)).toEqual(['r', 'u1', 'a1'])
  })

  it('leafId 不在 entries 的 id 集合 → warn 后原样返回（fail-safe，不清空历史）', () => {
    const entries = branchedEntries()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = computeActivePathEntries(entries, 'no-such-leaf')
      expect(out).toBe(entries)
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('leafId no-such-leaf not found'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('多根病态树（合法 pi 文件恰一个根）→ warn 后原样返回（活跃路径未定义，退回裁剪前行为）', () => {
    const multiRoot = [msgEntry('e1', 'user'), msgEntry('e2', 'user')] // 两条 parentId 均为 null
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = computeActivePathEntries(multiRoot, 'e2')
      expect(out).toBe(multiRoot)
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('without parent link'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('窗口切片（无根、首条 parent 在集合外）→ 回溯到窗口边界即止，窗口内非链条目被滤', () => {
    // 尾读窗口形态：首条 parent 指向窗口外（rootLikeCount = 0，单根检查不触发）
    const window = [
      { ...msgEntry('x1', 'assistant', '窗口内旧分支残余'), parentId: 'outside' },
      { ...msgEntry('y1', 'user', '活跃路径上的窗口首条'), parentId: 'outside' },
      { ...msgEntry('y2', 'assistant'), parentId: 'y1' },
    ]
    // leafId = 窗口末条 y2：链 y2→y1→outside（边界止）；x1 不在链上被滤
    expect(computeActivePathEntries(window, 'y2').map((e) => e.id)).toEqual(['y1', 'y2'])
  })

  it('环状 parentId（文件损坏）→ 已访问集防御不死循环', () => {
    const cyclic = [
      { ...msgEntry('c1', 'user'), parentId: 'c2' },
      { ...msgEntry('c2', 'user'), parentId: 'c1' },
    ]
    const out = computeActivePathEntries(cyclic, 'c1') // 若无防御此处死循环挂死测试
    expect(out.map((e) => e.id).sort()).toEqual(['c1', 'c2'])
  })
})

describe('mapSessionEntries leafId 参数（活跃路径裁剪接入，message-revoke U6a）', () => {
  function branchedEntriesWithCustom(): PiSessionEntry[] {
    const withParent = (e: PiSessionEntry, parentId: string | null): PiSessionEntry => ({ ...e, parentId })
    return [
      withParent(msgEntry('r', 'user', 'root'), null),
      withParent(msgEntry('m1', 'user', '发错的'), 'r'),
      // 被撤消息的 custom entry（parent = m1，随旧分支同生死）
      withParent({ type: 'custom', customType: 'taiji.client-msg-id', id: 'cus1', timestamp: '2026-01-01T00:00:00Z', data: { clientUuid: 'u-x', userEntryId: 'm1' } } as PiSessionEntry, 'm1'),
      withParent({ type: 'label', id: 'lbl', timestamp: '2026-01-01T00:00:00Z', label: 'taiji:revoked', targetId: 'm1' } as PiSessionEntry, 'r'),
      withParent(msgEntry('u2', 'user', '新消息'), 'lbl'),
    ]
  }

  it('有分支：旧分支的 message 与 custom entry 均被滤（映射失效即正确语义）', () => {
    const { messages, entryIds, customDataEntries } = mapSessionEntries(branchedEntriesWithCustom(), 'u2')
    expect(entryIds).toEqual(['r', 'u2']) // m1 不在 messages；label 走 default 跳过
    expect(messages.map((m) => (m as { role: string }).role)).toEqual(['user', 'user'])
    expect(customDataEntries).toHaveLength(0) // 被撤消息的映射 entry 随分支滤除
  })

  it('无分支回归：leafId 缺省与传文件尾 entry id，三个产物数组逐条一致', () => {
    const linear = [
      { ...msgEntry('e1', 'user'), parentId: null },
      { ...customMessageEntry('e2', 'subagent-bg-notify'), parentId: 'e1' },
      { ...msgEntry('e3', 'assistant'), parentId: 'e2' },
    ]
    const withoutLeaf = mapSessionEntries(linear)
    const withLeaf = mapSessionEntries(linear, 'e3')
    expect(withLeaf.messages).toEqual(withoutLeaf.messages)
    expect(withLeaf.entryIds).toEqual(withoutLeaf.entryIds)
    expect(withLeaf.customDataEntries).toEqual(withoutLeaf.customDataEntries)
  })
})
