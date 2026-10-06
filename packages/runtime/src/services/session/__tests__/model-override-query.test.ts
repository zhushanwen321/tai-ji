/**
 * model-override-query 单测（subagent-model-switch U2 一致性修复轮：详情载荷覆盖
 * 状态查询的生产后端）。
 *
 * 覆盖：
 * - chat 域（getRecordOverride）：record 事件文件 record-model-override 帧 → wire 状态；
 *   多条覆盖帧尾向最新胜出（后写整替不变量 2）；无覆盖帧 / 文件不存在 / session 不在
 *   扫描结果 → undefined（不造键）；头行与半写残行宽容跳过；
 * - run 域（getRunOverride）：run journal model-override 帧 → wire 状态；无覆盖 /
 *   journal 不存在 → undefined；
 * - thinkingLevel 透传（显式档位在场携带）。
 *
 * 测试框架：vitest（从子包目录运行；mkdtemp 自建自删，禁触真实数据目录红线）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/model-override-query.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISessionStore } from '../../ports/session.js'
import { createModelOverrideQuery } from '../model-override-query.js'
import {
  getSubagentRecordsDir,
  recordEventsPath,
  RECORD_EVENTS_SUFFIX,
  RUN_EVENTS_SUFFIX,
} from '@zhushanwen/subagent-core'

let tmpDir: string
let agentDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'model-override-query-'))
  agentDir = join(tmpDir, 'agent')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 最小 deps：scanSessions 指到测试注入的目录布局。 */
function makeQuery(scanResult: Array<{ id: string; cwd?: string; filePath?: string }>) {
  const sessionStore = {
    scanSessions: vi.fn(() => scanResult),
  } as unknown as ISessionStore
  return createModelOverrideQuery({ sessionStore, agentDir })
}

/** 事件文件首行头行（与 core toRecordEventHeader 落盘形态同构；该符号未出 barrel，此处字面同形）。 */
function recordEventsHeaderLine(recordId: string): string {
  return JSON.stringify({ type: 'record-events', id: recordId })
}

/** record 事件文件写入口（头行 + 事件行，与 core createRecordEventStream 落盘形态同构）。 */
function writeRecordEventsFile(recordsDir: string, recordId: string, events: Array<Record<string, unknown>>): string {
  mkdirSync(recordsDir, { recursive: true })
  const filePath = recordEventsPath(recordsDir, recordId)
  const lines = [recordEventsHeaderLine(recordId), ...events.map((e) => JSON.stringify(e))]
  writeFileSync(filePath, lines.join('\n') + '\n')
  return filePath
}

function overrideEvent(seq: number, provider: string, modelId: string, thinkingLevel?: string): Record<string, unknown> {
  return {
    type: 'record-model-override',
    seq,
    ts: 1000 + seq,
    ref: { provider, modelId },
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    setAt: 1000 + seq,
  }
}

/** run journal 写入口（行 = run 事件帧；parser 逐行独立，无头行形态）。 */
function writeRunJournal(workflowStateDir: string, runId: string, lines: Array<Record<string, unknown>>): string {
  mkdirSync(workflowStateDir, { recursive: true })
  const filePath = join(workflowStateDir, `${runId}${RUN_EVENTS_SUFFIX}`)
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return filePath
}

describe('getRecordOverride — chat 域记录覆盖查询', () => {
  it('覆盖帧在场 → wire 状态（canonical ref 串 + thinkingLevel 透传）', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir(agentDir, cwd)
    writeRecordEventsFile(recordsDir, 'sa-1', [
      { type: 'record-created', seq: 1, ts: 1, id: 'sa-1', agent: 'w', task: 't', slug: 'w', origin: 'tool', rootSessionId: 'main-1', depth: 0, mode: 'background', startedAt: 1 },
      overrideEvent(2, 'p-new', 'm-new', 'high'),
    ])
    const query = makeQuery([{ id: 'main-1', cwd }])
    expect(query.getRecordOverride('main-1', 'sa-1')).toEqual({ model: 'p-new/m-new', thinkingLevel: 'high' })
  })

  it('多条覆盖帧 → 尾向最新胜出（后写整替，不变量 2）', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir(agentDir, cwd)
    writeRecordEventsFile(recordsDir, 'sa-1', [
      overrideEvent(1, 'p-a', 'm-a'),
      overrideEvent(2, 'p-b', 'm-b'),
      overrideEvent(3, 'p-c', 'm-c'),
    ])
    const query = makeQuery([{ id: 'main-1', cwd }])
    expect(query.getRecordOverride('main-1', 'sa-1')).toEqual({ model: 'p-c/m-c' })
  })

  it('无覆盖帧（事件文件只有 created）→ undefined（不造键）', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir(agentDir, cwd)
    writeRecordEventsFile(recordsDir, 'sa-1', [
      { type: 'record-created', seq: 1, ts: 1, id: 'sa-1', agent: 'w', task: 't', slug: 'w', origin: 'tool', rootSessionId: 'main-1', depth: 0, mode: 'background', startedAt: 1 },
    ])
    const query = makeQuery([{ id: 'main-1', cwd }])
    expect(query.getRecordOverride('main-1', 'sa-1')).toBeUndefined()
  })

  it('事件文件不存在（覆盖从未下达）→ undefined', () => {
    const query = makeQuery([{ id: 'main-1', cwd: '/w/never' }])
    expect(query.getRecordOverride('main-1', 'sa-404')).toBeUndefined()
  })

  it('session 不在扫描结果 → undefined（定位锚缺席）', () => {
    const query = makeQuery([])
    expect(query.getRecordOverride('ghost', 'sa-1')).toBeUndefined()
  })

  it('尾部半写残行（无换行结尾）按坏行跳过，命中更早的合法覆盖帧', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir(agentDir, cwd)
    const filePath = recordEventsPath(recordsDir, 'sa-1')
    mkdirSync(recordsDir, { recursive: true })
    const lines = [
      recordEventsHeaderLine('sa-1'),
      JSON.stringify(overrideEvent(1, 'p-ok', 'm-ok')),
      '{"type":"record-model-override","seq":2,"ts":10', // 半写行（无尾随换行）
    ]
    writeFileSync(filePath, lines.join('\n'))
    const query = makeQuery([{ id: 'main-1', cwd }])
    expect(query.getRecordOverride('main-1', 'sa-1')).toEqual({ model: 'p-ok/m-ok' })
  })
})

describe('getRunOverride — run 域 journal 覆盖查询', () => {
  it('journal 覆盖帧在场 → wire 状态（session 文件目录 workflow-state 布局）', () => {
    const sessionFilePath = join(tmpDir, 'sessions', 'main-1.jsonl')
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true })
    writeFileSync(sessionFilePath, '')
    const workflowStateDir = join(tmpDir, 'sessions', 'workflow-state')
    writeRunJournal(workflowStateDir, 'run-1', [
      { type: 'model-override', seq: 2, ts: 10, model: { provider: 'p-run', modelId: 'm-run' }, thinkingLevel: 'low' },
    ])
    const query = makeQuery([{ id: 'main-1', filePath: sessionFilePath }])
    expect(query.getRunOverride('main-1', 'run-1')).toEqual({ model: 'p-run/m-run', thinkingLevel: 'low' })
  })

  it('无覆盖帧 / journal 不存在 → undefined', () => {
    const sessionFilePath = join(tmpDir, 'sessions', 'main-1.jsonl')
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true })
    writeFileSync(sessionFilePath, '')
    const query = makeQuery([{ id: 'main-1', filePath: sessionFilePath }])
    expect(query.getRunOverride('main-1', 'run-404')).toBeUndefined()
  })

  it('record 事件文件后缀与 run journal 后缀互不混用（RECORD_EVENTS_SUFFIX ≠ RUN_EVENTS_SUFFIX）', () => {
    expect(RECORD_EVENTS_SUFFIX).toBe('.events')
    expect(RUN_EVENTS_SUFFIX).toBe('.record.jsonl')
  })
})
