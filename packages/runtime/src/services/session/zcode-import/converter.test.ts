/**
 * zcode→pi 转换器测试（U4——设计 §3.4 T1-T6/T3b/T3c 权威映射表逐条 + §4 V3 产物合法性 /
 * V6 边界降级）。
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
        // 尾段（无 step-finish 收口）：running tool（D7 整对丢弃）+ compaction（T5 custom）+
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

// ── T2/T3/T4/T5：行级映射断言（厨房水槽）────────────────────────────────────────────

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

  it('T5 compaction → custom entry（customType/data 原样，不伪造 summary）；timeline 不产出', () => {
    const custom = entries[8] as { customType: string; data: Record<string, unknown>; timestamp: string }
    expect(custom.customType).toBe('zcode-import:compaction')
    expect(custom.data).toMatchObject({ type: 'compaction', auto: true, preCompactTokenCount: 160000 })
    expect(custom.timestamp).toBe(new Date(4000).toISOString())
    expect(entries.some((e) => e.type === 'compaction')).toBe(false)
    expect(entries.some((e) => JSON.stringify(e).includes('model_change'))).toBe(false)
  })

  it('D6/D7/未知 part：degradations 登记（file 丢弃 / running tool 整对丢弃 / 未知 type 跳过）', () => {
    expect(out.degradations).toHaveLength(3)
    expect(out.degradations[0]).toContain('file part')
    expect(out.degradations[1]).toContain('status=running')
    expect(out.degradations[1]).toContain('call_5')
    expect(out.degradations[2]).toContain('hologram')
    // D7 整对丢弃：产物中无 call_5 的 toolCall 与 toolResult
    expect(out.content).not.toContain('"call_5"')
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

  it('step-finish 无 tokens → 无 usage 字段；无 cache/reasoning/cost 字段 → 分量补 0', () => {
    const msgs = [
      assistantMessage([stepStart(), textPart('x', 2500), stepFinish('stop', { input: 3, output: 4 }, 0)]),
    ]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    const a = entries[1] as { message: { usage: Record<string, unknown> } }
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
    expect(out.degradations.join('\n')).toContain('typeof number')
  })

  it('未知 message role → 跳过消息 + 降级登记（前向兼容不炸导入）', () => {
    const msgs = [{ id: 'm-x', data: { role: 'system', time: { created: 1 } }, parts: [textPart('x')] }]
    const out = buildZcodeSessionFile(msgs, 'T', HEADER)
    expect(parseOutput(out).entries).toHaveLength(1) // 仅 session_info
    expect(out.degradations[0]).toContain('system')
  })

  it('message.data.time.created 缺失 → 回落 header.timestamp（确定性兜底，无 Date.now）', () => {
    const msgs = [{ id: 'm-u', data: { role: 'user' }, parts: [textPart('fallback')] }]
    const { entries } = parseOutput(buildZcodeSessionFile(msgs, 'T', HEADER))
    const user = entries[1] as { timestamp: string; message: { timestamp: number } }
    expect(user.timestamp).toBe(HEADER.timestamp)
    expect(user.message.timestamp).toBe(Date.parse(HEADER.timestamp))
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
