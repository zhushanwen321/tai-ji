/**
 * workflow 可视化 U3 两 RPC 契约测试（workflow-visualization 设计 §3.1-4 / §3.1-5，
 * SessionRecords 服务级——经真实 session JSONL fixture + run journal fixture 驱动）：
 *
 * - session.getWorkflowRunEvents：大字段 2KB 截断（input/result/scriptSource/args 四
 *   白名单字段）+ truncatedFields 逐行标注 + 骨架字段透传；record_not_found（无注册
 *   条目 / record 文件已清理）；路径白名单拒绝在事件流结构化闭集（单码）下归并
 *   record_not_found；RPC 通道错误（非 ENOENT fs 错误 / scanSessions 失败）上抛；
 *   oversize 降级（record 文件超 READ_PRECHECK_MAX_BYTES——不全文读取，events 恒空
 *   + oversize 标志，RT-4#8「不可用 ≠ 无数据」分形）；存量 run-created 行缺
 *   argsSummary 时读侧回退空串（不透传 undefined 键）。
 * - session.getWorkflowDag：错误码四形态全枚举（parse_failed / no_script_source /
 *   record_not_found / path_rejected）+ runId 内存缓存仅缓存成功结果（失败不缓存故
 *   parse_failed 可重试；成功缓存命中不再读盘）+ 缓存 LRU 上界 5（第 6 个 run 逐出
 *   最旧——被逐出者重拉读盘、最近者仍缓存命中）。
 *
 * 测试写删目标 = mkdtemp tmp 自建自删（红线：vitest guard）；getPiAgentDir 经 vi.mock
 * 指向 tmp（路径白名单判定域 = tmp，path_rejected 用 recordPath 落 tmp 外构造）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/workflow-viz-run-events-rpc.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SessionRecordsDeps } from '../session-records.js'
import { SessionRecords } from '../session-records.js'
import { READ_PRECHECK_MAX_BYTES, WORKFLOW_RUN_EVENT_TRUNCATE_BYTES } from '@taiji/shared'
import type { WorkflowRunEventEntry, WorkflowRunEventsReply, WorkflowDagReply } from '@taiji/shared'

const SID = 's1'
const RUN_ID = 'run-1'

/** getPiAgentDir 重定向目标（hoisted：vi.mock 工厂内引用；白名单判定域 = tmp）。 */
const piAgentDirRef = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => piAgentDirRef.dir }
})

let dir: string
let sessionFilePath: string
let recordPath: string

/** workflow-record v2 注册条目行（session JSONL fixture 单行；recordPath 可注入越界形态，runId 可多 run 并存）。 */
function registeredEntryLine(recordPathValue: string, runId: string = RUN_ID): string {
  return `${JSON.stringify({
    type: 'custom',
    customType: 'workflow-record',
    id: `e-${runId}`,
    parentId: null,
    timestamp: '2026-10-02T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      runId,
      workflowName: 'flow',
      scriptName: 'flow',
      slug: 'flow',
      startedAt: 1000,
      recordPath: recordPathValue,
    },
  })}\n`
}

/** 超过 2KB 截断阈值的文本。 */
function overThresholdText(pad = 'x'): string {
  return pad.repeat(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES + 512)
}

const DAG_SCRIPT = [
  'phase("review")',
  'parallel([',
  '  () => agent("reviewer-security", { prompt: "sec" }),',
  '  () => agent("reviewer-perf", { prompt: "perf" }),',
  '])',
].join('\n')

/** 单调用点脚本（1 节点）——LRU 淘汰测试里换脚本观察「重拉读盘 vs 缓存命中」。 */
const SOLO_SCRIPT = 'agent("solo-agent", { prompt: "x" })'

/** 写 run journal fixture（覆盖式；行 = core 事件 JSONL）。 */
function writeJournal(frames: Array<Record<string, unknown>>): void {
  writeFileSync(recordPath, frames.map((f) => JSON.stringify(f)).join('\n') + '\n')
}

function makeRecords(sessionStoreOverride?: ISessionStore['scanSessions']): SessionRecords {
  const deps: SessionRecordsDeps = {
    pm: { getClient: vi.fn(() => ({})) } as unknown as IProcessManager,
    sessionStore: {
      scanSessions: sessionStoreOverride ?? vi.fn(() => [{ id: SID, filePath: sessionFilePath }]),
    } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => null,
  }
  return new SessionRecords(deps)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wf-viz-rpc-'))
  sessionFilePath = join(dir, 's1.jsonl')
  recordPath = join(dir, 'workflow-state', `${RUN_ID}.record.jsonl`)
  mkdirAndWriteJournal()
  piAgentDirRef.dir = dir
})

function mkdirAndWriteJournal(): void {
  writeFileSync(sessionFilePath, registeredEntryLine(recordPath), 'utf8')
  mkdirSync(join(dir, 'workflow-state'), { recursive: true })
  writeJournal([
    { type: 'run-created', seq: 1, ts: 1000, runId: RUN_ID, workflowName: 'flow', argsSummary: 'task=demo' },
  ])
}

afterEach(() => {
  piAgentDirRef.dir = ''
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('session.getWorkflowRunEvents（§3.1-4 事件流拉取）', () => {
  it('成功形态：骨架字段透传 + 大字段 2KB 截断 + truncatedFields 逐行标注', async () => {
    writeJournal([
      {
        type: 'run-created', seq: 1, ts: 1000, runId: RUN_ID, workflowName: 'flow',
        argsSummary: 'task=demo',
        args: { prompt: overThresholdText('a') },
        scriptSource: overThresholdText('s'),
        scriptPath: '/tmp/scripts',
      },
      { type: 'phase-started', seq: 2, ts: 1050, phase: 'review' },
      {
        type: 'agent-started', seq: 3, ts: 1100, taskIndex: 0, agentName: 'reviewer-security',
        attempt: 1, phase: 'review', input: overThresholdText('i'),
      },
      {
        type: 'agent-settled', seq: 4, ts: 1300, taskIndex: 0, attempt: 1, outcome: 'done',
        durationMs: 200, result: { text: overThresholdText('r') },
      },
      { type: 'worker-log', seq: 5, ts: 1310, entry: { level: 'log', message: 'hi' } },
    ])
    const records = makeRecords()
    const reply: WorkflowRunEventsReply = await records.getWorkflowRunEvents(SID, RUN_ID)
    expect(reply).toHaveProperty('events')
    expect(reply.sessionId).toBe(SID) // C-comm-05：两臂恒带 sessionId
    if (!('events' in reply)) throw new Error('expected success arm')
    const created = reply.events.find((e): e is Extract<WorkflowRunEventEntry, { type: 'run-created' }> => e.type === 'run-created')
    const phaseStarted = reply.events.find((e): e is Extract<WorkflowRunEventEntry, { type: 'phase-started' }> => e.type === 'phase-started')
    const started = reply.events.find((e): e is Extract<WorkflowRunEventEntry, { type: 'agent-started' }> => e.type === 'agent-started')
    const settled = reply.events.find((e): e is Extract<WorkflowRunEventEntry, { type: 'agent-settled' }> => e.type === 'agent-settled')
    const workerLog = reply.events.find((e): e is Extract<WorkflowRunEventEntry, { type: 'worker-log' }> => e.type === 'worker-log')

    // 大字段截断：四白名单字段全命中 + 值为字节上限内前缀（多字节安全截断后 ≤2048 字节）
    expect(created!.truncatedFields).toEqual(['args', 'scriptSource'])
    expect(Buffer.byteLength(created!.args ?? '', 'utf8')).toBeLessThanOrEqual(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES)
    expect(Buffer.byteLength(created!.scriptSource ?? '', 'utf8')).toBeLessThanOrEqual(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES)
    expect(created!.argsSummary).toBe('task=demo') // 摘要恒不截断
    expect(created!.scriptPath).toBe('/tmp/scripts')
    expect(started!.truncatedFields).toEqual(['input'])
    expect(settled!.truncatedFields).toEqual(['result'])
    expect(Buffer.byteLength(settled!.result ?? '', 'utf8')).toBeLessThanOrEqual(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES)

    // 骨架字段透传（Gantt 对账口径 = ts/type/taskIndex/attempt/phase/durationMs/outcome）
    expect(phaseStarted).toEqual({ type: 'phase-started', ts: 1050, seq: 2, phase: 'review' })
    expect(started).toMatchObject({ type: 'agent-started', ts: 1100, seq: 3, taskIndex: 0, attempt: 1, phase: 'review', agentName: 'reviewer-security' })
    expect(settled).toMatchObject({ type: 'agent-settled', ts: 1300, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 200 })
    // 未截断行不造 truncatedFields 键（缺省 = 无截断）
    expect(workerLog).not.toHaveProperty('truncatedFields')
    expect(phaseStarted).not.toHaveProperty('truncatedFields')
  })

  it('存量 run-created 行缺 argsSummary：读侧回退空串（不透传 undefined 键，防 renderer 渲染字面 undefined）', async () => {
    writeJournal([
      { type: 'run-created', seq: 1, ts: 1000, runId: RUN_ID, workflowName: 'flow' },
    ])
    const records = makeRecords()
    const reply: WorkflowRunEventsReply = await records.getWorkflowRunEvents(SID, RUN_ID)
    if (!('events' in reply)) throw new Error('expected success arm')
    const created = reply.events.find(
      (e): e is Extract<WorkflowRunEventEntry, { type: 'run-created' }> => e.type === 'run-created',
    )
    expect(created).toBeDefined()
    expect(created!.argsSummary).toBe('') // ?? '' 回退：键恒在、值为空串
  })

  it('record_not_found：无注册条目（run 非本会话实体）与 record 文件已清理（ENOENT）', async () => {
    const noRegistration = makeRecords()
    const reply1 = await noRegistration.getWorkflowRunEvents(SID, 'run-unknown')
    expect(reply1).toEqual({ sessionId: SID, runId: 'run-unknown', code: 'record_not_found', message: expect.any(String) })

    rmSync(recordPath)
    const reply2 = await noRegistration.getWorkflowRunEvents(SID, RUN_ID)
    expect(reply2).toEqual({ sessionId: SID, runId: RUN_ID, code: 'record_not_found', message: expect.any(String) })
  })

  it('路径白名单拒绝归并 record_not_found（事件流结构化闭集单码；日志留痕）', async () => {
    // recordPath 落白名单域（tmp agentDir）外 = 防御形态
    writeFileSync(sessionFilePath, registeredEntryLine(join(tmpdir(), 'outside-agent-dir', 'x.record.jsonl')), 'utf8')
    const records = makeRecords()
    const reply = await records.getWorkflowRunEvents(SID, RUN_ID)
    expect(reply).toEqual({ sessionId: SID, runId: RUN_ID, code: 'record_not_found', message: expect.any(String) })
  })

  it('RPC 通道错误：非 ENOENT fs 错误上抛（renderer 走 error envelope 重试按钮）', async () => {
    rmSync(recordPath)
    mkdirSync(join(dir, 'workflow-state', `${RUN_ID}.record.jsonl`), { recursive: true }) // EISDIR：读文件抛非 ENOENT
    const records = makeRecords()
    await expect(records.getWorkflowRunEvents(SID, RUN_ID)).rejects.toThrow()
  })

  it('RPC 通道错误：scanSessions 失败上抛（不吞）', async () => {
    const records = makeRecords(vi.fn(() => { throw new Error('disk unavailable') }))
    await expect(records.getWorkflowRunEvents(SID, RUN_ID)).rejects.toThrow('disk unavailable')
  })

  it('oversize：record 文件超 READ_PRECHECK_MAX_BYTES 不全文读取——events 恒空 + oversize 标志（RT-4#8 分形）', async () => {
    // 稀疏文件撑过阈值（ftruncate 不写真实数据，磁盘占用近零）
    const fd = openSync(recordPath, 'r+')
    ftruncateSync(fd, READ_PRECHECK_MAX_BYTES + 1)
    closeSync(fd)
    const records = makeRecords()
    const reply: WorkflowRunEventsReply = await records.getWorkflowRunEvents(SID, RUN_ID)
    expect(reply).toEqual({ sessionId: SID, runId: RUN_ID, events: [], oversize: true })
  })
})

describe('session.getWorkflowDag（§3.1-5 DAG 透出通道）', () => {
  it('成功形态：core 解析器产出 DAG JSON；runId 内存缓存命中后不再读盘', async () => {
    writeJournal([
      { type: 'run-created', seq: 1, ts: 1000, runId: RUN_ID, workflowName: 'flow', argsSummary: '', scriptSource: DAG_SCRIPT },
    ])
    const records = makeRecords()
    const reply1: WorkflowDagReply = await records.getWorkflowDag(SID, RUN_ID)
    expect(reply1).toHaveProperty('dag')
    expect(reply1.sessionId).toBe(SID) // C-comm-05：两臂恒带 sessionId
    if (!('dag' in reply1)) throw new Error('expected success arm')
    expect(reply1.dag.nodes).toHaveLength(2) // 探针核实：fixture 脚本 → 2 个 agent 调用点节点
    expect(reply1.dag.phases).toEqual([{ name: 'review', order: 0 }])

    // 缓存命中证据：改写 record（换脚本）后仍返回首次结果——成功缓存不再读盘
    writeJournal([
      { type: 'run-created', seq: 1, ts: 1000, runId: RUN_ID, workflowName: 'flow', argsSummary: '', scriptSource: 'phase("other")' },
    ])
    const reply2 = await records.getWorkflowDag(SID, RUN_ID)
    expect(reply2).toEqual(reply1)
  })

  it('parse_failed：不支持语法 fail-fast 结构化错误；失败不缓存，修复后重试成功', async () => {
    writeJournal([
      { type: 'run-created', seq: 1, ts: 1000, runId: RUN_ID, workflowName: 'flow', argsSummary: '', scriptSource: 'const = (' },
    ])
    const records = makeRecords()
    const reply1 = await records.getWorkflowDag(SID, RUN_ID)
    expect(reply1).toEqual({ sessionId: SID, runId: RUN_ID, code: 'parse_failed', message: expect.any(String) })

    // 失败不缓存（设计 §3.1-5「重试可再解析」）：修复 record 后重试成功
    writeJournal([
      { type: 'run-created', seq: 1, ts: 1000, runId: RUN_ID, workflowName: 'flow', argsSummary: '', scriptSource: DAG_SCRIPT },
    ])
    const reply2 = await records.getWorkflowDag(SID, RUN_ID)
    expect(reply2).toHaveProperty('dag')
  })

  it('dagCache LRU 上界 5：第 6 个 run 逐出最旧——被逐出者改盘重拉生效，最近者改盘仍命中旧缓存', async () => {
    const RUNS = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5', 'run-6']
    const recordOf = (rid: string): string => join(dir, 'workflow-state', `${rid}.record.jsonl`)
    const writeSoloJournal = (rid: string): void => {
      writeFileSync(recordOf(rid), `${JSON.stringify({
        type: 'run-created', seq: 1, ts: 1000, runId: rid, workflowName: 'flow', argsSummary: '', scriptSource: SOLO_SCRIPT,
      })}\n`)
    }
    // 6 个注册条目 + 各自 record（首帧 DAG_SCRIPT = 2 节点）
    writeFileSync(sessionFilePath, RUNS.map((rid) => registeredEntryLine(recordOf(rid), rid)).join(''), 'utf8')
    for (const rid of RUNS) {
      writeFileSync(recordOf(rid), `${JSON.stringify({
        type: 'run-created', seq: 1, ts: 1000, runId: rid, workflowName: 'flow', argsSummary: '', scriptSource: DAG_SCRIPT,
      })}\n`)
    }
    const records = makeRecords()
    for (const rid of RUNS) {
      const reply = await records.getWorkflowDag(SID, rid)
      expect(reply).toHaveProperty('dag')
    }
    // run-6（最近使用）仍缓存命中：改盘换脚本后重拉返回旧缓存（2 节点，不读盘）
    writeSoloJournal('run-6')
    const hitReply = await records.getWorkflowDag(SID, 'run-6')
    if (!('dag' in hitReply)) throw new Error('expected success arm')
    expect(hitReply.dag.nodes).toHaveLength(2)
    // run-1（最旧、已被 run-6 挤出上界）重拉重新读盘解析：新脚本 1 节点生效
    writeSoloJournal('run-1')
    const evictedReply = await records.getWorkflowDag(SID, 'run-1')
    if (!('dag' in evictedReply)) throw new Error('expected success arm')
    expect(evictedReply.dag.nodes).toHaveLength(1)
  })

  it('no_script_source：run-created 帧缺 scriptSource（旧格式行）', async () => {
    const records = makeRecords()
    const reply = await records.getWorkflowDag(SID, RUN_ID)
    expect(reply).toEqual({ sessionId: SID, runId: RUN_ID, code: 'no_script_source', message: expect.any(String) })
  })

  it('record_not_found：record 文件不存在', async () => {
    rmSync(recordPath)
    const records = makeRecords()
    const reply = await records.getWorkflowDag(SID, RUN_ID)
    expect(reply).toEqual({ sessionId: SID, runId: RUN_ID, code: 'record_not_found', message: expect.any(String) })
  })

  it('path_rejected：recordPath 落白名单域外（防御性返回）', async () => {
    writeFileSync(sessionFilePath, registeredEntryLine(join(tmpdir(), 'outside-agent-dir', 'x.record.jsonl')), 'utf8')
    const records = makeRecords()
    const reply = await records.getWorkflowDag(SID, RUN_ID)
    expect(reply).toEqual({ sessionId: SID, runId: RUN_ID, code: 'path_rejected', message: expect.any(String) })
  })
})
