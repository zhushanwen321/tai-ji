/**
 * model-override-query 单测（subagent-model-switch U2 一致性修复轮：详情载荷覆盖
 * 状态查询的生产后端）。
 *
 * 覆盖：
 * - chat 域（getRecordOverride）：record 事件文件 record-model-override 帧 → wire 状态；
 *   多条覆盖帧尾向最新胜出（后写整替不变量 2）；无覆盖帧 / 文件不存在 / session 不在
 *   扫描结果 → undefined（不造键）；头行与半写残行宽容跳过；
 * - run 域（getRunOverride）：run journal model-override 帧 → wire 状态；无覆盖 /
 *   journal 不存在 → undefined（ENOENT = 合法缺省，静默不 warn）；journal stat
 *   失败（EACCES 非 ENOENT）→ warn 留痕后 undefined；非法 runId（穿越形态）→
 *   warn 留痕（run id rejected）后 undefined；
 * - thinkingLevel 透传（显式档位在场携带）。
 *
 * 测试框架：vitest（从子包目录运行；mkdtemp 自建自删，禁触真实数据目录红线）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/model-override-query.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelOverrideQuery } from '../model-override-query.js'
import {
  getSubagentRecordsDir,
  recordEventsPath,
  RECORD_EVENTS_SUFFIX,
  RUN_EVENTS_SUFFIX,
} from '@zhushanwen/subagent-core'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'model-override-query-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 最小 deps：数据根指到测试注入的目录（两域目录都由分区键 sessionId 派生，
 *  [session-store-layout-inversion D2/D3] 无需 sessionStore 定位锚）。 */
function makeQuery(_scanResult: Array<{ id: string; cwd?: string; filePath?: string }> = []) {
  void _scanResult
  return createModelOverrideQuery({ dataDir: tmpDir })
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
function writeRunJournal(runsDir: string, runId: string, lines: Array<Record<string, unknown>>): string {
  mkdirSync(runsDir, { recursive: true })
  const filePath = join(runsDir, `${runId}${RUN_EVENTS_SUFFIX}`)
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return filePath
}

/** run journal 目录（`<root>/<sid>/workflow/runs/`，root = 测试注入的数据根）。 */
function runRunsDir(dataDir: string, sessionId: string): string {
  return join(dataDir, 'ext-sessions', sessionId, 'workflow', 'runs')
}

describe('getRecordOverride — chat 域记录覆盖查询', () => {
  it('覆盖帧在场 → wire 状态（canonical ref 串 + thinkingLevel 透传）', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir('main-1', tmpDir)
    writeRecordEventsFile(recordsDir, 'sa-1', [
      { type: 'record-created', seq: 1, ts: 1, id: 'sa-1', agent: 'w', task: 't', slug: 'w', origin: 'tool', rootSessionId: 'main-1', depth: 0, mode: 'background', startedAt: 1 },
      overrideEvent(2, 'p-new', 'm-new', 'high'),
    ])
    const query = makeQuery([{ id: 'main-1', cwd }])
    expect(query.getRecordOverride('main-1', 'sa-1')).toEqual({ model: 'p-new/m-new', thinkingLevel: 'high' })
  })

  it('多条覆盖帧 → 尾向最新胜出（后写整替，不变量 2）', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir('main-1', tmpDir)
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
    const recordsDir = getSubagentRecordsDir('main-1', tmpDir)
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
    const recordsDir = getSubagentRecordsDir('main-1', tmpDir)
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
  it('journal 覆盖帧在场 → wire 状态（session 存储树 runs 目录布局）', () => {
    const runsDir = runRunsDir(tmpDir, 'main-1')
    writeRunJournal(runsDir, 'run-1', [
      { type: 'model-override', seq: 2, ts: 10, model: { provider: 'p-run', modelId: 'm-run' }, thinkingLevel: 'low' },
    ])
    const query = makeQuery()
    expect(query.getRunOverride('main-1', 'run-1')).toEqual({ model: 'p-run/m-run', thinkingLevel: 'low' })
  })

  it('无覆盖帧 / journal 不存在 → undefined（ENOENT = 合法缺省，静默不 warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const query = makeQuery()
      expect(query.getRunOverride('main-1', 'run-404')).toBeUndefined()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('journal stat 失败（EACCES 非 ENOENT）→ warn 留痕后 undefined（不静默同判无覆盖）', () => {
    const runsDir = runRunsDir(tmpDir, 'main-1')
    mkdirSync(runsDir, { recursive: true })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      chmodSync(runsDir, 0o000) // 父目录无搜索权限 → statSync(journal) EACCES
      const query = makeQuery()
      expect(query.getRunOverride('main-1', 'run-1')).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('stat failed')
    } finally {
      // 权限恢复先于自删（chmod 000 目录 rm 枚举会 EACCES，session-scan-degraded-tolerance 同款）
      chmodSync(runsDir, 0o755)
      warnSpy.mockRestore()
    }
  })

  it('非法 runId（路径穿越形态）→ warn 留痕（run id rejected）后 undefined', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const query = makeQuery()
      expect(query.getRunOverride('main-1', '../evil')).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('run id rejected')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('覆盖帧早于 256KB 尾读窗口起点（尾部被 worker-log 堆积淹没）→ undefined（miss = 按无覆盖显示、不虚报、无报错）', () => {
    const runsDir = runRunsDir(tmpDir, 'main-1')
    mkdirSync(runsDir, { recursive: true })
    const journalPath = join(runsDir, `run-1${RUN_EVENTS_SUFFIX}`)
    // 覆盖帧在文件头 + worker-log 堆积 >256KB 在后：尾读窗口（OVERRIDE_TAIL_WINDOW_KB）
    // 起点落在堆积段内、覆盖帧出窗 → 窗口内无命中（代码注释登记的 miss 语义）。
    const head = `${JSON.stringify({ type: 'model-override', seq: 2, ts: 10, model: { provider: 'p-run', modelId: 'm-run' } })}\n`
    const fillerLines: string[] = []
    let fillerBytes = 0
    let seq = 3
    while (fillerBytes <= 256 * 1024) {
      const line = JSON.stringify({ type: 'worker-log', seq, ts: 11, entry: { level: 'warn', message: 'x'.repeat(200) } })
      fillerLines.push(line)
      fillerBytes += line.length + 1
      seq += 1
    }
    writeFileSync(journalPath, head + fillerLines.join('\n') + '\n')
    const query = makeQuery()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(query.getRunOverride('main-1', 'run-1')).toBeUndefined()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('record 事件文件后缀与 run journal 后缀互不混用（RECORD_EVENTS_SUFFIX ≠ RUN_EVENTS_SUFFIX）', () => {
    expect(RECORD_EVENTS_SUFFIX).toBe('.events')
    expect(RUN_EVENTS_SUFFIX).toBe('.record.jsonl')
  })
})

describe('两域目录派生（[session-store-layout-inversion D2/D3] 分区键 = sessionId）', () => {
  it('run journal 落 session 存储树 runs 目录（不经会话文件路径反推）', () => {
    writeRunJournal(runRunsDir(tmpDir, 'main-2'), 'run-9', [
      { type: 'model-override', seq: 1, ts: 5, model: { provider: 'p-run', modelId: 'm-run' } },
    ])
    const query = makeQuery()
    expect(query.getRunOverride('main-2', 'run-9')).toEqual({ model: 'p-run/m-run' })
  })

  it('窄口第三参（resolved 定位锚）对 run 域不再影响落点（布局反转后无定位必需项）', () => {
    writeRunJournal(runRunsDir(tmpDir, 'main-3'), 'run-1', [
      { type: 'model-override', seq: 1, ts: 5, model: { provider: 'p-run', modelId: 'm-run' } },
    ])
    const query = makeQuery()
    // 传入空锚 / 传入会话文件路径锚：结果一致（目录由 sid 派生，与锚无关）
    expect(query.getRunOverride('main-3', 'run-1', {})).toEqual({ model: 'p-run/m-run' })
    expect(query.getRunOverride('main-3', 'run-1', { filePath: join(tmpDir, 'elsewhere.jsonl') })).toEqual({
      model: 'p-run/m-run',
    })
    // 非归属 sid 的锚不得把请求路由到别处的 journal
    expect(query.getRunOverride('main-other', 'run-1', { filePath: join(tmpDir, 'elsewhere.jsonl') })).toBeUndefined()
  })
})
