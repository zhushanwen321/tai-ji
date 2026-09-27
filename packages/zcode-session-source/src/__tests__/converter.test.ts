/**
 * zcode → canonical 转换器测试（U4——映射全表逐条 + canonical 合法性 round-trip +
 * applyEntry 重放锚 + fixture 库端到端；自 runtime converter.test.ts 等价迁移，
 * 断言强度不降，见各 describe 注释的迁移适配说明）。
 *
 * 断言分层：
 * 1. 纯函数直测：内存行集（不建真库）→ 产物 entry 逐条断言（映射表即验收标准）。
 *    产物经 serializeSession（基座字节契约，P-serializer 锚）转 JSONL 行后断言，
 *    与「stringify 产物逐行断言」形态对齐，同时覆盖「键序不重排、接口外字段不丢失」
 *    的序列化兼容面。
 * 2. 重放锚：产物经最小重放器（pi applyEntry 消费语义的测试内同构投影，跨包
 *    import runtime 会成环——手段自证已在 deviations 登记）断言 Entry 树 parentId
 *    链完整 + 消息序列/角色/toolCall 配对/usage 聚合——「合法 pi session」的可证伪
 *    定义；另以 parseSessionContent round-trip 作 canonical 合法性机器锚。
 * 3. 端到端：fixture sqlite 库（helpers.buildFixtureDb，mkdtemp 自建自删）→
 *    readZcodeSession → NormalizedSession 三键形状 + 重放 + degradations 装配 +
 *    文件名不变量。
 *
 * 自 runtime dev 演进版移植的净新增组（git 可追溯）：消息投影分派 describe（六策略
 * 落点 / L1-L2 归类聚合 / unclassified sample / G1 user entry 数收敛）、T3c 新语义
 * （尾段零 usage 不变量门、RT-5#1 缺省语义 ×2、RT-5#8 不伪造 1970）、cancelled/error
 * turn 事故回归 7 用例；degradations 断言全部结构化（code/kind/source/count/sample
 * 维度——禁 preview 字符串匹配残留，诊断措辞不进断言）。
 *
 * C1/C2 宿主库探针结论记录在 converter.ts 对应实现注释（头注 / T4 实现处），此处不重复。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeZcodeRowId,
  parseSessionContent,
  serializeSession,
  sessionIdFromFileName,
} from '@zhushanwen/session-core'
import type { NormalizedSession } from '@zhushanwen/session-core'

import { buildFixtureDb, makeFixtureDir, openWritableSqlite, type FixtureMessage, type FixturePart } from './helpers.ts'
import { convertZcodeTranscript, type ZcodeMessageInput } from '../converter.ts'
import { readZcodeSession } from '../read.ts'
import { normalizeZcodeSessionId, zcodeCandidateKey } from '../normalize.ts'

// ── fixture 构造（内存行结构，字段形态对齐宿主库实测）────────────────────────────────

/** session 行创建时刻（旧测试 header.timestamp 的 epoch ms 形态——确定性，无 Date.now）。 */
const SESS_CREATED_MS = Date.parse('2026-01-02T03:04:05.000Z')
/** 纯转换输入：原始 sess_ 形态 id（header.id 归一化由 converter 负责）。 */
const SESSION_INPUT = Object.freeze({
  id: 'sess_0198test-0000-0000-0000-00000000000a',
  title: 'My title',
  timeCreated: SESS_CREATED_MS,
})
/** 归一化 header（旧测试 HEADER 常量的 id/timestamp 等价形态；cwd 缺省不设——不伪造）。 */
const NORMALIZED_ID = '0198test-0000-0000-0000-00000000000a'
const NORMALIZED_TIMESTAMP = '2026-01-02T03:04:05.000Z'

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

/** 厨房水槽行集：part 级映射全形态覆盖（切段/配对/映射/降级）。
 * 注意不得加入 timeline part：分类器 isTimelineOnlyMessage 会把整条消息判成
 * timelineOnly 丢弃（part 级 timeline 属消息级投影形态，由投影分派 describe 覆盖）。 */
function kitchenSinkMessages(): ZcodeMessageInput[] {
  return [
    // m1 user：多 text part + file part（D6 丢弃计降级）
    {
      id: 'm1',
      data: { role: 'user', time: { created: 1000 } },
      parts: [
        textPart('Hello'),
        textPart('Second line'),
        part({ type: 'file', mime: 'image/png', url: 'zcode-artifact://abc' }),
      ],
    },
    // m2 assistant：两段 step 循环 + 四种 tool 形态 + 尾段杂项（running/compaction/未知）
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
        // 尾段（无 step-finish 收口）：running tool（整对丢弃）+ compaction（T5 正常孤儿 →
        // custom）+ 未知 type（跳过+降级）——尾段 content 为空 → 不产出 assistant entry
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

interface ParsedEntry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  message?: {
    role: string
    content: unknown
    timestamp?: number
    provider?: string
    model?: string
    usage?: Record<string, number | { total: number }>
    stopReason?: string
    toolCallId?: string
    toolName?: string
    details?: Record<string, unknown>
    isError?: boolean
  }
  customType?: string
  data?: unknown
  name?: string
  [key: string]: unknown
}

/**
 * 产物 → JSONL 行（serializeSession = 基座序列化原语，P-serializer 字节契约：
 * JSON.stringify(entry) 不重排键、不丢接口外字段——导入薄包装即用此函数落盘）。
 * converter 产物是 entry 对象，序列化步显式走基座单点，同时覆盖序列化兼容面。
 */
function toLines(session: NormalizedSession): ParsedEntry[] {
  return serializeSession(session.entries)
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as ParsedEntry)
}

// ── 重放锚实现：最小重放器（pi applyEntry 消费语义的测试内同构投影）───────────────────
// runtime 消费链（mapSessionEntries → convertPiHistory，replayEntries(applyEntry) 内核）
// 位于 packages/runtime——zcode-session-source 反向 import 会成环，故在测试内按同一
// 语义投影（deviations 已登记手段自证）。投影语义锚：
// - parentId 顺序链完整（pi applyEntry/_buildIndex 的形状前提：byId.set(entry.id, entry)，
//   leafId = entry.id，无 parseInt/形态校验类消费）
// - user/assistant 产出对话流消息；紧随的 role=toolResult entry 按 toolCallId 回填所属
//   assistant 的 toolCall（output/status；arguments 经 input 字段回放——edit/write 小写名
//   喂 diff 卡片提取链）
// - usage 聚合投影 inputTokens/outputTokens；thinking 块；text parts join 成 content
// - custom entry（含 zcode-import:compaction）不产出对话流消息、不伪造 compactionSummary

interface ReplayedToolCall {
  id: string
  toolName: string
  input?: unknown
  output?: unknown
  status?: string
}

interface ReplayedMessage {
  role: string
  content: string
  toolCalls?: ReplayedToolCall[]
  usage?: { inputTokens: number; outputTokens: number }
  thinking?: Array<{ content: string }>
}

function textPartsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((c): c is { type: string; text: string } => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text')
    .map((c) => c.text)
}

function replayEntries(entries: ParsedEntry[]): { messages: ReplayedMessage[]; orphans: ParsedEntry[] } {
  // 1) parentId 顺序链完整性：首条 null，其后每条指向前一条（树形状前提，破坏即不是合法 pi entry 流）
  let prev: string | null = null
  for (const e of entries) {
    expect(e.parentId, `entry ${e.id} parentId 链断裂`).toBe(prev)
    prev = e.id
  }

  // 2) 消息投影（toolResult 并入所属 assistant 的 toolCall）
  const messages: ReplayedMessage[] = []
  const orphans: ParsedEntry[] = []
  let currentAssistant: ReplayedMessage | undefined
  for (const e of entries) {
    if (e.type !== 'message' || e.message === undefined) continue // session_info/custom/compaction 不进对话流
    const msg = e.message
    if (msg.role === 'user') {
      currentAssistant = undefined
      messages.push({ role: 'user', content: textPartsOf(msg.content).join('\n') })
      continue
    }
    if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : []
      const calls: ReplayedToolCall[] = content
        .filter((c) => c.type === 'toolCall')
        .map((c) => ({ id: c.id as string, toolName: c.name as string, input: c.arguments }))
      const thinking = content
        .filter((c) => c.type === 'thinking')
        .map((c) => ({ content: c.thinking as string }))
      const usage =
        msg.usage !== undefined && typeof msg.usage.input === 'number' && typeof msg.usage.output === 'number'
          ? { inputTokens: msg.usage.input, outputTokens: msg.usage.output }
          : undefined
      const m: ReplayedMessage = {
        role: 'assistant',
        content: textPartsOf(content).join('\n'),
        ...(calls.length > 0 && { toolCalls: calls }),
        ...(usage !== undefined && { usage }),
        ...(thinking.length > 0 && { thinking }),
      }
      messages.push(m)
      currentAssistant = m
      continue
    }
    // role=toolResult：按 toolCallId 精确回填（runtime reducer 同构）
    const call = currentAssistant?.toolCalls?.find((c) => c.id === msg.toolCallId)
    if (!call) {
      orphans.push(e)
      continue
    }
    call.output = textPartsOf(msg.content).join('\n')
    call.status = msg.isError === true ? 'error' : 'completed'
  }
  return { messages, orphans }
}

// ── T1/T6：header / session_info / entry id 链 ─────────────────────────────────────

describe('T1/T6 header、session_info 与 entry id 链', () => {
  const session = convertZcodeTranscript([], SESSION_INPUT)
  const lines = toLines(session)

  it('header：归一化 id + timestamp 取 session 创建时间；cwd 缺省留空不伪造', () => {
    // 迁移适配：旧断言「首行 header version=3 + 三字段」——header 行由导入薄包装/reader
    // 序列化装配面拼装（D1），converter 产 SessionHeader 对象；cwd 键不存在 = 缺省留空
    expect(session.header).toEqual({ id: NORMALIZED_ID, timestamp: NORMALIZED_TIMESTAMP })
    expect(session.header).not.toHaveProperty('cwd')
  })

  it('第 1 条 entry session_info：name=title，id=00000001，parentId=null', () => {
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({
      type: 'session_info',
      id: '00000001',
      parentId: null,
      timestamp: NORMALIZED_TIMESTAMP,
      name: 'My title',
    })
  })

  it('空 title 不带 name 字段（session_info.name 可选）', () => {
    const empty = toLines(convertZcodeTranscript([], { ...SESSION_INPUT, title: '' }))
    expect(empty[0]).not.toHaveProperty('name')
  })

  it('T6：entry id 8-hex 递增（基座 normalizeZcodeRowId 单点）+ parentId 顺序链（首条 null）', () => {
    // id 值域归一化收敛基座单点：normalizeZcodeRowId(1) === '00000001'（D1 最小例子锚）
    expect(normalizeZcodeRowId(1)).toBe('00000001')
    const es = toLines(convertZcodeTranscript(kitchenSinkMessages(), { ...SESSION_INPUT, title: 'T' }))
    let prev: string | null = null
    for (let i = 0; i < es.length; i++) {
      expect(es[i]?.id).toBe((i + 1).toString(16).padStart(8, '0'))
      expect(es[i]?.parentId).toBe(prev)
      prev = es[i]?.id as string
    }
  })
})

// ── T2/T3/T4/T5：行级映射断言（厨房水槽）────────────────────────────────────────────

describe('映射全表（厨房水槽行集 → 产物 entry）', () => {
  const session = convertZcodeTranscript(kitchenSinkMessages(), { ...SESSION_INPUT, title: 'Sink' })
  const lines = toLines(session)

  it('entry 序列：session_info → user → assistant+4×toolResult → assistant → custom → user', () => {
    expect(lines.map((e) => [e.type, e.message?.role])).toEqual([
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
    const user = lines[1] as ParsedEntry & { message: { role: string; content: Array<{ type: string; text: string }>; timestamp: number } }
    expect(user.timestamp).toBe('1970-01-01T00:00:01.000Z') // new Date(1000).toISOString()
    expect(user.message.timestamp).toBe(1000)
    expect(user.message.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'Second line' },
    ])
  })

  it('T3 第一段 assistant：切段/顶级 provider/model/usage 全字段/stopReason=toolUse', () => {
    const a = lines[2] as ParsedEntry & { timestamp: string; message: { content: Array<Record<string, unknown>>; timestamp: number; provider: string; model: string; usage: Record<string, unknown>; stopReason: string } }
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
    const results = lines.slice(3, 7) as ParsedEntry[]
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
    const a = lines[7] as ParsedEntry & { message: { content: Array<{ type: string }>; usage: Record<string, unknown>; stopReason: string; timestamp: number } }
    expect(a.message.content).toEqual([{ type: 'text', text: 'All done' }])
    expect(a.message.stopReason).toBe('stop')
    expect(a.message.timestamp).toBe(3000)
    expect(a.message.usage).toMatchObject({ input: 40, output: 20, totalTokens: 60, cost: { total: 0.2 } })
  })

  it('T5 compaction 正常孤儿（宿主三路判据均未命中）→ custom entry（customType/data 原样，不伪造 summary）；无 compaction entry、零降级', () => {
    const custom = lines[8] as ParsedEntry & { customType: string; data: Record<string, unknown>; timestamp: string }
    expect(custom.customType).toBe('zcode-import:compaction')
    expect(custom.data).toMatchObject({ type: 'compaction', auto: true, preCompactTokenCount: 160000 })
    expect(custom.timestamp).toBe(new Date(4000).toISOString())
    expect(lines.some((e) => e.type === 'compaction')).toBe(false)
    expect(lines.some((e) => JSON.stringify(e).includes('model_change'))).toBe(false)
    // D2 孤儿二分：正常孤儿维持现状 custom 通道，不计降级（compaction_unlinked 仅悬空/断链）
    expect(session.degradations.some((d) => d.code === 'compaction_unlinked')).toBe(false)
  })

  it('part 级诊断降级：file 丢弃 / running tool 整对丢弃 / 未知 part type 跳过（结构化 + 产物侧反证）', () => {
    // 逐条 count=1 + sample 定位源消息（消息级丢弃才走 (code,kind,source) 聚合，见投影分派 describe）
    expect(session.degradations).toHaveLength(3)
    for (const d of session.degradations) {
      expect(d.code).toBe('dropped_transient')
      expect(d.count).toBe(1)
    }
    expect(session.degradations.map((d) => d.sample?.messageId)).toEqual(['m1', 'm2', 'm2'])
    // 产物侧行为反证：call_5 整对丢弃、hologram 跳过（两条 m2 级损失即上方登记）
    expect(serializeSession(session.entries)).not.toContain('"call_5"')
    expect(serializeSession(session.entries)).not.toContain('hologram')
  })
})

// ── 消息级投影分派（classifyMessage → §7.3 落点映射表）──────────────────────────────
// 自 runtime dev 演进版移植（11 用例整组，git 可追溯）。

describe('消息投影分派：六策略落点 + unclassified', () => {
  it('realUserInput：带 semantics 新数据与无 semantics 旧数据同落 user entry（text part 逐条）', () => {
    const msgs: ZcodeMessageInput[] = [
      userMessage('m-sem', [textPart('带语义'), textPart('第二段')], { semantics: REAL_USER_SEMANTICS }),
      userMessage('m-legacy', [textPart('无语义')], {}, 2000),
    ]
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    expect(lines.map((e) => [e.type, e.message?.role])).toEqual([
      ['session_info', undefined],
      ['message', 'user'],
      ['message', 'user'],
    ])
    expect((lines[1] as ParsedEntry & { message: { content: unknown[] } }).message.content).toHaveLength(2)
  })

  it('visibleAssistant：带 semantics 新数据与无 semantics 旧数据同落 assistant entry（切段/usage 现状不变）', () => {
    const msgs = [
      assistantMessage(
        [stepStart(), textPart('带语义助手', 2500), stepFinish('stop', { input: 1, output: 1 })],
        { semantics: VISIBLE_ASSISTANT_SEMANTICS },
      ),
      assistantMessage([stepStart(), textPart('旧数据助手', 2600), stepFinish('stop', { input: 2, output: 2 })], {}, 3000, 'm-asst2'),
    ]
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    expect(lines.map((e) => e.message?.role)).toEqual([undefined, 'assistant', 'assistant'])
    expect((lines[1] as ParsedEntry & { message: { usage: Record<string, unknown> } }).message.usage).toEqual({ input: 1, output: 1 })
  })

  it('providerContextOnly × background_task → 整条丢弃（零 entry）+ L1 dropped_redundant', () => {
    const msgs = [
      userMessage('m-bg', [textPart('<task-notification>后台结果')], { source: 'background_task', semantics: BACKGROUND_SEMANTICS }),
    ]
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    expect(toLines(session)).toHaveLength(1) // 仅 session_info
    expect(session.degradations).toEqual([
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
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    const lines = toLines(session)
    // G1：6 条 user role 消息仅 1 条产 user entry（其余为投影丢弃类，不再冒充用户气泡）；
    // 该条是首个 message entry（session_info 占 00000001）
    const userEntries = lines.filter((e) => e.message?.role === 'user')
    expect(userEntries).toHaveLength(1)
    expect(userEntries[0]?.id).toBe('00000002')
    // 聚合形态：首遇序 4 组、同维度 count 合并；sample 仅 unclassified 携带（此处无）
    expect(session.degradations).toEqual([
      { code: 'dropped_redundant', kind: 'background_notification', source: 'background_task', count: 2 },
      { code: 'dropped_transient', source: 'todo_reminder', count: 1 },
      { code: 'dropped_transient', kind: 'system_reminder', count: 1 },
      { code: 'dropped_transient', count: 1 },
    ])
  })

  it('providerContextOnly 旧数据兜底（legacy metadata.source）→ L2 dropped_transient（source 维度）', () => {
    const msgs = [userMessage('m-todo', [textPart('待办')], { metadata: { source: 'todo_reminder' } })]
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    expect(toLines(session)).toHaveLength(1)
    expect(session.degradations).toEqual([{ code: 'dropped_transient', source: 'todo_reminder', count: 1 }])
  })

  it('hiddenSynthetic → 整条丢弃 + L2（kind 维度，source 缺则键缺省）', () => {
    const msgs = [
      userMessage('m-synth', [textPart('提醒')], {
        synthetic: true,
        semantics: { kind: 'system_reminder', origin: 'system', uiVisibility: 'hidden', transcriptVisibility: 'hidden' },
      }),
    ]
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    expect(toLines(session)).toHaveLength(1)
    expect(session.degradations).toEqual([{ code: 'dropped_transient', kind: 'system_reminder', count: 1 }])
  })

  it('timelineOnly：旧数据 part 级 timeline 通道与 fork 来源同整条丢弃（fork 独立分支，source 维度区分分组）', () => {
    const session = convertZcodeTranscript(
      [
        userMessage('m-tl', [part({ type: 'timeline', timelineType: 'model_change' })]),
        userMessage('m-fork', [textPart('fork 摘要')], { source: 'fork' }, 3000),
      ],
      { ...SESSION_INPUT, title: 'T' },
    )
    expect(toLines(session)).toHaveLength(1)
    expect(session.degradations).toEqual([
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
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    const lines = toLines(session)
    // m-old：合并路径不产 user entry / custom entry——摘要宿主与关联 part 合为单条 compaction entry
    expect(lines.map((e) => [e.type, e.message?.role])).toEqual([
      ['session_info', undefined],
      ['compaction', undefined], // m-old 合并产物
      ['message', 'user'], // m-new 退化路径（零 text part → 空 content，现状形态）
    ])
    const merged = lines[1] as ParsedEntry & { summary: string; firstKeptEntryId: string; tokensBefore: number; details: Record<string, unknown>; timestamp: string }
    expect(merged.summary).toBe('旧摘要')
    expect(merged.tokensBefore).toBe(90000)
    expect(merged.details).toEqual(compactionPart)
    // ① 级锚缺 tail_start_id → ② 级紧邻前驱 = session_info 的 entry id（首条 entry 场景）
    expect(merged.firstKeptEntryId).toBe('00000001')
    expect(merged.timestamp).toBe(new Date(1000).toISOString())
    // m-new 退化：user entry 空内容（现状形态）+ compaction_unlinked（L3，宿主 kind 注解）
    expect((lines[2] as ParsedEntry & { message: { content: unknown[] } }).message.content).toEqual([])
    expect(session.degradations).toEqual([{ code: 'compaction_unlinked', kind: 'compact_summary', count: 1 }])
  })

  it('unclassified → 丢弃 + L4 独立码 + sample 携带 messageId 与文本前 80 字（G3 未知不静默不猜）', () => {
    const longText = `a${'b'.repeat(120)}`
    const msgs = [userMessage('m-unk', [textPart(longText)], { semantics: { kind: 'zcode_future_kind', origin: 'real_user' } })]
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    expect(toLines(session)).toHaveLength(1) // 仅 session_info，消息整体丢弃
    expect(session.degradations).toEqual([
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
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    const lines = toLines(session)
    // toolResult 仍产出截断版 output
    const tr = lines[2] as ParsedEntry & { message: { content: Array<{ type: string; text: string }> } }
    expect(tr.message.content).toEqual([{ type: 'text', text: '截断后的部分输出' }])
    expect(session.degradations).toEqual([{ code: 'truncated_output', count: 1, kind: 'assistant_response' }])
  })

  it('无标记未知 role 消息：分类器兜底末段裁决（realUserInput）——D1 同源显隐，不再 role 分派丢弃', () => {
    const msgs = [{ id: 'm-x', data: { role: 'system', time: { created: 1 } }, parts: [textPart('x')] }]
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    const lines = toLines(session)
    // 旧 role 分派会丢弃+降级登记；分类器（asar 移植体）对无标记非 assistant 消息判
    // realUserInput——zcode GUI 对同类消息同样显示为用户输入，taiji 不二次覆盖
    expect(lines.map((e) => [e.type, e.message?.role])).toEqual([
      ['session_info', undefined],
      ['message', 'user'],
    ])
    expect(session.degradations).toEqual([])
  })
})

// ── 边界细分：切段/尾段/T3c/usage 缺失/空段 ────────────────────────────────────────

describe('切段与 T3c 边界', () => {
  it('尾段未收口有内容则闭合：无 error 证据 → stop 保底 + 零 usage 兜底（不变量门）', () => {
    const msgs = [
      assistantMessage([
        stepStart(),
        textPart('tail without finish', 2500),
        // 无 step-finish —— 消息结束边界闭合
      ]),
    ]
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    const assistant = lines[1] as ParsedEntry & { message: { stopReason: string; usage?: Record<string, unknown>; content: Array<{ type: string }>; timestamp: number } }
    expect(lines).toHaveLength(2) // session_info + assistant
    expect(assistant.message.stopReason).toBe('stop')
    // 2026-09-21 毒消息事故后新契约：assistant 恒带 usage（pi 读面裸读，缺键即崩续聊）
    expect(assistant.message.usage).toMatchObject({ totalTokens: 0 })
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
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    expect(lines).toHaveLength(1) // 仅 session_info
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
      const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
      const assistant = lines[1] as ParsedEntry & { message: { stopReason: string } }
      expect(assistant.message.stopReason, `finish=${String(reason)}`).toBe(expected)
    }
  })

  it('step-finish 无 tokens → 无 usage 字段；缺失分量键缺省（RT-5#1 不补 0），显式 cost 0 是测量值保留', () => {
    const msgs = [
      assistantMessage([stepStart(), textPart('x', 2500), stepFinish('stop', { input: 3, output: 4 }, 0)]),
    ]
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    const a = lines[1] as ParsedEntry & { message: { usage: Record<string, unknown> } }
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
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    const a = lines[1] as ParsedEntry & { message: { usage: Record<string, unknown> } }
    // input/cacheRead/cacheWrite/totalTokens 缺 → 键不存在（≠ 0 假数据）；cost 只有单字段 total
    expect(a.message.usage).toEqual({ output: 7, cost: { total: 0.2 } })
    expect(a.message.usage).not.toHaveProperty('input')
    expect(a.message.usage).not.toHaveProperty('totalTokens')
  })

  it('RT-5#1：tokens 分量全部不可解 → 零 usage 兜底（不变量门）+ part 级降级登记', () => {
    const msgs = [
      // tokens 是 record 但无任何可解分量；cost 也缺失 → 真实 usage 无从映射
      assistantMessage([stepStart(), textPart('x', 2500), stepFinish('stop', { cache: {} })]),
    ]
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    const lines = toLines(session)
    const a = lines[1] as ParsedEntry & { message: Record<string, unknown> }
    // 2026-09-21 毒消息事故后新契约：不可解不等于可缺键——零值兜底（pi 读面裸读）
    expect(a.message.usage).toMatchObject({ totalTokens: 0 })
    // 本 fixture 唯一损失即该登记：结构化形态（code + count + sample 定位源消息）
    expect(session.degradations).toHaveLength(1)
    expect(session.degradations[0]).toMatchObject({ code: 'dropped_transient', count: 1, sample: { messageId: 'm-asst' } })
  })

  it('T4 object 形态：completed+object output → details（content 留空数组）——前向防御分支', () => {
    const msgs = [
      assistantMessage([
        stepStart(),
        toolPart('call_o', 'Write', { status: 'completed', input: { file_path: '/c' }, output: { ok: true, files: ['/c'] } }),
        stepFinish('tool-calls', { input: 1, output: 1 }),
      ]),
    ]
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    const tr = lines[2] as ParsedEntry & { message: { content: unknown[]; details: Record<string, unknown> } }
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
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    const lines = toLines(session)
    const tr = lines[2] as ParsedEntry & { message: { content: unknown[] } }
    expect(tr.message.content).toEqual([])
    expect(session.degradations).toHaveLength(1)
    expect(session.degradations[0]).toMatchObject({ code: 'dropped_transient', count: 1, sample: { messageId: 'm-asst' } })
  })

  it('message.data.time.created 缺失 → 回落 session 创建时刻（确定性兜底，无 Date.now）', () => {
    const msgs = [{ id: 'm-u', data: { role: 'user' }, parts: [textPart('fallback')] }]
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    const user = lines[1] as ParsedEntry & { timestamp: string; message: { timestamp: number } }
    expect(user.timestamp).toBe(NORMALIZED_TIMESTAMP)
    expect(user.message.timestamp).toBe(SESS_CREATED_MS)
  })

  it('RT-5#8：session.timeCreated 不可解 → 不伪造 1970（header/message.timestamp 缺省键、降级登记）', () => {
    const msgs = [
      { id: 'm-u', data: { role: 'user' }, parts: [textPart('no-time')] },
      assistantMessage([stepStart(), textPart('x', 2500), stepFinish('stop', { input: 1 })], {}, 2000),
    ]
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, timeCreated: Number.NaN })
    const lines = toLines(session)
    // header.timestamp 键缺省（0 = 1970 假测量值，宁缺不伪造）
    expect(session.header).toEqual({ id: NORMALIZED_ID })
    const user = lines[1] as ParsedEntry
    // entry.timestamp / message.timestamp（ms）均缺省键——undefined ≠ 0
    expect(user).not.toHaveProperty('timestamp')
    expect(user.message).not.toHaveProperty('timestamp')
    // session 级登记无消息 id → 单条 dropped_transient 且无 sample；本场景仅此一条降级，
    // 长度 + 形态即唯一指认「时间不可解」这条登记
    expect(session.degradations).toHaveLength(1)
    expect(session.degradations[0]?.code).toBe('dropped_transient')
    expect(session.degradations[0]?.sample).toBeUndefined()
    // assistant 段有自身 time 锚（2500）与消息 time.created（2000）时不受 header 不可解影响
    const assistant = lines[2] as ParsedEntry & { timestamp: string; message: { timestamp: number } }
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
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    const lines = toLines(session)
    // 产物仅 session_info + assistant（text 段）：4 个畸形 tool 零 toolCall、零 toolResult
    expect(lines).toHaveLength(2)
    const a = lines[1] as ParsedEntry & { message: { role: string; content: Array<Record<string, unknown>> } }
    expect(a.message.role).toBe('assistant')
    expect(a.message.content).toEqual([{ type: 'text', text: 'before' }])
    const serialized = serializeSession(session.entries)
    expect(serialized).not.toContain('"call_a"')
    expect(serialized).not.toContain('"call_b"')
    // 4 条逐条登记（part 级诊断形态：count=1 + sample 定位源消息）
    expect(session.degradations).toHaveLength(4)
    for (const d of session.degradations) {
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
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    const lines = toLines(session)
    const a = lines[1] as ParsedEntry & { message: { content: Array<Record<string, unknown>> } }
    // 异常 text/reasoning 段被跳过，仅保留合法 text part
    expect(a.message.content).toEqual([{ type: 'text', text: 'kept' }])
    expect(session.degradations).toHaveLength(2)
    for (const d of session.degradations) {
      expect(d).toMatchObject({ code: 'dropped_transient', count: 1, sample: { messageId: 'm-asst' } })
    }
  })
})

// ── T3c 事故回归（2026-09-21 毒消息）：取消/失败轮的 stopReason 语义与 usage 不变量 ─────
// 事故链：zcode 取消轮（data.error.turnResult=cancelled、无 step-finish part）→ 旧实现
// 尾段 'stop' 保底且不带 usage → pi 读面对「非 aborted/error 的 assistant」裸读 usage
// （stats 聚合 agent-session.js:2678 / turn 前上下文扫描 :2721）→ 导入后续聊即崩。
// pi dist 真实加载的不变量断言在同目录 pi-reader-invariant.test.ts（PS-41 探针）。
describe('T3c cancelled/error turn regression (poison-message incident)', () => {
  const CANCELLED_ERROR = {
    name: 'AiSdkModelAdapterError',
    data: { message: 'Model request was cancelled.', code: 'model_request_cancelled', turnResult: 'cancelled' },
  }

  function assistantOf(msgs: ZcodeMessageInput[]): Array<{ message: { stopReason?: string; usage?: Record<string, unknown> } }> {
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    return lines.filter((e) => e.message?.role === 'assistant') as Array<{ message: { stopReason?: string; usage?: Record<string, unknown> } }>
  }

  it('取消轮（无 step-finish + data.error.cancelled）→ aborted + 零 usage（不变量门兜底）', () => {
    const msgs = [
      assistantMessage(
        [stepStart(), reasoningPart('半截思考', 2100)],
        { error: CANCELLED_ERROR, providerId: 'account:p', modelId: 'GLM-5.3' },
      ),
    ]
    const [a] = assistantOf(msgs)
    expect(a).toBeDefined()
    expect(a.message.stopReason).toBe('aborted')
    expect(a.message.usage).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { total: 0 },
    })
  })

  it('失败轮（data.error 无 turnResult）→ error', () => {
    const msgs = [
      assistantMessage([stepStart(), textPart('部分输出', 2200)], {
        error: { name: 'AiSdkModelAdapterError', data: { code: 'model_error' } },
      }),
    ]
    const [a] = assistantOf(msgs)
    expect(a.message.stopReason).toBe('error')
    expect(a.message.usage).toBeDefined()
  })

  it('已收口段保留 finish 语义；仅未收口尾段吃 error 覆盖', () => {
    const msgs = [
      assistantMessage(
        [
          stepStart(),
          textPart('第一步完成', 2100),
          stepFinish('stop', { input: 100, output: 20, total: 120 }, 0),
          reasoningPart('尾段思考', 2600),
        ],
        { error: CANCELLED_ERROR },
      ),
    ]
    const asst = assistantOf(msgs)
    expect(asst).toHaveLength(2)
    expect(asst[0].message.stopReason).toBe('stop')
    expect(asst[0].message.usage).toMatchObject({ input: 100, totalTokens: 120 })
    expect(asst[1].message.stopReason).toBe('aborted')
    expect(asst[1].message.usage).toMatchObject({ totalTokens: 0 })
  })

  it('step-finish tokens 全分量不可解 → 降级登记 + 零 usage 兜底，finish 语义保留', () => {
    const msgs = [assistantMessage([stepStart(), textPart('x', 2100), stepFinish('stop', { input: 'NaN' })])]
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    const [a] = assistantOf(msgs)
    expect(a.message.stopReason).toBe('stop')
    expect(a.message.usage).toMatchObject({ totalTokens: 0 })
    expect(
      session.degradations.some((d) => d.code === 'dropped_transient' && d.sample?.messageId === 'm-asst'),
    ).toBe(true)
  })

  it('未知 finish 值（有收口）→ stop 保底 + 真实 usage 直通', () => {
    const msgs = [
      assistantMessage([stepStart(), textPart('x', 2100), stepFinish('mystery-finish', { input: 5, output: 5, total: 10 })]),
    ]
    const [a] = assistantOf(msgs)
    expect(a.message.stopReason).toBe('stop')
    expect(a.message.usage).toMatchObject({ totalTokens: 10 })
  })

  it('无 error 证据的未收口尾段 → stop 保底 + 零 usage（不变量门独立于 error 覆盖生效）', () => {
    const msgs = [assistantMessage([textPart('半截', 2100)])]
    const [a] = assistantOf(msgs)
    expect(a.message.stopReason).toBe('stop')
    expect(a.message.usage).toMatchObject({ totalTokens: 0 })
  })

  it('step-start-only 取消消息（无内容 part）→ 不产 assistant entry（空段丢弃，行为钉住）', () => {
    const msgs = [assistantMessage([stepStart()], { error: CANCELLED_ERROR })]
    expect(assistantOf(msgs)).toHaveLength(0)
  })
})

// ── canonical 合法性 + applyEntry 重放锚 ─────────────────────────────────────────────

describe('canonical 合法性与 applyEntry 重放锚', () => {
  const session = convertZcodeTranscript(kitchenSinkMessages(), { ...SESSION_INPUT, title: 'Sink' })
  const lines = toLines(session)
  const { messages, orphans } = replayEntries(lines)

  it('canonical round-trip：serializeSession → parseSessionContent 零坏行、冻结字段序列一致', () => {
    // 产物合法性机器锚：基座严格解析器（坏行计数）对产物零丢弃 = 每条 entry 均满足
    // canonical Entry 结构（type/id/parentId 必填 + message.role 合法域）
    const roundTrip = parseSessionContent(serializeSession(session.entries))
    expect(roundTrip.skippedLines).toBe(0)
    expect(roundTrip.lastLinePartial).toBe(false)
    expect(roundTrip.entries).toHaveLength(session.entries.length)
    expect(roundTrip.entries.map((e) => [e.type, e.id, e.parentId, e.message?.role])).toEqual(
      lines.map((e) => [e.type, e.id, e.parentId, e.message?.role]),
    )
  })

  it('消息序列与角色：user → assistant → assistant（toolResult 并入所属 assistant）', () => {
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user'])
  })

  it('toolCall 配对：4 个 toolCall 按 toolCallId 回填 output/status；T3b 映射名生效', () => {
    const first = messages[1] as ReplayedMessage
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
    const first = messages[1] as ReplayedMessage
    expect(first.usage).toEqual({ inputTokens: 80, outputTokens: 20 })
    expect(first.thinking?.[0]?.content).toBe('let me think')
    expect(first.content).toContain('Editing now')
    const second = messages[2] as ReplayedMessage
    expect(second.usage).toEqual({ inputTokens: 40, outputTokens: 20 })
    expect(second.content).toBe('All done')
    expect(second.toolCalls).toBeUndefined()
  })

  it('compaction custom entry 不产生对话流消息（GUI 跳过）；无孤儿 toolResult', () => {
    // custom 不进 messages；compaction 未伪造为压缩系统消息
    expect(messages).toHaveLength(4)
    const { orphans: rechecked } = replayEntries(lines)
    expect(rechecked).toHaveLength(0)
    expect(orphans).toHaveLength(0)
  })
})

// ── id 归一化（normalize.ts 迁入承载）───────────────────────────────────────────────

describe('normalizeZcodeSessionId（T1 header.id 归一化域）', () => {
  it('剥 sess_ 前缀一次 + 全部下划线替换 + 幂等；zcodeCandidateKey 同一实现', () => {
    expect(normalizeZcodeSessionId('sess_0198abc-00_11')).toBe('0198abc-00-11')
    expect(normalizeZcodeSessionId('sess_sess_x')).toBe('sess-x') // 双前缀只剥一次
    expect(normalizeZcodeSessionId('plain-id')).toBe('plain-id') // 无前缀不剥
    const once = normalizeZcodeSessionId('sess_a_b')
    expect(normalizeZcodeSessionId(once)).toBe(once) // 幂等：normalize(normalize(x)) === normalize(x)
    expect(zcodeCandidateKey('sess_a_b')).toBe(once) // 打标域与 header 域构造性一致
  })

  it('后置条件失败 fail-fast（归一化后为空 / 非法字符），错误含原始 id 与事实归因', () => {
    expect(() => normalizeZcodeSessionId('sess_')).toThrow(/归一化后为空/)
    expect(() => normalizeZcodeSessionId('sess_空格 id')).toThrow(/非法字符/)
    // 错误面归消费侧（普通 Error，非私建错误码类）——消费方按各自词表映射
    try {
      normalizeZcodeSessionId('sess_空格 id')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('超出已验证域')
    }
  })
})

// ── 端到端：fixture sqlite 库 → readZcodeSession ────────────────────────────────────

describe('端到端：fixture 库 → readZcodeSession → NormalizedSession', () => {
  let fixturesRoot: string
  const E2E_SESSION_ID = 'sess_0198e2e0-0000-0000-0000-00000000000b'
  const E2E_NORMALIZED_ID = '0198e2e0-0000-0000-0000-00000000000b'
  const E2E_CREATED_MS = 1767225600000

  beforeAll(() => {
    fixturesRoot = makeFixtureDir('zcode-converter-').root
  })
  afterAll(() => {
    // fs 纪律：mkdtempSync 自建自删（flake 守卫硬性要求 maxRetries/retryDelay）
    rmSync(fixturesRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 厨房水槽行集 → fixture seeds（WAL 库 + schema_migration 表，宿主 schema 消费列集）。 */
  async function buildKitchenSinkDb(dirName: string, sessionId: string, title: string): Promise<string> {
    const messages = kitchenSinkMessages()
    const fixtureMessages: FixtureMessage[] = messages.map((m, i) => ({ id: m.id, sessionId, sequence: i, data: m.data }))
    const fixtureParts: FixturePart[] = []
    for (const m of messages) {
      for (const [pi, p] of m.parts.entries()) {
        fixtureParts.push({ id: `${m.id}-p${pi}`, messageId: m.id, sessionId, sequence: pi, data: p })
      }
    }
    const { dbPath } = await buildFixtureDb(join(fixturesRoot, dirName), {
      sessions: [
        {
          id: sessionId,
          title,
          directory: '/tmp/zc-e2e-cwd',
          taskType: 'interactive',
          timeCreated: E2E_CREATED_MS,
          timeUpdated: E2E_CREATED_MS + 100000,
        },
      ],
      messages: fixtureMessages,
      parts: fixtureParts,
    })
    return dbPath
  }

  it('readZcodeSession：三键形状 + header 归一化 + 文件名不变量 + degradations 装配 + 可重放', async () => {
    const dbPath = await buildKitchenSinkDb('e2e', E2E_SESSION_ID, 'E2E 会话')
    const session = await readZcodeSession(dbPath, E2E_SESSION_ID)

    // NormalizedSession 三键（D1：形状由 session-core 类型强制）
    expect(Object.keys(session).sort()).toEqual(['degradations', 'entries', 'header'])

    // header：id 归一化（sess_ 剥前缀）、timestamp = session.time_created ISO、cwd 不伪造
    expect(session.header).toEqual({
      id: E2E_NORMALIZED_ID,
      timestamp: new Date(E2E_CREATED_MS).toISOString(),
    })

    // 文件名不变量锚（T1）：归一化 id 无 `_` → 作为文件名尾段可被基座原语精确提取
    //（旧测试断言 prepareImport 产物 fileName 尾段 === header.id；文件名拼装属导入薄包装，
    // 此处断言其成立前提）
    expect(E2E_NORMALIZED_ID).not.toContain('_')
    const headerTimestamp = session.header.timestamp as string // 上一断言已 toEqual 固定其值
    const fileName = `${headerTimestamp.replaceAll(':', '.')}_${E2E_NORMALIZED_ID}.jsonl`
    expect(sessionIdFromFileName(fileName)).toBe(E2E_NORMALIZED_ID)

    // degradations 装配（3 条 part 级诊断：file/running/hologram——compaction 孤儿零降级，
    // 见映射全表 describe；结构化形态 code/count/sample 断言）
    expect(session.degradations).toHaveLength(3)
    for (const d of session.degradations) {
      expect(d.code).toBe('dropped_transient')
      expect(d.count).toBe(1)
    }
    expect(session.degradations.map((d) => d.sample?.messageId)).toEqual(['m1', 'm2', 'm2'])

    // 重放锚：端到端产物与纯函数同源同构
    const { messages } = replayEntries(toLines(session))
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user'])
    expect(messages[1]?.toolCalls?.map((t) => t.toolName)).toEqual(['edit', 'bash', 'ZcodeCustomTool', 'grep'])
  })

  it('session 行在读取阶段复查不存在 → Error（错误面归消费侧映射），消息含 sessionId', async () => {
    const dbPath = await buildKitchenSinkDb('missing', 'sess_0198e2e0-0000-0000-0000-00000000000c', 'Seed')
    await expect(readZcodeSession(dbPath, 'sess_no_such')).rejects.toThrow(/sess_no_such/)
    // 迁移适配：旧断言 toThrow(ImportServiceError)——import_* 错误码属 runtime 消费侧
    // 词表（§1.5 契约第 4 条），本包抛普通 Error，由消费方映射
  })

  it('message.data 非法 JSON → 原始 Error 上抛（schema 漂移域，sqlite-access 不静默跳过）', async () => {
    const dbPath = await buildKitchenSinkDb('drift', 'sess_0198e2e0-0000-0000-0000-00000000000d', 'Drift')
    // 直接注入非法 JSON 行（绕过 buildFixtureDb 的 JSON.stringify——模拟 zcode 升级后的行形态漂移）
    const writer = await openWritableSqlite(dbPath)
    writer.prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)').run('m-bad', 'sess_0198e2e0-0000-0000-0000-00000000000d', 99, '{not json')
    writer.close()

    // 迁移适配：旧断言经 ZcodeImportSource.write 相位（rejects '读取 zcode 会话库失败'）——
    // 错误映射属 runtime 编排面；本包语义 = 原始 Error 原样上抛交消费侧映射
    await expect(readZcodeSession(dbPath, 'sess_0198e2e0-0000-0000-0000-00000000000d')).rejects.toThrow(/不是合法 JSON/)
  })
})
