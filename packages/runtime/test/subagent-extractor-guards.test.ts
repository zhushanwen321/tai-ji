/**
 * subagent-extractor 畸形输入守卫定向测试（CRAP 靶子：projectSelfDescribedSubagentRecord /
 * parseLegacyToolCallBlock / projectSubagentStartArgs / projectLegacyToolResultData /
 * buildLegacySubagentRecord）。
 *
 * 已有 subagent-extractor.test.ts 覆盖正常路径（快照投影 / bg-notify 终态 / sessionFile
 * 回退扫描）；本文件专测 PR #185 type-safety review 加的 shape 守卫族——输入源是
 * LLM 生成的 toolCall arguments / toolResult 文本 JSON.parse 产物 / extension 写入的
 * entry data（全部不可信），畸形值不得以谎报类型直达 SubagentRecord（下游 readFileSync
 * 对非 string sessionFile 会 throw）。每条守卫用例在「裸断言透传」的未修复形态下会红。
 *
 * 运行：cd packages/runtime && npx vitest run test/subagent-extractor-guards.test.ts
 */
import { describe, expect, it } from 'vitest'
import { scanSubagentEntries } from '../src/services/session/subagent-extractor.js'
import { SUBAGENT_RECORD_CUSTOM_TYPE } from '@xyz-agent/shared'
import type { SubagentRecord } from '@xyz-agent/shared'

/** 自描述 subagent-record entry 构造（type:'custom' 是 pi JSONL 持久化层形态）。 */
function recordEntry(data: Record<string, unknown>): Record<string, unknown> {
  return { type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, data }
}

/** 完整合法自描述 data（守卫用例的基线，畸形字段逐个覆写）。 */
function validRecordData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: 'sub-1',
    status: 'running',
    sessionFile: '/pi/sub-1.jsonl',
    agent: 'worker',
    slug: 'w1',
    task: 'do',
    startedAt: 1000,
    endedAt: 61000,
    ...overrides,
  }
}

/** [legacy] assistant toolCall block 构造。 */
function toolCallBlock(args: unknown, id = 'tc-1'): Record<string, unknown> {
  return { type: 'toolCall', name: 'subagent', id, arguments: args }
}

/** [legacy] toolResult message entry 构造（content[0].text = JSON 字符串）。 */
function toolResultEntry(toolCallId: string, text: string): Record<string, unknown> {
  return {
    type: 'message',
    message: { role: 'toolResult', toolName: 'subagent', toolCallId, content: [{ type: 'text', text }] },
  }
}

const find = (records: SubagentRecord[], id: string): SubagentRecord | undefined =>
  records.find((r) => r.subagentId === id)

/** [legacy] assistant start toolCall block（module 级共享 fixture）。 */
const startBlock = toolCallBlock({ action: 'start', startParam: { agent: 'worker', task: 't' } })

/** [legacy] toolCall × toolResult 配对 entries（module 级共享 fixture）。 */
function pair(toolResultText: string, block: Record<string, unknown> = startBlock): Array<Record<string, unknown>> {
  return [
    { type: 'message', message: { role: 'assistant', content: [block] } },
    toolResultEntry('tc-1', toolResultText),
  ]
}

describe('自描述 subagent-record 投影守卫（projectSelfDescribedSubagentRecord）', () => {
  it('必填 id 非字符串 → 坏 entry 跳过，同批其余合法 entry 照常产出', () => {
    const records = scanSubagentEntries([
      recordEntry(validRecordData({ id: 123 })), // id 畸形：number
      recordEntry(validRecordData({ id: 'sub-ok' })),
    ])
    expect(records.map((r) => r.subagentId)).toEqual(['sub-ok'])
  })

  it('必填 status 非字符串 → 坏 entry 跳过（全部无效时落 legacy 兜底 → 空数组）', () => {
    expect(scanSubagentEntries([
      recordEntry(validRecordData({ status: null })),
      recordEntry(validRecordData({ status: 3 })),
    ])).toEqual([])
  })

  it('可选字段类型畸形 → 逐字段缺省（undefined），不用谎报类型值填充', () => {
    const records = scanSubagentEntries([
      recordEntry(validRecordData({
        startedAt: 'not-a-number',
        endedAt: [],
        turns: '3',
        totalTokens: '100',
        model: 42,
        error: { code: 1 },
      })),
    ])
    const r = records[0]
    expect(r.startedAt).toBeUndefined()
    expect(r.endedAt).toBeUndefined()
    expect(r.turns).toBeUndefined()
    expect(r.totalTokens).toBeUndefined()
    expect(r.model).toBeUndefined()
    expect(r.error).toBeUndefined()
    // 非守卫字段缺省链不变（agent 兜底 general-purpose、slug/task 兜底空串）
    expect(r.agent).toBe('worker')
    expect(r.slug).toBe('w1')
  })

  it('elapsedSeconds 派生：endedAt ≥ startedAt 按差值取整秒；endedAt < startedAt 不派生（负时长是脏数据）', () => {
    const ok = scanSubagentEntries([recordEntry(validRecordData({ startedAt: 1000, endedAt: 61000 }))])
    expect(ok[0].elapsedSeconds).toBe(60) // 60000ms → 60s

    const dirty = scanSubagentEntries([recordEntry(validRecordData({ startedAt: 61000, endedAt: 1000 }))])
    expect(dirty[0].elapsedSeconds).toBeUndefined()
  })

  it('closedReason 仅 closed 终态投影（running/done 带 closedReason 的脏组合被丢弃）', () => {
    const running = scanSubagentEntries([recordEntry(validRecordData({ status: 'running', closedReason: 'gc' }))])
    expect(running[0].closedReason).toBeUndefined()
    const closed = scanSubagentEntries([recordEntry(validRecordData({ status: 'closed', closedReason: 'gc' }))])
    expect(closed[0].closedReason).toBe('gc')
  })

  // R3-1（H2 阶段 3 一致性审查修复）：origin 透传断言——此前投影白名单漏 origin，
  // renderer 过滤面（badge 计数 / hasRunning / 列表桶）origin 恒 undefined，workflow
  // record 运行期虚亮。守卫语义对齐 core readEntryOriginFields：仅认 'tool'|'workflow'
  // 字面量，非法值/缺省 → undefined（= tool 语义，存量 entry 零迁移）。
  it('origin 字面量透传：workflow/tool 透传，非法值与缺省 → undefined（renderer 过滤面数据源契约）', () => {
    const projected = scanSubagentEntries([
      recordEntry(validRecordData({ id: 'sub-wf', origin: 'workflow' })),
      recordEntry(validRecordData({ id: 'sub-tool', origin: 'tool' })),
      recordEntry(validRecordData({ id: 'sub-bogus', origin: 'bogus' })), // 非法字面量
      recordEntry(validRecordData({ id: 'sub-legacy' })), // 缺省（v1 前存量 entry）
    ])
    const byId = (id: string): SubagentRecord | undefined => projected.find((r) => r.subagentId === id)
    expect(byId('sub-wf')?.origin).toBe('workflow')
    expect(byId('sub-tool')?.origin).toBe('tool')
    expect(byId('sub-bogus')?.origin).toBeUndefined()
    expect(byId('sub-legacy')?.origin).toBeUndefined()
  })
})

describe('legacy toolCall arguments 守卫（parseLegacyToolCallBlock + projectSubagentStartArgs）', () => {
  const startArgs = { action: 'start', startParam: { agent: 'worker', slug: 'w', task: 't' } }
  const bgResult = JSON.stringify({ action: 'start', subagentId: 'sub-bg', sessionFile: null, bgResponse: { status: 'running' } })

  it('action 非 start（list/status 等）→ 跳过该 block 不产出记录', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: [toolCallBlock({ action: 'list' }, 'tc-1')] } },
    ]
    expect(scanSubagentEntries(entries)).toEqual([])
  })

  it('startParam 非对象（string / array / null / 缺失）→ 跳过（LLM 畸形参数不进投影）', () => {
    for (const bad of ['just-a-string', ['array'], null, undefined]) {
      const entries = [
        { type: 'message', message: { role: 'assistant', content: [toolCallBlock({ action: 'start', startParam: bad })] } },
        // 有 bgResponse 的配对 toolResult（无 toolCall 配对则本就无记录——需成对验证守卫拆散配对）
        { type: 'message', message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'tc-1', content: [{ type: 'text', text: bgResult }] } },
      ]
      expect(scanSubagentEntries(entries)).toEqual([])
    }
  })

  it('startParam 字段畸形（agent 非字符串）→ 字段缺省兜底（agent 兜底 general-purpose）', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: [toolCallBlock({ action: 'start', startParam: { agent: 99, slug: ['x'], task: null } })] } },
      { type: 'message', message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'tc-1', content: [{ type: 'text', text: bgResult }] } },
    ]
    const records = scanSubagentEntries(entries)
    expect(records).toHaveLength(1)
    expect(records[0].agent).toBe('general-purpose') // 畸形 agent 缺省 → DEFAULT_AGENT_NAME 兜底
    expect(records[0].slug).toBe('')
    expect(records[0].task).toBe('')
  })
})

describe('legacy toolResult 文本 JSON 守卫（projectLegacyToolResultData）', () => {
  function withToolResult(text: string): Array<Record<string, unknown>> {
    return pair(text)
  }

  it('JSON.parse 产物非 plain object（string / number / array / null）→ 整条丢弃不产出', () => {
    // 任意合法 JSON 都能 parse 成功——parse 成功 ≠ 形状正确，守卫在此
    expect(scanSubagentEntries(withToolResult('"just a string"'))).toEqual([])
    expect(scanSubagentEntries(withToolResult('42'))).toEqual([])
    expect(scanSubagentEntries(withToolResult('[1,2,3]'))).toEqual([])
    expect(scanSubagentEntries(withToolResult('null'))).toEqual([])
  })

  it('bgResponse.status / message 畸形 → status 兜底空串、message 缺省（不透传谎报类型）', () => {
    const records = scanSubagentEntries(withToolResult(JSON.stringify({
      action: 'start',
      subagentId: 'sub-bg',
      sessionFile: 123, // 畸形：number（裸断言会让 readFileSync 对非 string throw）
      bgResponse: { status: 7, message: ['nope'] },
    })))
    expect(records).toHaveLength(1)
    // 配对成立（bgResponse 存在即产出记录），畸形字段归守卫缺省
    expect(records[0].subagentId).toBe('sub-bg')
    expect(records[0].sessionFile).toBeNull() // 畸形 sessionFile → null（不透传 number）
  })

  it('listResponse 畸形族：items 非数组 / running 非数字 / 元素级畸形——全部守卫不崩，配对 bgResponse 时合法 item 照常投影', () => {
    // items 非数组 + running 畸形：parse 投影为 { running: 0, items: [] }，不崩不产记录
    expect(scanSubagentEntries(pair(JSON.stringify({
      action: 'list',
      listResponse: { running: 'many', items: 'not-an-array' },
    })))).toEqual([])

    // items 元素级畸形（'garbage-item' 字符串 / 无 subagentId 的坏 item）：过滤后合法
    // sub-a 照常投影（bgResponse 配对成立 → 记录产出，listItem 状态/sessionFile 生效）
    const records = scanSubagentEntries(pair(JSON.stringify({
      action: 'start',
      subagentId: 'sub-x',
      sessionFile: null,
      bgResponse: { status: 'running' },
      listResponse: {
        running: 1,
        items: [
          { subagentId: 'sub-a', status: 'running', sessionFile: '/sub-a.jsonl', totalTokens: 100, duration: 5 },
          'garbage-item',
          { status: 'closed' }, // 无 subagentId：合并时被 subagentId 空串键跳过（listItems 只收非空 id）
        ],
      },
    })))
    expect(records).toHaveLength(1)
    expect(records[0].subagentId).toBe('sub-x')
    // sub-x 自身无 listItem（sub-a 是别人的）→ 状态回落 bgResponse.status='running' 归一
    expect(records[0].status).toBe('running')
    expect(records[0].sessionFile).toBeNull()
  })
})

describe('legacy record 构造守卫（buildLegacySubagentRecord：sessionFile 三级回退链）', () => {
  it('sessionFile 回退链：listItem.sessionFile 优先于 toolResult.sessionFile', () => {
    const records = scanSubagentEntries(pair(JSON.stringify({
      action: 'start',
      subagentId: 'sub-x',
      sessionFile: '/from-toolResult.jsonl',
      bgResponse: { status: 'running' },
      listResponse: { running: 1, items: [{ subagentId: 'sub-x', status: 'running', sessionFile: '/from-listItem.jsonl' }] },
    })))
    expect(records[0].sessionFile).toBe('/from-listItem.jsonl')
  })

  it('两级都缺（null）且无 mainCwd → 保持 null（不猜路径）', () => {
    const records = scanSubagentEntries(pair(JSON.stringify({
      action: 'start',
      subagentId: 'sub-y',
      sessionFile: null,
      bgResponse: { status: 'running' },
    })))
    expect(records[0].sessionFile).toBeNull()
  })

  it('同 subagentId 的重复配对去重（首个配对胜出，不产重复记录）', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: [startBlock, toolCallBlock({ action: 'start', startParam: { agent: 'w', task: 't2' } }, 'tc-2')] } },
      toolResultEntry('tc-1', JSON.stringify({ action: 'start', subagentId: 'sub-dup', sessionFile: null, bgResponse: { status: 'running' } })),
      toolResultEntry('tc-2', JSON.stringify({ action: 'start', subagentId: 'sub-dup', sessionFile: null, bgResponse: { status: 'running' } })),
    ]
    const records = scanSubagentEntries(entries)
    expect(records).toHaveLength(1)
    expect(find(records, 'sub-dup')).toBeDefined()
  })
})
