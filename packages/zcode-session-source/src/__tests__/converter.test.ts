/**
 * zcode → canonical 转换器测试（U4——映射全表逐条 + canonical 合法性 round-trip +
 * applyEntry 重放锚 + fixture 库端到端；自 runtime converter.test.ts 等价迁移，
 * 断言强度不降，见各 describe 注释的迁移适配说明）。
 *
 * 断言分层：
 * 1. 纯函数直测：内存行集（不建真库）→ 产物 entry 逐条断言（映射表即验收标准）。
 *    产物经 serializeSession（基座字节契约，P-serializer 锚）转 JSONL 行后断言，
 *    与旧测试「stringify 产物逐行断言」形态对齐，同时覆盖「键序不重排、接口外
 *    字段不丢失」的序列化兼容面。
 * 2. 重放锚：产物经最小重放器（pi applyEntry 消费语义的测试内同构投影，跨包
 *    import runtime 会成环——手段自证已在 deviations 登记）断言 Entry 树 parentId
 *    链完整 + 消息序列/角色/toolCall 配对/usage 聚合——「合法 pi session」的可证伪
 *    定义；另以 parseSessionContent round-trip 作 canonical 合法性机器锚。
 * 3. 端到端：fixture sqlite 库（helpers.buildFixtureDb，mkdtemp 自建自删）→
 *    readZcodeSession → NormalizedSession 三键形状 + 重放 + degradations 装配 +
 *    文件名不变量。
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
import { convertZcodeTranscript, readZcodeSession, type ZcodeMessageInput } from '../converter.ts'
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
): ZcodeMessageInput {
  return {
    id: 'm-asst',
    data: { role: 'assistant', time: { created: createdMs, completed: createdMs + 5000 }, ...dataExtra },
    parts,
  }
}

/** 厨房水槽行集：T2-T6 全形态覆盖（切段/配对/映射/降级）。 */
function kitchenSinkMessages(): ZcodeMessageInput[] {
  return [
    // m1 user：多 text part + file part（丢弃计降级）
    {
      id: 'm1',
      data: { role: 'user', time: { created: 1000 } },
      parts: [
        textPart('Hello'),
        textPart('Second line'),
        part({ type: 'file', mime: 'image/png', url: 'zcode-artifact://abc' }),
      ],
    },
    // m2 assistant：两段 step 循环 + 四种 tool 形态 + 尾段杂项（running/compaction/timeline/未知）
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
        // 尾段（无 step-finish 收口）：running tool（整对丢弃）+ compaction（T5 custom）+
        // timeline（丢弃）+ 未知 type（跳过+降级）——尾段 content 为空 → 不产出 assistant entry
        toolPart('call_5', 'Read', { status: 'running', input: { file_path: '/b.ts' } }),
        part({ type: 'compaction', auto: true, trigger: 'auto', preCompactTokenCount: 160000, time: { start: 4000, end: 4100 } }),
        part({ type: 'timeline', timelineType: 'model_change' }),
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
 * 相对旧测试「out.content 逐行 parse」的迁移适配：converter 产物已是 entry 对象，
 * 序列化步显式走基座单点，同时覆盖序列化兼容面。
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
    if (e.type !== 'message' || e.message === undefined) continue // session_info/custom 不进对话流
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
    // reasoning 同名 / cost(number)→cost.total 其余分量 0
    expect(a.message.usage).toEqual({
      input: 80,
      output: 20,
      cacheRead: 10,
      cacheWrite: 4,
      reasoning: 5,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
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

  it('T5 compaction → custom entry（customType/data 原样，不伪造 summary）+ 降级明细；timeline 不产出', () => {
    const custom = lines[8] as ParsedEntry & { customType: string; data: Record<string, unknown>; timestamp: string }
    expect(custom.customType).toBe('zcode-import:compaction')
    expect(custom.data).toMatchObject({ type: 'compaction', auto: true, preCompactTokenCount: 160000 })
    expect(custom.timestamp).toBe(new Date(4000).toISOString())
    expect(lines.some((e) => e.type === 'compaction')).toBe(false)
    expect(lines.some((e) => JSON.stringify(e).includes('model_change'))).toBe(false)
    // 降级点 1（D1 两降级点之一）：compaction → custom + degradation 明细，不静默
    expect(session.degradations.some((d) => d.includes('zcode-import:compaction'))).toBe(true)
  })

  it('D6/D7/未知 part：degradations 登记（file 丢弃 / running tool 整对丢弃 / compaction / 未知 type 跳过）', () => {
    // 迁移适配：compaction 点新增降级明细（D1 degradations 契约「语义降级都要留痕」，
    // 旧实现只产 custom entry 不留痕）——3 条 → 4 条，序 = 消息遍历序
    expect(session.degradations).toHaveLength(4)
    expect(session.degradations[0]).toContain('file part')
    expect(session.degradations[1]).toContain('status=running')
    expect(session.degradations[1]).toContain('call_5')
    expect(session.degradations[2]).toContain('zcode-import:compaction')
    expect(session.degradations[3]).toContain('hologram')
    // D7 整对丢弃：产物中无 call_5 的 toolCall 与 toolResult
    expect(serializeSession(session.entries)).not.toContain('"call_5"')
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
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    const assistant = lines[1] as ParsedEntry & { message: { stopReason: string; content: Array<{ type: string }>; timestamp: number } }
    expect(lines).toHaveLength(2) // session_info + assistant
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

  it('step-finish 无 tokens → 无 usage 字段；无 cache/reasoning/cost 字段 → 分量补 0', () => {
    const msgs = [
      assistantMessage([stepStart(), textPart('x', 2500), stepFinish('stop', { input: 3, output: 4 }, 0)]),
    ]
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    const a = lines[1] as ParsedEntry & { message: { usage: Record<string, unknown> } }
    expect(a.message.usage).toEqual({
      input: 3,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    })
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
    expect(session.degradations.join('\n')).toContain('typeof number')
  })

  it('未知 message role → 跳过消息 + 降级登记（前向兼容不炸读取）', () => {
    const msgs = [{ id: 'm-x', data: { role: 'system', time: { created: 1 } }, parts: [textPart('x')] }]
    const session = convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' })
    expect(toLines(session)).toHaveLength(1) // 仅 session_info
    expect(session.degradations[0]).toContain('system')
  })

  it('message.data.time.created 缺失 → 回落 session 创建时刻（确定性兜底，无 Date.now）', () => {
    const msgs = [{ id: 'm-u', data: { role: 'user' }, parts: [textPart('fallback')] }]
    const lines = toLines(convertZcodeTranscript(msgs, { ...SESSION_INPUT, title: 'T' }))
    const user = lines[1] as ParsedEntry & { timestamp: string; message: { timestamp: number } }
    expect(user.timestamp).toBe(NORMALIZED_TIMESTAMP)
    expect(user.message.timestamp).toBe(SESS_CREATED_MS)
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
    const structDegradations = session.degradations.filter((d) => d.includes('tool part 结构异常'))
    expect(structDegradations).toHaveLength(4)
    for (const d of structDegradations) {
      expect(d).toContain('（callID/tool/state 形态）整对丢弃：message=m-asst')
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
    expect(session.degradations).toContain('text part 文本形态异常（number）跳过：message=m-asst')
    expect(session.degradations).toContain('reasoning part 文本形态异常（number）跳过：message=m-asst')
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

    // degradations 装配（4 条：file/running/compaction/hologram——compaction 点为
    // D1 两降级点之一，见映射全表 describe 的迁移适配说明）
    expect(session.degradations).toHaveLength(4)

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
