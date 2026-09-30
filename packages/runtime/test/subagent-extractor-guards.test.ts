/**
 * subagent-extractor 畸形输入 / 投影守卫定向测试（CRAP 靶子：collectV2SubagentPair /
 * projectV2SubagentRecord / parseLegacyToolCallBlock / projectSubagentStartArgs /
 * projectLegacyToolResultData / buildLegacySubagentRecord）。
 *
 * [登记 §3.3] v1 全量快照投影（projectSelfDescribedSubagentRecord）与 v1 entry 扫描已随
 * 兼容层整体删除（项目未上线、无 v1 数据）——自描述投影用例改用现行 v2「注册 + 终态」
 * 条目对播种，断言收敛到幸存投影面：身份域透传（origin 字面量守卫 / parentRunId /
 * stepIndex）、缺省可选字段 → undefined / null（不发明默认值）、elapsedSeconds 派生、
 * engine/engineHandle 透传、同 id 后到覆盖。
 *
 * 已有 subagent-extractor.test.ts 覆盖正常路径（条目对投影 / bg-notify 终态 /
 * sessionFile 回退扫描）；本文件专测形状守卫族——输入源是 LLM 生成的 toolCall
 * arguments / toolResult 文本 JSON.parse 产物 / extension 写入的 entry data（全部
 * 不可信），畸形值不得以谎报类型直达 SubagentRecord（下游 readFileSync 对非 string
 * sessionFile 会 throw）。
 *
 * 运行：cd packages/runtime && npx vitest run test/subagent-extractor-guards.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { scanSubagentEntries } from '../src/services/session/subagent-extractor.js'
import { SUBAGENT_RECORD_CUSTOM_TYPE } from '@zhushanwen/subagent-core'
import type { SubagentRecord } from '@taiji/shared'

/** v2 注册条目 entry 构造（type:'custom' 是 pi JSONL 持久化层形态；身份域基线）。 */
function registeredEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: SUBAGENT_RECORD_CUSTOM_TYPE,
    id: 'e-registered',
    parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id: 'sub-1',
      agent: 'worker',
      task: 'do',
      slug: 'w1',
      origin: 'tool',
      rootSessionId: 's1',
      depth: 0,
      startedAt: 1000,
      ...overrides,
    },
  }
}

/** v2 终态条目 entry 构造（终局域基线，畸形字段逐个覆写）。 */
function settledEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: SUBAGENT_RECORD_CUSTOM_TYPE,
    id: 'e-settled',
    parentId: null,
    timestamp: '2026-09-26T00:00:01Z',
    data: {
      v: 2,
      kind: 'settled',
      id: 'sub-1',
      status: 'idle',
      stopReason: 'completed',
      endedAt: 61000,
      turns: 3,
      totalTokens: 100,
      model: 'p/m',
      thinkingLevel: 'low',
      ...overrides,
    },
  }
}

/** v1 专有字段在 v2 投影上无载体：键不出现（不是「键在场值为 undefined」）。 */
function expectAbsentKey(record: SubagentRecord, key: string): void {
  expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false)
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

describe('v2 subagent-record 条目投影守卫（collectV2SubagentPair / projectV2SubagentRecord）', () => {
  it('注册条目 id 非字符串 → 该条目跳过，同批其余合法注册条目照常产出（在飞态）', () => {
    const records = scanSubagentEntries([
      registeredEntry({ id: 123 }), // id 畸形：number
      registeredEntry({ id: 'sub-ok' }),
    ])
    expect(records.map((r) => r.subagentId)).toEqual(['sub-ok'])
    // 无终态条目 → 两态判据落 running
    expect(records[0].status).toBe('running')
  })

  it('缺注册条目的终态条目不成实体（身份无所出）→ 无自描述命中（同批无 legacy 配对时空数组）', () => {
    expect(scanSubagentEntries([settledEntry({ id: 'sub-orphan' })])).toEqual([])
  })

  it('缺省可选字段 → undefined / null（不发明默认值），身份字段恒取注册条目原值', () => {
    const records = scanSubagentEntries([registeredEntry({ origin: 'bogus' })]) // 无终态条目
    const r = records[0]
    expect(r.status).toBe('running')
    expect(r.sessionFile).toBeNull() // 无终态条目 → null（不猜路径）
    expect(r.stopReason).toBeUndefined()
    expect(r.turns).toBeUndefined()
    expect(r.totalTokens).toBeUndefined()
    expect(r.model).toBeUndefined()
    expect(r.thinkingLevel).toBeUndefined()
    expect(r.endedAt).toBeUndefined()
    expect(r.elapsedSeconds).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect(r.result).toBeUndefined()
    expect(r.parentRunId).toBeUndefined()
    expect(r.stepIndex).toBeUndefined()
    // origin 字面量守卫：非法值 → undefined（= tool 语义，不发明出处）
    expect(r.origin).toBeUndefined()
    // v1 投影的 agent/slug/task 兜底（general-purpose / 空串）已随兼容层删除：
    // v2 身份域原样透传注册条目值
    expect(r.agent).toBe('worker')
    expect(r.slug).toBe('w1')
    expect(r.task).toBe('do')
    expect(r.startedAt).toBe(1000)
  })

  it('v1 专有字段无 v2 载体：closedReason/eventLog/displayItems/batchFinalized/worktree/round/patchFile/resumable/chatMode 键不出现', () => {
    const v1OnlyFields = {
      closedReason: 'gc',
      eventLog: [{ type: 'record-created' }],
      displayItems: ['x'],
      batchFinalized: true,
      worktree: true,
      round: 2,
      patchFile: '/tmp/x.patch',
      resumable: true,
      chatMode: 'chat',
    }
    const records = scanSubagentEntries([
      registeredEntry(v1OnlyFields),
      settledEntry(v1OnlyFields),
    ])
    expect(records).toHaveLength(1)
    for (const key of Object.keys(v1OnlyFields)) expectAbsentKey(records[0], key)
    // 终态条目在场 → idle；stopReason 原样下行（不派生展示值）
    expect(records[0].status).toBe('idle')
    expect(records[0].stopReason).toBe('completed')
  })

  it('elapsedSeconds 派生：endedAt ≥ startedAt 按差值取整秒；负时长/缺任一端不派生', () => {
    const ok = scanSubagentEntries([
      registeredEntry({ startedAt: 1000 }),
      settledEntry({ endedAt: 61000 }),
    ])
    expect(ok[0].elapsedSeconds).toBe(60) // 60000ms → 60s

    // 负时长是脏数据 → 不派生
    const dirty = scanSubagentEntries([
      registeredEntry({ startedAt: 61000 }),
      settledEntry({ endedAt: 1000 }),
    ])
    expect(dirty[0].elapsedSeconds).toBeUndefined()

    // 无终态条目（无 endedAt）→ 不派生
    const running = scanSubagentEntries([registeredEntry({ startedAt: 1000 })])
    expect(running[0].elapsedSeconds).toBeUndefined()
  })

  // R3-1（H2 阶段 3 一致性审查修复）：origin 透传断言——此前投影白名单漏 origin，
  // renderer 过滤面（badge 计数 / hasRunning / 列表桶）origin 恒 undefined，workflow
  // record 运行期虚亮。守卫语义对齐 core readEntryOriginFields：仅认 'tool'|'workflow'
  // 字面量，非法值/缺省 → undefined（= tool 语义，存量 record 零迁移）。
  it('身份域透传：origin 字面量守卫 + parentRunId/stepIndex 透传（renderer 过滤面 / run 视图数据源契约）', () => {
    const projected = scanSubagentEntries([
      registeredEntry({ id: 'sub-wf', origin: 'workflow', parentRunId: 'run-1', stepIndex: 2 }),
      registeredEntry({ id: 'sub-tool', origin: 'tool' }),
      registeredEntry({ id: 'sub-bogus', origin: 'bogus' }), // 非法字面量
      registeredEntry({ id: 'sub-absent', origin: undefined }), // 缺省（契约外存量）
    ])
    const byId = (id: string): SubagentRecord | undefined => projected.find((r) => r.subagentId === id)
    expect(byId('sub-wf')?.origin).toBe('workflow')
    expect(byId('sub-wf')?.parentRunId).toBe('run-1')
    expect(byId('sub-wf')?.stepIndex).toBe(2)
    expect(byId('sub-tool')?.origin).toBe('tool')
    expect(byId('sub-tool')?.parentRunId).toBeUndefined()
    expect(byId('sub-tool')?.stepIndex).toBeUndefined()
    expect(byId('sub-bogus')?.origin).toBeUndefined()
    expect(byId('sub-absent')?.origin).toBeUndefined()
  })

  it('engine/engineHandle 透传：终态条目携带则原样投影，缺省则键不出现（不填默认值）', () => {
    const engineHandle = {
      sessionRef: { sessionId: 'z-1', dbPath: '/db/z.sqlite' },
      journalPath: '/journal/z.jsonl',
      poolKey: 'shared',
    }
    const withEngine = scanSubagentEntries([
      registeredEntry(),
      settledEntry({ engine: 'zcode', engineHandle }),
    ])
    expect(withEngine[0].engine).toBe('zcode')
    expect(withEngine[0].engineHandle).toEqual(engineHandle)

    const withoutEngine = scanSubagentEntries([registeredEntry(), settledEntry()])
    expectAbsentKey(withoutEngine[0], 'engine')
    expectAbsentKey(withoutEngine[0], 'engineHandle')
  })

  it('版本/形态不认识的 entry 跳过并 warn 留证（v1 已删形态 → future-v；v2 无 kind → unknown-kind）', () => {
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    try {
      const records = scanSubagentEntries([
        { type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, data: { v: 1, id: 'sub-old', status: 'running' } },
        { type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, data: { v: 2, id: 'sub-no-kind' } },
      ])
      expect(records).toEqual([])
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[0][0])).toContain('future-v')
      expect(String(warn.mock.calls[1][0])).toContain('unknown-kind')
    } finally {
      warn.mockRestore()
    }
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
