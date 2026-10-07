// test/workflow-run-events-reader.test.ts
//
// WorkflowRunEventsReader.readRunEvents 读侧投影（workflow-visualization U3）的
// 单元级断言——record 文件逐行解析 → core 事件 → shared 条目的逐型投影契约：
//   1. 全词表闭集投影：11 种 core 事件类型逐型落条目，载荷字段透传形态逐字段
//      断言（agent-retrying / phase-settled / run-interrupted / run-settled /
//      model-override 五型此前无任何测试到达——本测试是它们的首个回归锚）；
//   2. 坏行宽容：非 JSON 行与空行跳过不计事件（对齐活体 tailer 的 skipped 语义）；
//   3. 大字段截断契约（D12 边界）：run-created 的 args/scriptSource 按
//      WORKFLOW_RUN_EVENT_TRUNCATE_BYTES 字节上限截断 + truncatedFields 标注，
//      多字节字符不切坏（截断值经 WS JSON 传输，非法 UTF-8 会在序列化时变 U+FFFD）。
//
// 路径白名单：recordPath 必须严格位于 getPiAgentDir() 之下——测试经
// TAIJI_AGENT_DATA_DIR 指向 mkdtemp 临时数据目录满足（fixture 自建自删，不触碰
// 真实数据目录）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorkflowRunEventsReader } from '../src/services/session/workflow-run-events-reader.js'
import { getPiAgentDir } from '../src/infra/pi/pi-paths.js'
import { WORKFLOW_RUN_EVENT_TRUNCATE_BYTES } from '@taiji/shared'
import type { WorkflowRunEventsReply } from '@taiji/shared'

let tmpDataDir: string
let savedEnv: string | undefined
let recordPath: string

const SID = 'sess-reader'
const RUN_ID = 'wf-run-1'

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'wf-run-events-reader-'))
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir
  mkdirSync(getPiAgentDir(), { recursive: true })
  recordPath = join(getPiAgentDir(), 'wf-run-1.record.jsonl')
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 全词表事件 fixture（seq 严格递增 1..11，ts 递增 epoch ms）。 */
const FULL_STREAM_LINES = [
  {
    type: 'run-created',
    seq: 1,
    ts: 1000,
    runId: RUN_ID,
    workflowName: 'demo-wf',
    argsSummary: '{"k":"v"}',
    args: { k: 'v' },
    model: 'prov/m1',
    scriptSource: 'const wf = phase("p1")',
    scriptPath: '/scripts',
    budgetTimeMs: 100,
    budgetTokens: 200,
  },
  { type: 'phase-started', seq: 2, ts: 1001, phase: 'p1' },
  {
    type: 'agent-started',
    seq: 3,
    ts: 1002,
    taskIndex: 0,
    agentName: 'a1',
    attempt: 1,
    phase: 'p1',
    memberRecordId: 'rec-1',
    input: 'do it',
  },
  { type: 'agent-retrying', seq: 4, ts: 1003, taskIndex: 0, attempt: 1, backoffMs: 500, reason: 'stale_context' },
  {
    type: 'agent-settled',
    seq: 5,
    ts: 1004,
    taskIndex: 0,
    attempt: 1,
    outcome: 'failed',
    errorCode: 'unknown',
    durationMs: 42,
    stderrTeePath: '/tmp/tee.log',
    result: { ok: false },
  },
  { type: 'phase-settled', seq: 6, ts: 1005, phase: 'p1' },
  { type: 'run-interrupted', seq: 7, ts: 1006, errorCode: 'crashed', reason: 'host restart' },
  {
    type: 'run-resumed',
    seq: 8,
    ts: 1007,
    reason: 'manual resume',
    host: 'hostA',
    budgetTimeMs: 3000,
    budgetTokens: 9000,
    model: 'prov/m2',
  },
  {
    type: 'model-override',
    seq: 9,
    ts: 1008,
    model: { provider: 'p1', modelId: 'm9' },
    thinkingLevel: 'high',
  },
  { type: 'worker-log', seq: 10, ts: 1009, entry: { level: 'warn', message: 'boom' } },
  {
    type: 'run-settled',
    seq: 11,
    ts: 1010,
    outcome: 'failed',
    errorCode: 'budget_limited',
    reason: 'budget exhausted',
    artifactsDir: '/tmp/artifacts',
  },
] as const

describe('WorkflowRunEventsReader.readRunEvents 读侧投影', () => {
  it('全词表闭集：11 种事件逐型投影，载荷字段透传 + 信封 ts/seq 保留；坏行与空行跳过不计', () => {
    const body = FULL_STREAM_LINES.map((e) => JSON.stringify(e)).join('\n')
    writeFileSync(recordPath, `${body}\nnot-json\n\n`, 'utf-8')

    const reader = new WorkflowRunEventsReader()
    const reply = reader.readRunEvents(SID, RUN_ID, recordPath) as WorkflowRunEventsReply

    expect(reply.sessionId).toBe(SID)
    expect(reply.runId).toBe(RUN_ID)
    if (!('events' in reply)) throw new Error(`expected events reply, got ${JSON.stringify(reply)}`)
    // 坏行（非 JSON）与空行宽容跳过：11 帧全词表恰 11 条。
    expect(reply.events).toHaveLength(FULL_STREAM_LINES.length)

    const byType = (t: string) => reply.events.find((e) => e.type === t)

    // 以下五型此前无测试到达（投影函数体零覆盖）——逐字段钉住载荷透传形态。
    const retrying = byType('agent-retrying')
    expect(retrying).toMatchObject({ taskIndex: 0, attempt: 1, backoffMs: 500, reason: 'stale_context' })

    const phaseSettled = byType('phase-settled')
    expect(phaseSettled).toMatchObject({ phase: 'p1' })

    const interrupted = byType('run-interrupted')
    expect(interrupted).toMatchObject({ errorCode: 'crashed', reason: 'host restart' })

    const settled = byType('run-settled')
    expect(settled).toMatchObject({
      outcome: 'failed',
      errorCode: 'budget_limited',
      reason: 'budget exhausted',
      artifactsDir: '/tmp/artifacts',
    })

    const override = byType('model-override')
    expect(override).toMatchObject({ model: { provider: 'p1', modelId: 'm9' }, thinkingLevel: 'high' })

    // 信封透传（ts/seq）与其余已覆盖型的关键载荷抽检。
    const created = byType('run-created')
    expect(created).toMatchObject({ ts: 1000, seq: 1, runId: RUN_ID, workflowName: 'demo-wf' })
    expect(created && 'args' in created && typeof created.args === 'string' ? JSON.parse(created.args) : null).toEqual({ k: 'v' })
    expect(byType('phase-started')).toMatchObject({ ts: 1001, seq: 2, phase: 'p1' })
    expect(byType('agent-started')).toMatchObject({
      taskIndex: 0,
      agentName: 'a1',
      attempt: 1,
      phase: 'p1',
      memberRecordId: 'rec-1',
      input: 'do it',
    })
    expect(byType('agent-settled')).toMatchObject({
      taskIndex: 0,
      attempt: 1,
      outcome: 'failed',
      errorCode: 'unknown',
      durationMs: 42,
      stderrTeePath: '/tmp/tee.log',
    })
    expect(byType('run-resumed')).toMatchObject({
      reason: 'manual resume',
      host: 'hostA',
      budgetTimeMs: 3000,
      budgetTokens: 9000,
      model: 'prov/m2',
    })
    expect(byType('worker-log')).toMatchObject({ entry: { level: 'warn', message: 'boom' } })

    // 小载荷无截断 → truncatedFields 键不造。
    for (const entry of reply.events) {
      expect(entry.truncatedFields).toBeUndefined()
    }
  })

  it('大字段截断：args/scriptSource 按 WORKFLOW_RUN_EVENT_TRUNCATE_BYTES 字节上限截断并标注，多字节字符不切坏', () => {
    const bigSource = 'a'.repeat(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES * 2)
    const cjkArgs = { k: '汉'.repeat(1000) } // 序列化后 ≈3KB > 2KB 上限，且全多字节
    const created = {
      type: 'run-created',
      seq: 1,
      ts: 1000,
      runId: RUN_ID,
      workflowName: 'big-wf',
      argsSummary: 's',
      args: cjkArgs,
      scriptSource: bigSource,
    }
    writeFileSync(recordPath, `${JSON.stringify(created)}\n`, 'utf-8')

    const reader = new WorkflowRunEventsReader()
    const reply = reader.readRunEvents(SID, RUN_ID, recordPath) as WorkflowRunEventsReply
    if (!('events' in reply)) throw new Error(`expected events reply, got ${JSON.stringify(reply)}`)
    const entry = reply.events[0]
    if (entry.type !== 'run-created') throw new Error('expected run-created entry')

    // 截断白名单标注：args 先于 scriptSource（projectRunCreated 截断序）。
    expect(entry.truncatedFields).toEqual(['args', 'scriptSource'])
    // scriptSource 为 ASCII：截断值 = 精确字节上限。
    expect(entry.scriptSource?.length).toBe(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES)
    // args 多字节：截断值不超上限且不产非法 UTF-8（序列化不变 U+FFFD）。
    expect(entry.args).toBeDefined()
    const argsBytes = Buffer.byteLength(entry.args ?? '', 'utf8')
    expect(argsBytes).toBeLessThanOrEqual(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES)
    expect(entry.args?.includes('\uFFFD')).toBe(false)
  })
})
