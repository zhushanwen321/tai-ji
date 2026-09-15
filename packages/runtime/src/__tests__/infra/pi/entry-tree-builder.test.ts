import { describe, it, expect, vi } from 'vitest'
import { rebuildHistoryFromEntries } from '../../../infra/pi/entry-tree-builder.js'
import type { Segment, SegmentsMetadataFile } from '@taiji/shared'
import type {
  PiSessionEntry,
  PiSessionMessageEntry,
  PiSessionCustomEntry,
  PiSessionLabelEntry,
  PiSessionCompactionEntry,
  PiSessionBranchSummaryEntry,
  PiSessionCustomMessageEntry,
  PiHistoryMessage,
  PiHistoryToolResult,
  PiHistoryContentPart,
} from '../../../infra/pi/pi-protocol.js'

// ── 测试数据工厂 ────────────────────────────────────────────────────
// 参考 pi get_entries 真实返回结构（步骤 0 verify 脚本打印过）：
// entry.id 是 pi 生成的随机 id，parentId 串成树，timestamp 是 ISO string。

/** 构造 message entry。role/content/timestamp 可定制。 */
function makeMessageEntry(overrides: {
  id: string
  parentId?: string | null
  role?: 'user' | 'assistant'
  text?: string
  content?: PiHistoryContentPart[]
  timestamp?: string
}): PiSessionMessageEntry {
  return {
    type: 'message',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    message: {
      role: overrides.role ?? 'user',
      content: overrides.content ?? [{ type: 'text', text: overrides.text ?? 'hello' }],
      timestamp: Date.now(),
    },
  }
}

/**
 * 构造 toolResult message entry。
 *
 * toolResult 在 pi entry 树里也是 message entry（type:'message'），其 message.role='toolResult'，
 * 额外字段 toolCallId/toolName/isError/details。rebuildHistoryFromEntries 经 convertPiHistory
 * 把它合并到上一个 assistant.toolCalls[toolCallId 匹配]（C1 修复核心回归点）。
 */
function makeToolResultEntry(overrides: {
  id: string
  parentId?: string | null
  toolCallId: string
  toolName?: string
  text?: string
  isError?: boolean
  details?: Record<string, unknown>
  timestamp?: string
}): PiSessionMessageEntry {
  const message: PiHistoryToolResult = {
    role: 'toolResult',
    content: [{ type: 'text', text: overrides.text ?? 'tool output' }],
    timestamp: Date.now(),
    toolCallId: overrides.toolCallId,
    toolName: overrides.toolName ?? 'tool',
    ...(overrides.isError !== undefined && { isError: overrides.isError }),
    ...(overrides.details !== undefined && { details: overrides.details }),
  }
  return {
    type: 'message',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    message,
  }
}

/**
 * 构造"特殊 role" message entry（compactionSummary / custom / branchSummary）。
 *
 * 这些 role 在 pi get_messages 返回的扁平列表里是顶层 role，但 pi entry 树持久化时也作为
 * message entry 存储（type:'message'，message.role 为对应特殊值）。
 * rebuildHistoryFromEntries 提取 entry.message 后走 convertPiHistory，由其内部分支转成 system
 * 消息（C1 修复核心回归点——之前直接 convertSinglePiMessage 对这些 role 返回 null 丢弃）。
 */
function makeSpecialRoleEntry(overrides: {
  id: string
  parentId?: string | null
  role: 'compactionSummary' | 'custom' | 'branchSummary'
  // 角色专属字段透传到 message 上（用 Record 松结构，由调用方负责形状）
  message: Record<string, unknown>
  timestamp?: string
}): PiSessionMessageEntry {
  // 特殊 role（compactionSummary/custom/branchSummary）不在 PiHistoryMessage 的 role 联合里
  // （那是 pi get_messages 扁平历史 role；entry 树持久化时也作为 message entry 存）。
  // convertPiHistory 签名收 unknown[]，运行时按 m.role 字符串分派，故这里经 unknown 断言绕过 TS。
  const message = { role: overrides.role, content: [], timestamp: Date.now(), ...overrides.message } as unknown as PiHistoryMessage
  return {
    type: 'message',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    message,
  }
}

/**
 * 构造 taiji.client-msg-id custom entry。data 结构由 taiji extension 定义。
 *
 * `data` 参数语义：传 undefined → 用正常默认结构；传任何值（含 null / 畸形对象）→ 原样使用。
 * 用 'data' in overrides 检测是否显式传了 data（区分 undefined 默认 vs 显式 undefined），
 * 不用 ?? —— ?? 会把 null/undefined 都当 nullish 走默认，无法测试 data:null 降级。
 */
function makeClientMsgIdEntry(overrides: {
  id: string
  parentId?: string | null
  clientUuid: string
  userEntryId: string
  data?: unknown // 传任何值（含 null）原样用；不传则用正常默认结构
  timestamp?: string
}): PiSessionCustomEntry {
  const data = 'data' in overrides
    ? overrides.data
    : { clientUuid: overrides.clientUuid, userEntryId: overrides.userEntryId }
  return {
    type: 'custom',
    customType: 'taiji.client-msg-id',
    id: overrides.id,
    parentId: overrides.parentId ?? overrides.userEntryId,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.100Z',
    data,
  }
}

/** 构造 compaction entry（真实 type:'compaction'，M2 前 RPC 路径丢弃，M2 后转 system 消息）。 */
function makeCompactionEntry(overrides: {
  id: string
  parentId?: string | null
  summary?: string
  tokensBefore?: number
  firstKeptEntryId?: string
  timestamp?: string
}): PiSessionCompactionEntry {
  return {
    type: 'compaction',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    summary: overrides.summary ?? '已压缩',
    firstKeptEntryId: overrides.firstKeptEntryId ?? 'k1',
    tokensBefore: overrides.tokensBefore ?? 1000,
  }
}

/** 构造 branch_summary entry（真实 type:'branch_summary'，M2 前 RPC 路径丢弃，M2 后转 system 消息）。 */
function makeBranchSummaryEntry(overrides: {
  id: string
  parentId?: string | null
  fromId?: string
  summary?: string
  timestamp?: string
}): PiSessionBranchSummaryEntry {
  return {
    type: 'branch_summary',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    fromId: overrides.fromId ?? 'from-1',
    summary: overrides.summary ?? '分支摘要',
  }
}

/** 构造 custom_message entry（真实 type:'custom_message'，M2 前 RPC 路径丢弃，M2 后转 system 消息）。 */
function makeCustomMessageEntry(overrides: {
  id: string
  parentId?: string | null
  customType: string
  content?: string
  display?: boolean
  details?: Record<string, unknown>
  timestamp?: string
}): PiSessionCustomMessageEntry {
  return {
    type: 'custom_message',
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-07-25T10:00:00.000Z',
    customType: overrides.customType,
    content: overrides.content ?? '通知内容',
    ...(overrides.display !== undefined && { display: overrides.display }),
    ...(overrides.details !== undefined && { details: overrides.details }),
  }
}

/** 构造 segments sidecar。 */
function makeSegmentsMetadata(entries: SegmentsMetadataFile['entries']): SegmentsMetadataFile {
  return { version: 1, entries }
}

/** 从 Message.content 提取纯文本（Segment[] | string 归一）。测试断言辅助。 */
function contentToText(content: ReturnType<typeof rebuildHistoryFromEntries>['messages'][number]['content']): string {
  if (typeof content === 'string') return content
  return content.map((s) => (s.type === 'text' ? s.text : `[${s.type}]`)).join('')
}

describe('rebuildHistoryFromEntries', () => {
  // ── 用例 1：纯 message entry（无 custom）──────────────────────────
  it('case 1: pure message entries without custom → empty clientUuidMap, default textToSegments content', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msg00100', role: 'user', text: '看图' }),
      makeMessageEntry({ id: 'msg00101', role: 'assistant', text: '好的' }),
      makeMessageEntry({ id: 'msg00102', role: 'user', text: '再见' }),
    ]

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(3)
    expect(clientUuidMap.size).toBe(0)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    // user message content 是 textToSegments 默认产出（单个 text segment）
    expect(messages[0].content).toEqual([{ type: 'text', text: '看图' }])
    expect(messages[2].content).toEqual([{ type: 'text', text: '再见' }])
    // piEntryId 从 entry.id 填充
    expect(messages[0].piEntryId).toBe('msg00100')
    expect(messages[1].piEntryId).toBe('msg00101')
  })

  // ── 用例 2：映射命中 + segmentsMetadata 命中 → 回填完整 Segment[] ──
  it('case 2: clientUuid map hit + segmentsMetadata hit → content replaced with structured segments (incl image)', () => {
    const userEntryId = 'msg00200'
    const clientUuid = 'u-test-uuid-002'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '[图片 1] 看图' }),
      makeClientMsgIdEntry({ id: 'cus00200', clientUuid, userEntryId }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        // 完整结构化 Segment[]：image badge + text，还原 composer 提交时的 badge
        segments: [
          { type: 'image', id: 'img-1', path: '/tmp/a.png', fileName: 'a.png', displayName: '截图.png' },
          { type: 'text', text: '看图' },
        ],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    // user message content 被替换为完整结构化 segments（含 image badge）
    expect(messages[0].content).toEqual([
      { type: 'image', id: 'img-1', path: '/tmp/a.png', fileName: 'a.png', displayName: '截图.png' },
      { type: 'text', text: '看图' },
    ])
  })

  // ── 用例 3：映射命中但 segmentsMetadata 缺 → 保持默认产出 ──────────
  it('case 3: clientUuid map hit but segmentsMetadata null → keep default textToSegments content', () => {
    const userEntryId = 'msg00300'
    const clientUuid = 'u-test-uuid-003'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '[图片 1] 看图' }),
      makeClientMsgIdEntry({ id: 'cus00300', clientUuid, userEntryId }),
    ]

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(1)
    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    // segmentsMetadata 为 null → 保持 convertSinglePiMessage 默认产出（textToSegments，无 image badge）
    expect(messages[0].content).toEqual([{ type: 'text', text: '[图片 1] 看图' }])
  })

  // ── 用例 4：多 user message 顺序保留（部分有映射）────────────────
  it('case 4: multiple user messages preserve order, partial mapping backfills only mapped ones', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msg00400', role: 'user', text: '第一句（有映射）' }),
      makeClientMsgIdEntry({ id: 'cus00400', clientUuid: 'uuid-400', userEntryId: 'msg00400' }),
      makeMessageEntry({ id: 'msg00401', role: 'user', text: '第二句（无映射）' }),
      makeMessageEntry({ id: 'msg00402', role: 'user', text: '第三句（有映射）' }),
      makeClientMsgIdEntry({ id: 'cus00402', clientUuid: 'uuid-402', userEntryId: 'msg00402' }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid: 'uuid-400',
        segments: [{ type: 'file', path: '/a.ts' }, { type: 'text', text: '第一句（有映射）' }],
        timestamp: Date.now(),
      },
      {
        clientUuid: 'uuid-402',
        segments: [{ type: 'mention', name: 'user' }, { type: 'text', text: '第三句（有映射）' }],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(3)
    expect(clientUuidMap.size).toBe(2)
    // 顺序保留
    expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'user'])
    // 第 1、3 回填结构化 segments，第 2 默认 textToSegments
    expect(messages[0].content).toEqual([{ type: 'file', path: '/a.ts' }, { type: 'text', text: '第一句（有映射）' }])
    expect(messages[1].content).toEqual([{ type: 'text', text: '第二句（无映射）' }])
    expect(messages[2].content).toEqual([{ type: 'mention', name: 'user' }, { type: 'text', text: '第三句（有映射）' }])
  })

  // ── 用例 5：custom entry 在 message entry 之前（顺序无关）──────────
  it('case 5: custom entry before message entry → still matches (two-pass, order-independent)', () => {
    const userEntryId = 'msg00500'
    const clientUuid = 'u-test-uuid-005'
    const entries: PiSessionEntry[] = [
      // custom entry 先出现
      makeClientMsgIdEntry({ id: 'cus00500', clientUuid, userEntryId }),
      // message entry 后出现
      makeMessageEntry({ id: userEntryId, role: 'user', text: '看图' }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        segments: [{ type: 'image', id: 'img-5', path: '/tmp/b.png', fileName: 'b.png', displayName: 'b.png' }],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    // 仍能匹配并回填（两遍遍历，custom 在前不影响）
    expect(messages[0].content).toEqual([
      { type: 'image', id: 'img-5', path: '/tmp/b.png', fileName: 'b.png', displayName: 'b.png' },
    ])
  })

  // ── 用例 6：custom entry 在 message entry 之后（顺序无关）──────────
  it('case 6: custom entry after message entry → still matches (order-independent, reverse of case 5)', () => {
    const userEntryId = 'msg00600'
    const clientUuid = 'u-test-uuid-006'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '看图' }),
      makeClientMsgIdEntry({ id: 'cus00600', clientUuid, userEntryId }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        segments: [{ type: 'skill', name: 'review' }, { type: 'text', text: '看图' }],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    expect(messages[0].content).toEqual([
      { type: 'skill', name: 'review' },
      { type: 'text', text: '看图' },
    ])
  })

  // ── 用例 7：畸形 custom entry data → 跳过该 entry，不崩溃 ──────────
  it('case 7: malformed custom entry data (clientUuid not string) → skip entry, no crash, fallback to default', () => {
    const userEntryId = 'msg00700'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '看图' }),
      // 畸形 data：clientUuid 是 number（不是 string）
      makeClientMsgIdEntry({
        id: 'cus00700',
        clientUuid: 'ignored',
        userEntryId,
        data: { clientUuid: 12345, userEntryId }, // clientUuid 类型错
      }),
      // 另一个畸形 data：userEntryId 缺失
      makeClientMsgIdEntry({
        id: 'cus00701',
        clientUuid: 'ignored2',
        userEntryId,
        data: { clientUuid: 'only-uuid' }, // 缺 userEntryId
      }),
      // 第三个畸形 data：data 是 null
      makeClientMsgIdEntry({
        id: 'cus00702',
        clientUuid: 'ignored3',
        userEntryId,
        data: null,
      }),
    ]

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(1)
    // 所有畸形 custom entry 都被跳过，clientUuidMap 为空
    expect(clientUuidMap.size).toBe(0)
    // 无映射 → 默认 textToSegments 产出
    expect(messages[0].content).toEqual([{ type: 'text', text: '看图' }])
  })

  // ── 用例 8：label/other-custom 跳过；compaction M2 后转 system 消息 ──
  // M2 语义变化：compaction（type:'compaction'）经 mapSessionEntries 转成 compactionSummary
  // 伪消息 → convertPiHistory 产 system 消息。M2 前 RPC 路径丢弃它（违反关键规则 9）。
  it('case 8: label/other-custom skipped; compaction → system message (M2: was dropped, now preserved)', () => {
    const labelEntry: PiSessionLabelEntry = {
      type: 'label',
      id: 'lbl00800',
      parentId: null,
      timestamp: '2026-07-25T10:00:00.000Z',
      label: '重要',
      targetId: 'msg00800',
    }
    // compaction entry：M2 前被 RPC 路径丢弃，M2 后经 mapSessionEntries 转 system 消息（关键规则 9 修复）
    const compactionEntry: PiSessionCompactionEntry = {
      type: 'compaction',
      id: 'sum00800',
      parentId: null,
      timestamp: '2026-07-25T10:00:00.000Z',
      summary: '已压缩',
      firstKeptEntryId: 'msg00800',
      tokensBefore: 1000,
    }
    // 非 taiji.client-msg-id 的 custom entry → 进 customDataEntries，不进 messages，不影响 clientUuidMap
    const otherCustomEntry: PiSessionCustomEntry = {
      type: 'custom',
      customType: 'other.extension-type',
      id: 'cus00800',
      parentId: null,
      timestamp: '2026-07-25T10:00:00.000Z',
      data: { foo: 'bar' },
    }

    const entries: PiSessionEntry[] = [
      labelEntry,
      makeMessageEntry({ id: 'msg00800', role: 'user', text: '正常消息' }),
      compactionEntry,
      otherCustomEntry,
    ]

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, null)

    // message(user) + compaction(system) = 2 条；label 跳过；other custom 分流到 customDataEntries
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system'])
    expect(messages[0].content).toEqual([{ type: 'text', text: '正常消息' }])
    // compaction 转 system 消息 + compactionSummary 字段（M2 修复，关键规则 9）
    expect(messages[1].compactionSummary).toMatchObject({ summary: '已压缩', tokensBefore: 1000 })
    // other custom（非 taiji.client-msg-id）不影响 clientUuidMap
    expect(clientUuidMap.size).toBe(0)
  })

  // ── 补充用例 9：assistant message 不回填 segments（只 user 回填）───
  it('case 9 (extra): assistant message never backfills segments even with mapping (only user role backfills)', () => {
    const assistantEntryId = 'msg00900'
    const clientUuid = 'u-test-uuid-009'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: assistantEntryId, role: 'assistant', text: 'assistant 回复' }),
      // 恶意/异常：custom entry 指向 assistant entry（正常不该发生，但防御）
      makeClientMsgIdEntry({ id: 'cus00900', clientUuid, userEntryId: assistantEntryId }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        segments: [{ type: 'image', id: 'img-9', path: '/tmp/c.png', fileName: 'c.png', displayName: 'c.png' }],
        timestamp: Date.now(),
      },
    ])

    const { messages } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    // assistant message content 保持 string（不被 segments 覆盖），只 user 回填
    expect(messages[0].content).toBe('assistant 回复')
  })

  // ── 补充用例 10：空 segments sidecar 条目（segments: []）不覆盖默认 ──
  it('case 10 (extra): empty segments in sidecar (segments: []) → do not override default (avoid clearing valid default)', () => {
    const userEntryId = 'msg01000'
    const clientUuid = 'u-test-uuid-010'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '看图' }),
      makeClientMsgIdEntry({ id: 'cus01000', clientUuid, userEntryId }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      { clientUuid, segments: [], timestamp: Date.now() }, // 空 segments
    ])

    const { messages } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages).toHaveLength(1)
    // 空 segments 不覆盖默认产出（避免把有效 textToSegments 结果清空成空数组）
    expect(contentToText(messages[0].content)).toBe('看图')
  })

  // ════════════════════════════════════════════════════════════════════
  // C1 回归测试：toolResult / compactionSummary / custom / branchSummary
  // ════════════════════════════════════════════════════════════════════
  // 背景：rebuildHistoryFromEntries 原本直接调 convertSinglePiMessage，对 toolResult/特殊 role
  // 返回 null 全部丢弃。C1 修复改为整批走 convertPiHistory，复用 toolResult 合并 +
  // compactionSummary/custom/branchSummary → system 消息处理（AGENTS.md 关键规则 9：可重开恢复）。
  // 以下 5 个用例覆盖这 4 类 entry 的还原，是 C1 回归的硬性 gate。

  // ── C1 用例 1：toolResult 合并到上一个 assistant.toolCalls ──────────
  it('C1 case 1: toolResult message entry → merged into preceding assistant.toolCalls (output/outputRaw/isError/details restored)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({
        id: 'msg-c1-01',
        role: 'assistant',
        content: [{ type: 'text', text: 'Let me check' }],
      }),
      makeMessageEntry({
        id: 'msg-c1-02',
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-c1-1', name: 'readFile', arguments: { path: '/foo' } },
        ],
      }),
      makeToolResultEntry({
        id: 'msg-c1-03',
        toolCallId: 'tc-c1-1',
        toolName: 'readFile',
        text: 'file contents here',
        details: {
          __gui__: { v: 1, component: { type: 'stats-line', props: { items: [] } } },
        },
      }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // toolResult 不产独立 message（合并到上一个 assistant），共 2 条（text assistant + toolCall assistant）
    expect(messages).toHaveLength(2)
    const toolCallAssistant = messages[1]
    expect(toolCallAssistant.role).toBe('assistant')
    expect(toolCallAssistant.toolCalls).toHaveLength(1)
    const tc = toolCallAssistant.toolCalls![0]
    expect(tc.id).toBe('tc-c1-1')
    // ★ C1 核心断言：output 还原（之前丢失）
    expect(tc.output).toBe('file contents here')
    // status: 非 error → completed（默认值，不被 toolResult 改写）
    expect(tc.status).toBe('completed')
    // ★ C1 核心断言：details（含 __gui__）透传（之前丢失，违反关键规则 9）
    expect(tc.details).toEqual({
      __gui__: { v: 1, component: { type: 'stats-line', props: { items: [] } } },
    })
  })

  // ── C1 用例 2：toolResult isError=true → toolCall.status='error' ────
  it('C1 case 2: toolResult isError=true → merged toolCall.status="error" (was lost before C1)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({
        id: 'msg-c1-10',
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-c1-2', name: 'bash', arguments: { cmd: 'exit 1' } },
        ],
      }),
      makeToolResultEntry({
        id: 'msg-c1-11',
        toolCallId: 'tc-c1-2',
        toolName: 'bash',
        text: 'command failed',
        isError: true,
      }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(1)
    // ★ C1 核心断言：error 状态还原（之前 toolResult 被丢，status 恒为 completed）
    expect(messages[0].toolCalls![0].status).toBe('error')
    expect(messages[0].toolCalls![0].output).toBe('command failed')
  })

  // ── C1 用例 3：compactionSummary message entry → system 消息 ────────
  it('C1 case 3: compactionSummary message entry → system message with compactionSummary field (was lost before C1)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msg-c1-20', role: 'user', text: '问题' }),
      makeSpecialRoleEntry({
        id: 'msg-c1-21',
        role: 'compactionSummary',
        message: { summary: '上下文已压缩', tokensBefore: 10000, timestamp: 12345 },
      }),
      makeMessageEntry({ id: 'msg-c1-22', role: 'assistant', text: '回答' }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // user + system(compaction) + assistant = 3 条（之前 compactionSummary 被丢，只剩 2 条）
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    const sysMsg = messages[1]
    // ★ C1 核心断言：compactionSummary 字段还原
    expect(sysMsg.compactionSummary).toEqual({
      summary: '上下文已压缩',
      tokensBefore: 10000,
      timestamp: 12345,
    })
    expect(sysMsg.content).toBe('上下文已压缩')
  })

  // ── C1 用例 4：custom message entry (bg-notify) → system 消息 ───────
  it('C1 case 4: custom message entry (subagent-bg-notify) → system message with customType + details (was lost before C1)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msg-c1-30', role: 'user', text: 'run subagent' }),
      makeSpecialRoleEntry({
        id: 'msg-c1-31',
        role: 'custom',
        message: {
          customType: 'subagent-bg-notify',
          content: 'Subagent "coder" (job-1) completed. Result:\nDone.',
          details: {
            id: 'job-1',
            status: 'done',
            agent: 'coder',
            model: 'claude-4.5',
            result: 'Done.',
            startedAt: 1000,
            endedAt: 13000,
          },
          display: true,
        },
      }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // user + system(custom) = 2 条（之前 custom 被丢，只剩 1 条）
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system'])
    const sysMsg = messages[1]
    // ★ C1 核心断言：customType + details 还原（bgNotify 派生字段已删，§3.3.6）
    expect(sysMsg.customType).toBe('subagent-bg-notify')
    expect(sysMsg.details).toEqual({
      id: 'job-1',
      status: 'done',
      agent: 'coder',
      model: 'claude-4.5',
      result: 'Done.',
      startedAt: 1000,
      endedAt: 13000,
    })
    // display 透传
    expect(sysMsg.display).toBe(true)
  })

  // ── C1 用例 5：branchSummary message entry → system 消息 ────────────
  it('C1 case 5: branchSummary message entry → system message with branchSummary field (was lost before C1)', () => {
    const entries: PiSessionEntry[] = [
      makeSpecialRoleEntry({
        id: 'msg-c1-40',
        role: 'branchSummary',
        message: { summary: '分支摘要内容', fromId: 'msg-abc', timestamp: 456 },
      }),
      makeMessageEntry({ id: 'msg-c1-41', role: 'assistant', text: '继续' }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // system(branch) + assistant = 2 条（之前 branchSummary 被丢，只剩 1 条）
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['system', 'assistant'])
    const sysMsg = messages[0]
    // ★ C1 核心断言：branchSummary 字段还原
    expect(sysMsg.branchSummary).toEqual({
      summary: '分支摘要内容',
      fromId: 'msg-abc',
      timestamp: 456,
    })
    expect(sysMsg.content).toBe('分支摘要内容')
  })

  // ── C1 用例 6：完整混合流（user→assistant→toolResult→compaction→custom→assistant）──
  it('C1 case 6: mixed stream (toolResult + compaction + custom + user messages) all restored in order', () => {
    const userEntryId = 'msg-c1-50'
    const clientUuid = 'u-c1-mixed'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: userEntryId, role: 'user', text: '开始' }),
      makeClientMsgIdEntry({ id: 'cus-c1-50', clientUuid, userEntryId }),
      makeMessageEntry({
        id: 'msg-c1-51',
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-mix', name: 'read', arguments: { path: '/x' } }],
      }),
      makeToolResultEntry({
        id: 'msg-c1-52',
        toolCallId: 'tc-mix',
        text: 'ok',
      }),
      makeSpecialRoleEntry({
        id: 'msg-c1-53',
        role: 'compactionSummary',
        message: { summary: '压缩', tokensBefore: 500, timestamp: 999 },
      }),
      makeSpecialRoleEntry({
        id: 'msg-c1-54',
        role: 'custom',
        message: { customType: 'subagent-bg-notify', content: 'bg done', details: { id: 'j', status: 'done', agent: 'a', startedAt: 1 } },
      }),
      makeMessageEntry({ id: 'msg-c1-55', role: 'assistant', text: '完成' }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid,
        segments: [{ type: 'image', id: 'img-mix', path: '/tmp/m.png', fileName: 'm.png', displayName: 'm.png' }],
        timestamp: Date.now(),
      },
    ])

    const { messages, clientUuidMap } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(clientUuidMap.get(userEntryId)).toBe(clientUuid)
    // user(toolResult 合并不产独立 msg) + system(compaction) + system(custom) + assistant = 5
    expect(messages).toHaveLength(5)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'system', 'assistant'])
    // user message 回填 image badge（segments 回填与 C1 修复正交，但同时生效）
    expect(messages[0].content).toEqual([
      { type: 'image', id: 'img-mix', path: '/tmp/m.png', fileName: 'm.png', displayName: 'm.png' },
    ])
    // toolResult 合并到 messages[1] 的 toolCall
    expect(messages[1].toolCalls![0].output).toBe('ok')
    // compaction system message
    expect(messages[2].compactionSummary).toBeDefined()
    // custom system message
    expect(messages[3].customType).toBe('subagent-bg-notify')
  })

  // ════════════════════════════════════════════════════════════════════
  // M2 integration 测试：mapSessionEntries 接入（真实 entry type / clientUuidMap / entryIds）
  // ════════════════════════════════════════════════════════════════════
  // 背景：M2 把 rebuildHistoryFromEntries 第一遍扫描改为 mapSessionEntries（共享单点）。
  // C1 用例 3-6 用 type:'message' + 特殊 role 入口（绕过 entry type 分派），验证 convertPiHistory
  // 的 role 分支；TC1-3 用真实 entry type（compaction/branch_summary/custom_message），验证
  // mapSessionEntries 的 entry type → 伪消息映射 + clientUuidMap 从 customDataEntries 建 + entryIds 平行传。

  // ── TC1：真实 entry type（compaction/branch_summary/custom_message）→ system 消息 ──
  it('TC1: real entry types (compaction/branch_summary/custom_message) → system messages (was dropped before M2)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'tc1-1', role: 'user', text: '问题' }),
      makeCompactionEntry({ id: 'tc1-2', summary: '上下文已压缩', tokensBefore: 8000 }),
      makeBranchSummaryEntry({ id: 'tc1-3', fromId: 'msg-old', summary: '分支摘要内容' }),
      makeCustomMessageEntry({ id: 'tc1-4', customType: 'subagent-bg-notify', content: '完成' }),
      makeMessageEntry({ id: 'tc1-5', role: 'assistant', text: '回答' }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // user + system(compaction) + system(branch) + system(custom) + assistant = 5
    // M2 前 RPC 路径只产 user + assistant = 2（丢三类，违反关键规则 9）
    expect(messages).toHaveLength(5)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'system', 'system', 'assistant'])
    // compaction → system + compactionSummary 字段
    expect(messages[1].compactionSummary).toMatchObject({ summary: '上下文已压缩', tokensBefore: 8000 })
    // branch_summary → system + branchSummary 字段
    expect(messages[2].branchSummary).toMatchObject({ summary: '分支摘要内容', fromId: 'msg-old' })
    // custom_message → system + customType + display:false（完成通知类覆写，方案 Z，shared SSOT）
    expect(messages[3].customType).toBe('subagent-bg-notify')
    expect(messages[3].display).toBe(false)
  })

  // ── TC2：clientUuidMap 从 customDataEntries 建（含冲突 warn 防御）────────
  it('TC2: clientUuidMap built from customDataEntries (incl. conflict warn defense, later wins)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'tc2-1', role: 'user', text: 'hi' }),
      makeClientMsgIdEntry({ id: 'tc2-c1', clientUuid: 'uuid-a', userEntryId: 'tc2-1' }),
      // 冲突：同一 userEntryId 两条 custom entry（extension 重试/重发场景）
      makeClientMsgIdEntry({ id: 'tc2-c2', clientUuid: 'uuid-b', userEntryId: 'tc2-1' }),
      // 非 taiji.client-msg-id 的 custom entry → 进 customDataEntries 但不进 clientUuidMap
      {
        type: 'custom',
        customType: 'other.extension',
        id: 'tc2-c3',
        parentId: null,
        timestamp: '2026-07-25T10:00:00.000Z',
        data: { foo: 'bar' },
      } as PiSessionCustomEntry,
    ]

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { clientUuidMap } = rebuildHistoryFromEntries(entries, null)

      // 后写覆盖前写（uuid-b 是后写的）
      expect(clientUuidMap.get('tc2-1')).toBe('uuid-b')
      expect(clientUuidMap.size).toBe(1)
      // 冲突 warn 触发
      expect(warnSpy).toHaveBeenCalled()
      expect(warnSpy.mock.calls[0][0]).toContain('clientUuidMap conflict')
      expect(warnSpy.mock.calls[0][0]).toContain('tc2-1')
    } finally {
      warnSpy.mockRestore()
    }
  })

  // ── TC3：entryIds 平行传 convertPiHistory（user/assistant piEntryId 正确）──
  it('TC3: entryIds passed in parallel to convertPiHistory → user/assistant piEntryId filled (fork positioning)', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'tc3-m1', role: 'user', text: '第一句' }),
      makeCompactionEntry({ id: 'tc3-c1', summary: '压缩', tokensBefore: 100 }),
      makeBranchSummaryEntry({ id: 'tc3-b1', summary: '分支' }),
      makeMessageEntry({ id: 'tc3-m2', role: 'assistant', text: '回复' }),
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // user + system(compaction) + system(branch) + assistant
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'system', 'assistant'])
    // user/assistant piEntryId 从平行 entryIds 取（fork 定位截断点用）
    expect(messages[0].piEntryId).toBe('tc3-m1')
    expect(messages[3].piEntryId).toBe('tc3-m2')
    // 伪消息（compaction/branch system 消息）无 piEntryId（convertPiHistory 只给 user/assistant 填）
    expect(messages[1].piEntryId).toBeUndefined()
    expect(messages[2].piEntryId).toBeUndefined()
  })
})

// ── [defer segments 化 / D-A1-2 ③] defer 裸标记 id 直查回填（send/steer 条目同链——
//    defer 条目结构上无 clientUuid custom entry 映射，回填走 deferEntryId 兜底链）。──
describe('rebuildHistoryFromEntries deferEntryId 回填（defer segments 化 / D-A1-2）', () => {
  const DEFER_ID_1 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  const DEFER_ID_2 = '3f2504e0-4f89-41d3-9a0c-0305e82c3302'
  const RICH_SEGS: Segment[] = [
    { type: 'image', id: 'img-1', path: '/tmp/shot.png', fileName: 'shot.png', displayName: '截图.png' },
    { type: 'text', text: '帮我看下这个报错' },
  ]

  /** 构造带 defer 裸标记尾的 user message entry（pi 落盘形态：文本 + <!--taiji:msg:...-->） */
  function makeDeferUserEntry(id: string, deferId: string, text: string): PiSessionEntry {
    return makeMessageEntry({ id, role: 'user', text: `${text}\n<!--taiji:msg:${deferId}-->` })
  }

  it('case D1: defer 条目（send/steer 通道落盘同形态）→ 裸标记 id 直查 sidecar 回填完整 segments（标记已被 convert 剥离）', () => {
    // 两条 defer 条目：队首走 send、第二条走 steer——pi 落盘文本形态一致（尾部裸标记，
    // send 通道 input hook 只认 u- 前缀不剥裸标记；steer 通道无 hook）
    const entries: PiSessionEntry[] = [
      makeDeferUserEntry('msgD0010', DEFER_ID_1, '帮我看下这个报错'),
      makeDeferUserEntry('msgD0020', DEFER_ID_2, '第二条'),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      { deferEntryId: DEFER_ID_1, segments: RICH_SEGS, timestamp: Date.now() },
      {
        deferEntryId: DEFER_ID_2,
        segments: [
          { type: 'text', text: '第二条' },
          { type: 'file', path: '/a/b.ts' },
        ],
        timestamp: Date.now(),
      },
    ])

    const { messages } = rebuildHistoryFromEntries(entries, segmentsMeta)

    // 回填命中：完整结构化 segments（含 image badge / file chip）
    expect((messages[0].content as typeof RICH_SEGS)).toEqual(RICH_SEGS)
    expect(messages[1].content).toEqual([
      { type: 'text', text: '第二条' },
      { type: 'file', path: '/a/b.ts' },
    ])
    // 无 clientUuid 映射（defer 条目不写 custom entry——buildClientUuidMap 空）
  })

  it('case D2: u- 前缀标记（直发链）不进 defer 直查链——u- 形态不匹配裸 uuid 正则，deferEntryId 回填不触发', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msgD0021', role: 'user', text: 'T\n<!--taiji:msg:u-3f2504e0-4f89-41d3-9a0c-0305e82c3301-->' }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      { deferEntryId: DEFER_ID_1, segments: RICH_SEGS, timestamp: Date.now() },
    ])

    const { messages } = rebuildHistoryFromEntries(entries, segmentsMeta)

    // 不回填：保持默认产出（textToSegments 纯文本，含标记原文——id 空间互斥回归锁定）
    expect(messages[0].content).toEqual([{ type: 'text', text: 'T\n<!--taiji:msg:u-3f2504e0-4f89-41d3-9a0c-0305e82c3301-->' }])
  })

  it('case D3: 正文裸 uuid 无标记包裹（非 defer 消息恰含 uuid 字符串）→ 不误命中（正则要求完整标记形态）', () => {
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msgD0022', role: 'user', text: `参考任务 ${DEFER_ID_1} 的输出` }),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      { deferEntryId: DEFER_ID_1, segments: RICH_SEGS, timestamp: Date.now() },
    ])

    const { messages } = rebuildHistoryFromEntries(entries, segmentsMeta)

    // 不回填：裸 uuid 字符串不构成 <!--taiji:msg:...--> 标记，deferIdByEntryId 为空
    expect(messages[0].content).toEqual([{ type: 'text', text: `参考任务 ${DEFER_ID_1} 的输出` }])
  })

  it('case D4: 裸标记 id 与 sidecar deferEntryId 不一致 → 不回填（全等匹配防御）', () => {
    const entries: PiSessionEntry[] = [
      makeDeferUserEntry('msgD0023', DEFER_ID_2, '文本'),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      { deferEntryId: DEFER_ID_1, segments: RICH_SEGS, timestamp: Date.now() },
    ])

    const { messages } = rebuildHistoryFromEntries(entries, segmentsMeta)

    // 标记提取到 DEFER_ID_2 但 sidecar 只有 DEFER_ID_1 → 直查失配，保持默认产出
    expect(messages[0].content).toEqual([{ type: 'text', text: '文本' }])
  })

  it('case D5: defer 条目与直发条目混排——clientUuid 链先、deferEntryId 兜底，两链各自命中不串扰', () => {
    const directUuid = 'u-direct-uuid-005'
    const entries: PiSessionEntry[] = [
      makeMessageEntry({ id: 'msgD0030', role: 'user', text: '直发消息' }),
      makeClientMsgIdEntry({ id: 'cusD0030', clientUuid: directUuid, userEntryId: 'msgD0030' }),
      makeDeferUserEntry('msgD0031', DEFER_ID_1, 'defer 消息'),
    ]
    const segmentsMeta = makeSegmentsMetadata([
      {
        clientUuid: directUuid,
        segments: [{ type: 'text', text: '直发消息' }, { type: 'skill', name: 'review' }],
        timestamp: Date.now(),
      },
      { deferEntryId: DEFER_ID_1, segments: RICH_SEGS, timestamp: Date.now() },
    ])

    const { messages } = rebuildHistoryFromEntries(entries, segmentsMeta)

    expect(messages[0].content).toEqual([
      { type: 'text', text: '直发消息' },
      { type: 'skill', name: 'review' },
    ])
    expect(messages[1].content).toEqual(RICH_SEGS)
  })
})
