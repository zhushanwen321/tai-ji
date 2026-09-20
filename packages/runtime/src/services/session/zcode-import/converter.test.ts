/**
 * zcode→pi 转换器测试：消息级投影分派（classifyMessage → §7.3 落点映射表：六策略落点 /
 * L1-L2 归类聚合 / unclassified sample / G1 user entry 数收敛）+ part 级映射（§3.4
 * T1-T6/T3b/T3c 权威映射表逐条）+ 结构化降级断言（code/kind/source/count/sample.messageId
 * 维度——禁 preview 字符串匹配残留，诊断措辞不进断言）。
 *
 * 三层断言：
 * 1. 纯函数直测：内存行集（不建真库）→ 产物行逐条断言（映射表即验收标准）
 * 2. 重放锚（A1/V3）：产物经 mapSessionEntries → convertPiHistory（= runtime 现有
 *    replayEntries(applyEntry) 消费链，F4）重放无异常 + 消息序列/角色/toolCall 配对/
 *    usage 聚合断言——「合法 pi session」的可证伪定义
 * 3. 端到端（A2/V6）：fixture sqlite 库（mkdtemp 自建自删）→ prepareImport + write 产物
 *    → 重放断言 + degradations 装配 + 文件名不变量
 *
 * C1/C2 宿主库探针结论记录在 converter.ts 对应实现注释（头注 / T4 实现处），此处不重复。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Message } from '@taiji/shared'
import type { PiHistoryToolResult, PiSessionEntry } from '../../../infra/pi/pi-protocol.js'
import { convertPiHistory } from '../../../infra/pi/message-converter.js'
import { mapSessionEntries } from '../../../infra/pi/session-entry-mapper.js'
import { ImportServiceError } from '../import-source.js'
import { ZcodeImportSource } from '../import-source-zcode.js'
import { openZcodeReadonlyDb } from './sqlite-access.js'
import {
  buildZcodeSessionFile,
  convertZcodeSession,
  type ZcodeConversionOutput,
  type ZcodeMessageInput,
} from './converter.js'

// ── fixture 构造（内存行结构，字段形态对齐宿主库实测 §2.3）────────────────────────────

const HEADER = Object.freeze({
  id: '0198test-0000-0000-0000-00000000000a',
  timestamp: '2026-01-02T03:04:05.000Z',
  cwd: '/tmp/zc-conv-cwd',
})

function part(data: Record<string, unknown>): Record<string, unknown> {
  return data
}

function textPart(text: string, startMs?: number): Record<string, unknown> {
  return part({ type: 'text', text, ...(startMs !== undefined && { time: { start: startMs, end: startMs } }) })
}

function reasoningPart(text: string, startMs?: number): Record<string, unknown> {
  return part({ type: 'reasoning', text, ...(startMs !== undefined && { time: { start: startMs, end: startMs } }) })
}

function toolPart(
  callID: string,
  tool: string,
  state: Record<string, unknown>,
): Record<string, unknown> {
  return part({ type: 'tool', callID, tool, state })
}

function stepStart(): Record<string, unknown> {
  return part({ type: 'step-start' })
}

function stepFinish(reason: string, tokens?: Record<string, unknown>, cost?: number): Record<string, unknown> {
  return part({ type: 'step-finish', reason, ...(tokens !== undefined && { tokens }), ...(cost !== undefined && { cost }) })
}

function assistantMessage(
  parts: Array<Record<string, unknown>>,
  dataExtra: Record<string, unknown> = {},
  createdMs = 2000,
  id = 'm-asst',
): ZcodeMessageInput {
  return {
    id,
    data: { role: 'assistant', time: { created: createdMs, completed: createdMs + 5000 }, ...dataExtra },
    parts,
  }
}

function userMessage(
  id: string,
  parts: Array<Record<string, unknown>>,
  dataExtra: Record<string, unknown> = {},
  createdMs = 1000,
): ZcodeMessageInput {
  return { id, data: { role: 'user', time: { created: createdMs }, ...dataExtra }, parts }
}

/** 新数据 semantics 形态（§4.2 值域闭集成员）——投影分派 fixture 共用。 */
const REAL_USER_SEMANTICS = {
  kind: 'user_prompt',
  origin: 'real_user',
  uiVisibility: 'visible',
  transcriptVisibility: 'visible',
}
const VISIBLE_ASSISTANT_SEMANTICS = {
  kind: 'assistant_response',
  origin: 'agent_runtime',
  uiVisibility: 'visible',
  transcriptVisibility: 'visible',
}
const BACKGROUND_SEMANTICS = {
  kind: 'background_notification',
  origin: 'agent_runtime',
  uiVisibility: 'hidden',
  transcriptVisibility: 'hidden',
  providerVisibility: 'visible',
}

/** 厨房水槽行集：part 级映射全形态覆盖（切段/配对/映射/降级）。 */
function kitchenSinkMessages(): ZcodeMessageInput[] {
  return [
    // m1 user：多 text part + file part（D6 丢弃）
    {
      id: 'm1',
      data: { role: 'user', time: { created: 1000 } },
      parts: [
        textPart('Hello'),
        textPart('Second line'),
        part({ type: 'file', mime: 'image/png', url: 'zcode-artifact://abc' }),
      ],
    },
    // m2 assistant：两段 step 循环 + 四种 tool 形态 + 尾段杂项（running/compaction/未知）。
    // 注意不得加入 timeline part：分类器 isTimelineOnlyMessage 会把整条消息判成
    // timelineOnly 丢弃（part 级 timeline 属消息级投影形态，由投影分派 describe 覆盖）
    {
      id: 'm2',
      data: {
        role: 'assistant',
        time: { created: 2000, completed: 9000 },
        modelId: 'GLM-5.3',
        providerId: 'account:bigmodel',
      },
      parts: [
        stepStart(),
        reasoningPart('let me think', 2100),
        textPart('Editing now', 2200),
        toolPart('call_1', 'Edit', { status: 'completed', input: { file_path: '/a.ts', new_string: 'x' }, output: 'edited /a.ts' }),
        toolPart('call_2', 'Bash', { status: 'completed', input: { command: 'ls' }, output: 'file1\nfile2' }),
        toolPart('call_3', 'ZcodeCustomTool', { status: 'completed', input: { q: 1 }, output: 'custom out' }),
        toolPart('call_4', 'Grep', { status: 'error', input: { pattern: 'x' }, output: null, error: 'grep failed' }),
        stepFinish(
          'tool-calls',
          { total: 100, input: 80, output: 20, reasoning: 5, cache: { read: 10, write: 4 } },
          0.5,
        ),
        stepStart(),
        textPart('All done', 3000),
        stepFinish('stop', { total: 60, input: 40, output: 20 }, 0.2),
        // 尾段（无 step-finish 收口）：running tool（D7 整对丢弃）+ compaction（T5 custom）+
        // 未知 type（跳过+降级）——尾段 content 为空 → 不产出 assistant entry
        toolPart('call_5', 'Read', { status: 'running', input: { file_path: '/b.ts' } }),
        part({ type: 'compaction', auto: true, trigger: 'auto', preCompactTokenCount: 160000, time: { start: 4000, end: 4100 } }),
        part({ type: 'hologram', payload: 1 }),
      ],
    },
    // m3 user：正常续问
    { id: 'm3', data: { role: 'user', time: { created: 5000 } }, parts: [textPart('Continue')] },
  ]
}

// ── 产物解析 helper ──────────────────────────────────────────────────────────────────

interface ParsedFile {
  header: Record<string, unknown>
  entries: Array<Record<string, unknown>>
}

function parseOutput(out: ZcodeConversionOutput): ParsedFile {
  const lines = out.content.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  const [header, ...entries] = lines
  return { header: header ?? {}, entries }
}

/** 与生产文件消费同链：entries → mapSessionEntries → convertPiHistory（replayEntries 内核）。 */
function replay(out: ZcodeConversionOutput): Message[] {
  const { entries } = parseOutput(out)
  const mapped = mapSessionEntries(entries as unknown as PiSessionEntry[])
  return convertPiHistory(mapped.messages, mapped.entryIds)
}

// ── T1/T6：header / session_info / entry id 链 ─────────────────────────────────────

describe('T1/T6 header、session_info 与 entry id 链', () => {
  const out = buildZcodeSessionFile([], 'My title', HEADER)
  const { header, entries } = parseOutput(out)

  it('首行 header：version=3 + 归一化 header 三字段', () => {
    expect(header).toEqual({ type: 'session', version: 3, ...HEADER })
  })

  it('第 2 行 session_info：name=title，id=00000001，parentId=null', () => {
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      type: 'session_info',
      id: '00000001',
      parentId: null,
      timestamp: HEADER.timestamp,
      name: 'My title',
    })
  })

  it('空 title 不带 name 字段（session_info.name 可选）', () => {
    const empty = parseOutput(buildZcodeSessionFile([], '', HEADER))
    expect(empty.entries[0]).not.toHaveProperty('name')
  })

  it('T6：entry id 8-hex 递增 + parentId 顺序链（首条 null）', () => {
    const { entries: es } = parseOutput(buildZcodeSessionFile(kitchenSinkMessages(), 'T', HEADER))
    let prev: string | null = null
    for (let i = 0; i < es.length; i++) {
      expect(es[i]?.id).toBe((i + 1).toString(16).padStart(8, '0'))
      expect(es[i]?.parentId).toBe(prev)
      prev = es[i]?.id as string
    }
  })
})

// ── T2/T3/T4/T5：part 级映射断言（厨房水槽）────────────────────────────────────────

describe('§3.4 映射全表（厨房水槽行集 → 产物行）', () => {
  const out = buildZcodeSessionFile(kitchenSinkMessages(), 'Sink', HEADER)
  const { entries } = parseOutput(out)

  it('entry 序列：session_info → user → assistant+4×toolResult → assistant → custom → user', () => {
    expect(entries.map((e) => [e.type, (e.message as { role?: string } | undefined)?.role])).toEqual([
      ['session_info', undefined],
      ['message', 'user'],
      ['message', 'assistant'],
      ['message', 'toolResult'],
      ['message', 'toolResult'],
      ['message', 'toolResult'],
      ['message', 'toolResult'],
      ['message', 'assistant'],
      ['custom', undefined],
      ['message', 'user'],
    ])
  })

  it('T2 user：content=全部 text part 逐条；timestamp 双轨（entry ISO / message ms）', () => {
    const user = entries[1] as { timestamp: string; message: { role: string; content: Array<{ type: string; text: string }>; timestamp: number } }
    expect(user.timestamp).toBe('1970-01-01T00:00:01.000Z') // new Date(1000).toISOString()
    expect(user.message.timestamp).toBe(1000)
    expect(user.message.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'Second line' },
    ])
  })

  it('T3 第一段 assistant：切段/顶级 provider/model/usage 全字段/stopReason=toolUse', () => {
    const a = entries[2] as {
      timestamp: string
      message: {
        content: Array<Record<string, unknown>>
        timestamp: number
        provider: string
        model: string
        usage: Record<string, unknown>
        stopReason: string
      }
    }
    // 段时间戳 = 段内首个携带 time.start 的 part（reasoning 2100）
    expect(a.timestamp).toBe(new Date(2100).toISOString())
    expect(a.message.timestamp).toBe(2100)
    expect(a.message.provider).toBe('account:bigmodel')
    expect(a.message.model).toBe('GLM-5.3')
    expect(a.message.stopReason).toBe('toolUse')
    // content：thinking → text → toolCall×4（T3b：Edit→edit/Bash→bash/未知名原样/Grep→grep）
    expect(a.message.content.map((c) => [c.type, c.name ?? c.thinking ?? c.text])).toEqual([
      ['thinking', 'let me think'],
      ['text', 'Editing now'],
      ['toolCall', 'edit'],
      ['toolCall', 'bash'],
      ['toolCall', 'ZcodeCustomTool'],
      ['toolCall', 'grep'],
    ])
    const call1 = a.message.content[2] as { id: string; arguments: Record<string, unknown> }
    expect(call1.id).toBe('call_1')
    expect(call1.arguments).toEqual({ file_path: '/a.ts', new_string: 'x' })
    // T3 usage：同名直通 / total→totalTokens / cache.read→cacheRead / cache.write→cacheWrite /
    // reasoning 同名 / cost(number)→cost.total（RT-5#1：缺失分量键缺省不补 0，cost 分量
    // zcode 不采集不伪造——0 只允许作为真实测量值）
    expect(a.message.usage).toEqual({
      input: 80,
      output: 20,
      cacheRead: 10,
      cacheWrite: 4,
      reasoning: 5,
      totalTokens: 100,
      cost: { total: 0.5 },
    })
  })

  it('T4 三形态：string→content text / 未映射工具原样 / error→state.error 文本 + isError', () => {
    const results = entries.slice(3, 7) as Array<{
      message: { toolCallId: string; toolName: string; content: Array<{ type: string; text: string }>; isError?: boolean }
    }>
    expect(results[0]?.message).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'edit',
      content: [{ type: 'text', text: 'edited /a.ts' }],
    })
    expect(results[0]?.message).not.toHaveProperty('isError')
    expect(results[1]?.message).toMatchObject({ toolCallId: 'call_2', toolName: 'bash', content: [{ type: 'text', text: 'file1\nfile2' }] })
    expect(results[3]?.message).toEqual({
      role: 'toolResult',
      toolCallId: 'call_4',
      toolName: 'grep',
      content: [{ type: 'text', text: 'grep failed' }],
      isError: true,
      timestamp: 2100,
    })
  })

  it('T3 第二段 assistant：text-only 段收口 stopReason=stop + 第二份 usage', () => {
    const a = entries[7] as { message: { content: Array<{ type: string }>; usage: Record<string, unknown>; stopReason: string; timestamp: number } }
    expect(a.message.content).toEqual([{ type: 'text', text: 'All done' }])
    expect(a.message.stopReason).toBe('stop')
    expect(a.message.timestamp).toBe(3000)
    expect(a.message.usage).toMatchObject({ input: 40, output: 20, totalTokens: 60, cost: { total: 0.2 } })
  })

  it('T5 compaction 正常孤儿（assistant 宿主三路判据均未命中）→ custom entry（customType/data 原样，不伪造 summary）；无 compaction entry', () => {
    const custom = entries[8] as { customType: string; data: Record<string, unknown>; timestamp: string }
    expect(custom.customType).toBe('zcode-import:compaction')
    expect(custom.data).toMatchObject({ type: 'compaction', auto: true, preCompactTokenCount: 160000 })
    expect(custom.timestamp).toBe(new Date(4000).toISOString())
    expect(entries.some((e) => e.type === 'compaction')).toBe(false)
  })

  it('part 级诊断降级：file 丢弃 / running tool 整对丢弃 / 未知 part type 跳过（结构化 + 产物侧反证）', () => {
    // 逐条 count=1 + sample 定位源消息（消息级丢弃才走 (code,kind,source) 聚合，见投影分派 describe）
    expect(out.degradations).toHaveLength(3)
    for (const d of out.degradations) {
      expect(d.code).toBe('dropped_transient')
      expect(d.count).toBe(1)
    }
    expect(out.degradations.map((d) => d.sample?.messageId)).toEqual(['m1', 'm2', 'm2'])
    // 产物侧行为反证：call_5 整对丢弃、hologram 跳过（两条 m2 级损失即上方登记）
    expect(out.content).not.toContain('"call_5"')
    expect(out.content).not.toContain('hologram')
  })
})

// ── 消息级投影分派（classifyMessage → §7.3 落点映射表）──────────────────────────────

describe('消息投影分派：六策略落点 + unclassified', () => {
  it('realUserInput：带 semantics 新数据与无 semantics 旧数据同落 user entry（text part 逐条）', () => {
    const msgs: ZcodeMessageInput[] = [
      userMessage('m-sem', [textPart('带语义'), textPart('第二段')], { semantics: REAL_USER_SEMANTICS }),
      userMessage('m-legacy', [textPart('无语义')], {}, 2000),
    ]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    expect(entries.map((e) => [e.type, (e.message as { role?: string } | undefined)?.role])).toEqual([
      ['session_info', undefined],
      ['message', 'user'],
      ['message', 'user'],
    ])
    expect((entries[1] as { message: { content: unknown[] } }).message.content).toHaveLength(2)
  })

  it('visibleAssistant：带 semantics 新数据与无 semantics 旧数据同落 assistant entry（切段/usage 现状不变）', () => {
    const msgs = [
      assistantMessage(
        [stepStart(), textPart('带语义助手', 2500), stepFinish('stop', { input: 1, output: 1 })],
        { semantics: VISIBLE_ASSISTANT_SEMANTICS },
      ),
      assistantMessage([stepStart(), textPart('旧数据助手', 2600), stepFinish('stop', { input: 2, output: 2 })], {}, 3000, 'm-asst2'),
    ]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    expect(entries.map((e) => (e.message as { role?: string } | undefined)?.role)).toEqual([undefined, 'assistant', 'assistant'])
    expect((entries[1] as { message: { usage: Record<string, unknown> } }).message.usage).toEqual({ input: 1, output: 1 })
  })

  it('providerContextOnly × background_task → 整条丢弃（零 entry）+ L1 dropped_redundant', () => {
    const msgs = [
      userMessage('m-bg', [textPart('<task-notification>后台结果')], { source: 'background_task', semantics: BACKGROUND_SEMANTICS }),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    expect(parseOutput(out).entries).toHaveLength(1) // 仅 session_info
    expect(out.degradations).toEqual([
      { code: 'dropped_redundant', kind: 'background_notification', source: 'background_task', count: 1 },
    ])
  })

  it('L1/L2 聚合：按 (code, kind, source) 分组 count 累加；G1 收敛——user entry 数 === realUserInput 数', () => {
    const msgs: ZcodeMessageInput[] = [
      userMessage('m-real', [textPart('真人问题')], { semantics: REAL_USER_SEMANTICS }),
      // 同 (code,kind,source) 维度两条 → 合并单条 count=2
      userMessage('m-bg1', [textPart('后台通知一')], { source: 'background_task', semantics: BACKGROUND_SEMANTICS }),
      userMessage('m-bg2', [textPart('后台通知二')], { source: 'background_task', semantics: BACKGROUND_SEMANTICS }),
      // 旧数据兜底：legacy metadata.source → providerContextOnly，L2（无 semantics.kind，仅 source 维度）
      userMessage('m-todo', [textPart('待办提醒')], { metadata: { source: 'todo_reminder' } }),
      // hiddenSynthetic：synthetic 标记 + ui 隐藏 → L2（kind 维度）
      userMessage('m-synth', [textPart('系统提醒')], {
        synthetic: true,
        semantics: { kind: 'system_reminder', origin: 'system', uiVisibility: 'hidden', transcriptVisibility: 'hidden' },
      }),
      // timelineOnly：旧数据 part 级 timeline 通道 → L2（kind/source 全缺 → 键缺省）
      userMessage('m-tl', [part({ type: 'timeline', timelineType: 'model_change' })]),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    const { entries } = parseOutput(out)
    // G1：6 条 user role 消息仅 1 条产 user entry（其余为投影丢弃类，不再冒充用户气泡）；
    // 该条是首个 message entry（session_info 占 00000001）
    const userEntries = entries.filter((e) => (e.message as { role?: string } | undefined)?.role === 'user')
    expect(userEntries).toHaveLength(1)
    expect(userEntries[0]?.id).toBe('00000002')
    // 聚合形态：首遇序 4 组、同维度 count 合并；sample 仅 unclassified 携带（此处无）
    expect(out.degradations).toEqual([
      { code: 'dropped_redundant', kind: 'background_notification', source: 'background_task', count: 2 },
      { code: 'dropped_transient', source: 'todo_reminder', count: 1 },
      { code: 'dropped_transient', kind: 'system_reminder', count: 1 },
      { code: 'dropped_transient', count: 1 },
    ])
  })

  it('providerContextOnly 旧数据兜底（legacy metadata.source）→ L2 dropped_transient（source 维度）', () => {
    const msgs = [userMessage('m-todo', [textPart('待办')], { metadata: { source: 'todo_reminder' } })]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    expect(parseOutput(out).entries).toHaveLength(1)
    expect(out.degradations).toEqual([{ code: 'dropped_transient', source: 'todo_reminder', count: 1 }])
  })

  it('hiddenSynthetic → 整条丢弃 + L2（kind 维度，source 缺则键缺省）', () => {
    const msgs = [
      userMessage('m-synth', [textPart('提醒')], {
        synthetic: true,
        semantics: { kind: 'system_reminder', origin: 'system', uiVisibility: 'hidden', transcriptVisibility: 'hidden' },
      }),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    expect(parseOutput(out).entries).toHaveLength(1)
    expect(out.degradations).toEqual([{ code: 'dropped_transient', kind: 'system_reminder', count: 1 }])
  })

  it('timelineOnly：旧数据 part 级 timeline 通道与 fork 来源同整条丢弃（fork 独立分支，source 维度区分分组）', () => {
    const out = buildZcodeSessionFile(
      [
        userMessage('m-tl', [part({ type: 'timeline', timelineType: 'model_change' })]),
        userMessage('m-fork', [textPart('fork 摘要')], { source: 'fork' }, 3000),
      ],
      'T',
      HEADER,
    )
    expect(parseOutput(out).entries).toHaveLength(1)
    expect(out.degradations).toEqual([
      { code: 'dropped_transient', count: 1 },
      { code: 'dropped_transient', source: 'fork', count: 1 },
    ])
  })

  it('compactSummary → D2 合并落 compaction entry（判据③关联宿主 part）；summary.body 缺失退化为现状 + compaction_unlinked', () => {
    const compactionPart = part({ type: 'compaction', auto: true, trigger: 'auto', preCompactTokenCount: 90000 })
    const msgs: ZcodeMessageInput[] = [
      // 旧数据形态（§4.2 实证 167 条）：role=user + data.summary，宿主 compaction part——
      // 判据③（user 消息含无 timelineStatus 的 compaction part）关联 → 合并为单条 compaction entry
      {
        id: 'm-old',
        data: { role: 'user', summary: { body: '旧摘要' }, time: { created: 1000 } },
        parts: [textPart('旧摘要正文'), compactionPart],
      },
      // 新数据形态：semantics.kind='compact_summary' 但无 data.summary.body → 不可合并（不伪造），
      // 退化为现状 user entry + 计 compaction_unlinked
      userMessage('m-new', [], { semantics: { kind: 'compact_summary', origin: 'system', uiVisibility: 'hidden', transcriptVisibility: 'hidden' } }, 2000),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    const { entries } = parseOutput(out)
    // m-old：合并路径不产 user entry / custom entry——摘要宿主与关联 part 合为单条 compaction entry
    expect(entries.map((e) => [e.type, (e.message as { role?: string } | undefined)?.role])).toEqual([
      ['session_info', undefined],
      ['compaction', undefined], // m-old 合并产物
      ['message', 'user'], // m-new 退化路径（零 text part → 空 content，现状形态）
    ])
    const merged = entries[1] as { summary: string; firstKeptEntryId: string; tokensBefore: number; details: Record<string, unknown>; timestamp: string }
    expect(merged.summary).toBe('旧摘要')
    expect(merged.tokensBefore).toBe(90000)
    expect(merged.details).toEqual(compactionPart)
    // ① 级锚缺 tail_start_id → ② 级紧邻前驱 = session_info 的 entry id（首条 entry 场景）
    expect(merged.firstKeptEntryId).toBe('00000001')
    expect(merged.timestamp).toBe(new Date(1000).toISOString())
    // m-new 退化：user entry 空内容（现状形态）+ compaction_unlinked（L3，宿主 kind 注解）
    expect((entries[2] as { message: { content: unknown[] } }).message.content).toEqual([])
    expect(out.degradations).toEqual([{ code: 'compaction_unlinked', kind: 'compact_summary', count: 1 }])
  })

  it('unclassified → 丢弃 + L4 独立码 + sample 携带 messageId 与文本前 80 字（G3 未知不静默不猜）', () => {
    const longText = `a${'b'.repeat(120)}`
    const msgs = [userMessage('m-unk', [textPart(longText)], { semantics: { kind: 'zcode_future_kind', origin: 'real_user' } })]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    expect(parseOutput(out).entries).toHaveLength(1) // 仅 session_info，消息整体丢弃
    expect(out.degradations).toEqual([
      { code: 'unclassified', kind: 'zcode_future_kind', count: 1, sample: { messageId: 'm-unk', preview: `a${'b'.repeat(79)}` } },
    ])
  })

  it('serialization.truncated → truncated_output 结构化登记（宿主 kind 注解）；截断版 output 保留不丢（L3 保真损失非丢弃）', () => {
    const msgs = [
      assistantMessage(
        [
          stepStart(),
          toolPart('call_t', 'Bash', {
            status: 'completed',
            input: { command: 'big-job' },
            output: '截断后的部分输出',
            metadata: { serialization: { truncated: true } },
          }),
          stepFinish('tool-calls', { input: 1, output: 1 }),
        ],
        { semantics: VISIBLE_ASSISTANT_SEMANTICS },
      ),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    const { entries } = parseOutput(out)
    // toolResult 仍产出截断版 output
    const tr = entries[2] as { message: { content: Array<{ type: string; text: string }> } }
    expect(tr.message.content).toEqual([{ type: 'text', text: '截断后的部分输出' }])
    expect(out.degradations).toEqual([{ code: 'truncated_output', count: 1, kind: 'assistant_response' }])
  })

  it('无标记未知 role 消息：分类器兜底末段裁决（realUserInput）——D1 同源显隐，不再 role 分派丢弃', () => {
    const msgs = [{ id: 'm-x', data: { role: 'system', time: { created: 1 } }, parts: [textPart('x')] }]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    const { entries } = parseOutput(out)
    // 旧 role 分派会丢弃+降级登记；分类器（asar 移植体）对无标记非 assistant 消息判
    // realUserInput——zcode GUI 对同类消息同样显示为用户输入，taiji 不二次覆盖
    expect(entries.map((e) => [e.type, (e.message as { role?: string } | undefined)?.role])).toEqual([
      ['session_info', undefined],
      ['message', 'user'],
    ])
    expect(out.degradations).toEqual([])
  })
})

// ── 边界细分：切段/尾段/T3c/usage 缺失/空段 ────────────────────────────────────────

describe('切段与 T3c 边界', () => {
  it('尾段未收口有内容则闭合：stopReason=stop 保底、无 usage', () => {
    const msgs = [
      assistantMessage([
        stepStart(),
        textPart('tail without finish', 2500),
        // 无 step-finish —— 消息结束边界闭合
      ]),
    ]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    const assistant = entries[1] as { message: { stopReason: string; content: Array<{ type: string }>; timestamp: number } }
    expect(entries).toHaveLength(2) // session_info + assistant
    expect(assistant.message.stopReason).toBe('stop')
    expect(assistant.message).not.toHaveProperty('usage')
    expect(assistant.message.timestamp).toBe(2500)
  })

  it('空段不产出：step-start/step-finish 包裹的无内容段不生成 entry', () => {
    const msgs = [
      assistantMessage([
        stepStart(),
        stepFinish('stop', { total: 10, input: 5, output: 5 }),
        stepStart(),
        stepFinish('stop'),
      ]),
    ]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    expect(entries).toHaveLength(1) // 仅 session_info
  })

  it('T3c 全表：length/interrupted/failed/未知取值/缺失 reason → length/aborted/error/stop/stop', () => {
    const cases: Array<[unknown, string]> = [
      ['length', 'length'],
      ['interrupted', 'aborted'],
      ['failed', 'error'],
      ['stream_recovery_discarded', 'error'],
      ['start_plan_admission_retry_discarded', 'error'],
      ['other', 'stop'],
      ['brand-new-reason', 'stop'],
      [undefined, 'stop'],
    ]
    for (const [reason, expected] of cases) {
      const msgs = [assistantMessage([stepStart(), textPart('x', 2500), { type: 'step-finish', reason }])]
      const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
      const assistant = entries[1] as { message: { stopReason: string } }
      expect(assistant.message.stopReason, `finish=${String(reason)}`).toBe(expected)
    }
  })

  it('step-finish 无 tokens → 无 usage 字段；缺失分量键缺省（RT-5#1 不补 0），显式 cost 0 是测量值保留', () => {
    const msgs = [
      assistantMessage([stepStart(), textPart('x', 2500), stepFinish('stop', { input: 3, output: 4 }, 0)]),
    ]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    const a = entries[1] as { message: { usage: Record<string, unknown> } }
    expect(a.message.usage).toEqual({
      input: 3,
      output: 4,
      cost: { total: 0 },
    })
  })

  it('RT-5#1：usage 分量缺字段不写 0（键缺省）——tokens 缺 input 只写 output', () => {
    const msgs = [
      assistantMessage([stepStart(), textPart('x', 2500), stepFinish('stop', { output: 7 }, 0.2)]),
    ]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    const a = entries[1] as { message: { usage: Record<string, unknown> } }
    // input/cacheRead/cacheWrite/totalTokens 缺 → 键不存在（≠ 0 假数据）；cost 只有单字段 total
    expect(a.message.usage).toEqual({ output: 7, cost: { total: 0.2 } })
    expect(a.message.usage).not.toHaveProperty('input')
    expect(a.message.usage).not.toHaveProperty('totalTokens')
  })

  it('RT-5#1：tokens 分量全部不可解 → 整条 usage 不写 + part 级降级登记', () => {
    const msgs = [
      // tokens 是 record 但无任何可解分量；cost 也缺失 → usage 整条跳过
      assistantMessage([stepStart(), textPart('x', 2500), stepFinish('stop', { cache: {} })]),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    const { entries } = parseOutput(out)
    const a = entries[1] as { message: Record<string, unknown> }
    expect(a.message).not.toHaveProperty('usage')
    // 本 fixture 唯一损失即该登记：结构化形态（code + count + sample 定位源消息）
    expect(out.degradations).toHaveLength(1)
    expect(out.degradations[0]).toMatchObject({ code: 'dropped_transient', count: 1, sample: { messageId: 'm-asst' } })
  })

  it('T4 object 形态：completed+object output → details（content 留空数组）——前向防御分支', () => {
    const msgs = [
      assistantMessage([
        stepStart(),
        toolPart('call_o', 'Write', { status: 'completed', input: { file_path: '/c' }, output: { ok: true, files: ['/c'] } }),
        stepFinish('tool-calls', { input: 1, output: 1 }),
      ]),
    ]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    const tr = entries[2] as { message: { content: unknown[]; details: Record<string, unknown> } }
    expect(tr.message.content).toEqual([])
    expect(tr.message.details).toEqual({ ok: true, files: ['/c'] })
  })

  it('T4 未覆盖形态（number output）→ 跳过输出 + 降级登记；toolCall 仍产出（配对完整）', () => {
    const msgs = [
      assistantMessage([
        stepStart(),
        toolPart('call_n', 'Bash', { status: 'completed', input: { command: 'x' }, output: 42 }),
        stepFinish('tool-calls', { input: 1, output: 1 }),
      ]),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    const { entries } = parseOutput(out)
    const tr = entries[2] as { message: { content: unknown[] } }
    expect(tr.message.content).toEqual([])
    expect(out.degradations).toHaveLength(1)
    expect(out.degradations[0]).toMatchObject({ code: 'dropped_transient', count: 1, sample: { messageId: 'm-asst' } })
  })

  it('message.data.time.created 缺失 → 回落 header.timestamp（确定性兜底，无 Date.now）', () => {
    const msgs = [{ id: 'm-u', data: { role: 'user' }, parts: [textPart('fallback')] }]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    const user = entries[1] as { timestamp: string; message: { timestamp: number } }
    expect(user.timestamp).toBe(HEADER.timestamp)
    expect(user.message.timestamp).toBe(Date.parse(HEADER.timestamp))
  })

  it('RT-5#8：header.timestamp 不可解 → 不伪造 1970（entry 退原串、message.timestamp 缺省、降级登记）', () => {
    const badHeader = { ...HEADER, timestamp: 'not-a-timestamp' }
    const msgs = [
      { id: 'm-u', data: { role: 'user' }, parts: [textPart('no-time')] },
      assistantMessage([stepStart(), textPart('x', 2500), stepFinish('stop', { input: 1 })], {}, 2000),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', badHeader)
    const { entries } = parseOutput(out)
    const user = entries[1] as { timestamp: string; message: Record<string, unknown> }
    // entry.timestamp 退 header 原串（保真），不产出 1970-01-01 假时间戳
    expect(user.timestamp).toBe('not-a-timestamp')
    // message.timestamp（ms）缺省键——undefined ≠ 0（0 = 1970 假测量值）
    expect(user.message).not.toHaveProperty('timestamp')
    // session 级登记无消息 id → 单条 dropped_transient 且无 sample；本场景仅此一条降级，
    // 长度 + 形态即唯一指认「header.timestamp 不可解」这条登记
    expect(out.degradations).toHaveLength(1)
    expect(out.degradations[0]?.code).toBe('dropped_transient')
    expect(out.degradations[0]?.sample).toBeUndefined()
    // assistant 段有自身 time 锚（2500）时不受 header 不可解影响——段级时间仍真实
    const assistant = entries[2] as { timestamp: string; message: { timestamp: number } }
    expect(assistant.timestamp).toBe(new Date(2500).toISOString())
    expect(assistant.message.timestamp).toBe(2500)
  })
})

// ── 脏数据防御分支：zcode 外部格式的 malformed 形态（宽输入域，降级不抛错）────────────

describe('zcode 脏数据防御分支（tool part 结构异常 / text·reasoning 文本形态异常）', () => {
  it('tool part 结构异常（缺 callID / callID 非 string / 缺 tool / state 非对象）→ 整对丢弃 + 降级登记', () => {
    const msgs = [
      assistantMessage([
        stepStart(),
        textPart('before', 2500),
        part({ type: 'tool', tool: 'Edit', state: { status: 'completed', input: {}, output: 'o' } }),
        part({ type: 'tool', callID: 42, tool: 'Edit', state: { status: 'completed', input: {}, output: 'o' } }),
        part({ type: 'tool', callID: 'call_a', state: { status: 'completed', input: {}, output: 'o' } }),
        part({ type: 'tool', callID: 'call_b', tool: 'Edit', state: 'not-an-object' }),
        stepFinish('tool-calls', { input: 1, output: 1 }),
      ]),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    const { entries } = parseOutput(out)
    // 产物仅 session_info + assistant（text 段）：4 个畸形 tool 零 toolCall、零 toolResult
    expect(entries).toHaveLength(2)
    const a = entries[1] as { message: { role: string; content: Array<Record<string, unknown>> } }
    expect(a.message.role).toBe('assistant')
    expect(a.message.content).toEqual([{ type: 'text', text: 'before' }])
    expect(out.content).not.toContain('"call_a"')
    expect(out.content).not.toContain('"call_b"')
    // 4 条逐条登记（part 级诊断形态：count=1 + sample 定位源消息）
    expect(out.degradations).toHaveLength(4)
    for (const d of out.degradations) {
      expect(d).toMatchObject({ code: 'dropped_transient', count: 1, sample: { messageId: 'm-asst' } })
    }
  })

  it('text 与 reasoning part 文本字段为 number → 各自降级登记 + content 不含该段', () => {
    const msgs = [
      assistantMessage([
        stepStart(),
        part({ type: 'text', text: 42, time: { start: 2500, end: 2500 } }),
        part({ type: 'reasoning', text: 7, time: { start: 2600, end: 2600 } }),
        textPart('kept', 2700),
        stepFinish('stop', { input: 1, output: 1 }),
      ]),
    ]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    const { entries } = parseOutput(out)
    const a = entries[1] as { message: { content: Array<Record<string, unknown>> } }
    // 异常 text/reasoning 段被跳过，仅保留合法 text part
    expect(a.message.content).toEqual([{ type: 'text', text: 'kept' }])
    expect(out.degradations).toHaveLength(2)
    for (const d of out.degradations) {
      expect(d).toMatchObject({ code: 'dropped_transient', count: 1, sample: { messageId: 'm-asst' } })
    }
  })
})

// ── 重放锚（A1/V3）：产物经 taiji 现有消费链重放 ─────────────────────────────────────

describe('applyEntry 重放锚（mapSessionEntries → convertPiHistory）', () => {
  const out = buildZcodeSessionFile(kitchenSinkMessages(), 'Sink', HEADER)
  const messages = replay(out)

  it('消息序列与角色：user → assistant → assistant（toolResult 并入所属 assistant）', () => {
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user'])
  })

  it('toolCall 配对（F5）：4 个 toolCall 按 toolCallId 回填 output/status；T3b 映射名生效', () => {
    const first = messages[1] as Message
    const calls = first.toolCalls ?? []
    expect(calls.map((t) => [t.id, t.toolName, t.output, t.status])).toEqual([
      ['call_1', 'edit', 'edited /a.ts', 'completed'],
      ['call_2', 'bash', 'file1\nfile2', 'completed'],
      ['call_3', 'ZcodeCustomTool', 'custom out', 'completed'],
      ['call_4', 'grep', 'grep failed', 'error'],
    ])
    // arguments 经 input 字段回放（edit/write 小写名喂 diff 卡片提取链）
    expect(calls[0]?.input).toEqual({ file_path: '/a.ts', new_string: 'x' })
  })

  it('usage 聚合（reducer 投影 inputTokens/outputTokens）+ thinking 块 + 文本', () => {
    const first = messages[1] as Message
    expect(first.usage).toEqual({ inputTokens: 80, outputTokens: 20 })
    expect(first.thinking?.[0]?.content).toBe('let me think')
    expect(first.content).toContain('Editing now')
    const second = messages[2] as Message
    expect(second.usage).toEqual({ inputTokens: 40, outputTokens: 20 })
    expect(second.content).toBe('All done')
    expect(second.toolCalls).toBeUndefined()
  })

  it('compaction custom entry 不产生对话流消息（GUI 跳过，F4）；无孤儿 toolResult', () => {
    // custom 不进 messages；compaction 未伪造为 compactionSummary 系统消息
    expect(messages.some((m) => m.compactionSummary !== undefined)).toBe(false)
    const orphans: PiHistoryToolResult[] = []
    const { entries } = parseOutput(out)
    const mapped = mapSessionEntries(entries as unknown as PiSessionEntry[])
    convertPiHistory(mapped.messages, mapped.entryIds, orphans)
    expect(orphans).toHaveLength(0)
  })
})

// ── 端到端（A2/V6）：fixture sqlite 库 → prepareImport + write ──────────────────────

describe('端到端：fixture 库 → ZcodeImportSource.prepareImport + write', () => {
  let fixturesRoot: string

  beforeAll(() => {
    fixturesRoot = mkdtempSync(join(tmpdir(), 'zcode-converter-'))
  })
  afterAll(() => {
    rmSync(fixturesRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 建 message/part 真行 fixture 库（宿主 schema 0.16.5 消费列集；mkdtemp 自建自删）。 */
  function buildDb(dbPath: string, messages: ZcodeMessageInput[], sessionId: string, title: string): void {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('BEGIN')
      db.exec(
        'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, ' +
          "task_type TEXT NOT NULL DEFAULT 'interactive', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
      )
      db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)')
      db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)')
      db.prepare('INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sessionId, '/tmp/zc-e2e-cwd', title, 'interactive', 1767225600000, 1767225700000)
      const insMsg = db.prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
      const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
      for (const [mi, msg] of messages.entries()) {
        insMsg.run(msg.id, sessionId, mi + 1, JSON.stringify(msg.data))
        for (const [pi, p] of msg.parts.entries()) {
          insPart.run(`${msg.id}-p${pi}`, msg.id, sessionId, pi + 1, JSON.stringify(p))
        }
      }
      db.exec('COMMIT')
    } finally {
      db.close()
    }
  }

  it('prepareImport + write → 产物可重放 + degradations 装配 + 文件名不变量', async () => {
    const dbPath = join(fixturesRoot, 'e2e.sqlite')
    const sessionId = 'sess_0198e2e0-0000-0000-0000-00000000000b'
    buildDb(dbPath, kitchenSinkMessages(), sessionId, 'E2E 会话')

    const source = new ZcodeImportSource({ getHostDbPath: () => dbPath })
    const artifact = await source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId, dbPath })

    // 文件名不变量（§3.4 T1）：剥 .jsonl 后 lastIndexOf('_') 尾段 === header.id
    const bare = artifact.fileName.replace(/\.jsonl$/, '')
    expect(bare.slice(bare.lastIndexOf('_') + 1)).toBe(artifact.header.id)

    // write 前无降级明细（转换在 write 闭包内发生）
    expect(artifact.degradations).toEqual([])

    const tmpPath = join(fixturesRoot, 'e2e-tmp.jsonl')
    await artifact.write(tmpPath)
    const content = readFileSync(tmpPath, 'utf8')

    // 产物结构：首行 header + 全部行可解析
    const lines = content.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines[0]).toEqual({ type: 'session', version: 3, ...artifact.header })

    // write 后 degradations 已装配（编排层此时读取聚合 warning='conversion_degraded'）
    expect(artifact.degradations).toHaveLength(3)

    // 重放锚：产物与纯函数同源同构
    const replayed = replay({ content, degradations: [] })
    expect(replayed.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user'])
    expect((replayed[1] as Message).toolCalls?.map((t) => t.toolName)).toEqual(['edit', 'bash', 'ZcodeCustomTool', 'grep'])
  })

  it('convertZcodeSession：会话行在写入阶段复查不存在 → import_invalid_session', async () => {
    const dbPath = join(fixturesRoot, 'missing.sqlite')
    buildDb(dbPath, [], 'sess_0198e2e0-0000-0000-0000-00000000000c', 'Seed')
    const db = await openZcodeReadonlyDb(dbPath)
    try {
      expect(() => convertZcodeSession(db, 'sess_no_such', HEADER)).toThrow(ImportServiceError)
    } finally {
      db.close()
    }
  })

  it('write 相位分离：message.data 非法 JSON → import_invalid_session（schema 漂移域）', async () => {
    const dbPath = join(fixturesRoot, 'drift.sqlite')
    const sessionId = 'sess_0198e2e0-0000-0000-0000-00000000000d'
    buildDb(dbPath, [], sessionId, 'Drift')
    // 直接注入非法 JSON 行（绕过 buildDb 的 JSON.stringify——模拟 zcode 升级后的行形态漂移）
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)').run('m-bad', sessionId, 1, '{not json')
    db.close()

    const source = new ZcodeImportSource({ getHostDbPath: () => dbPath })
    const artifact = await source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId, dbPath })
    await expect(artifact.write(join(fixturesRoot, 'drift-tmp.jsonl'))).rejects.toThrow('读取 zcode 会话库失败')
  })
})
