/**
 * P5 接线测试：SessionService.getSubagentHistory 的 record 路由段——engine 字段路由
 * 到分协议读取链（非 pi → readEngineSubagentHistory 三级降级；pi → 现有 JSONL 直读链）。
 *
 * [W1 / D6] record 注入点随读侧换源更新：getSubagents 读 journal 投影（会话文件
 * 流式扫描 → 投影派生），不再调 extractSubagentsFromSessionFile——fixture 从
 * mock 列表函数改为真实 v1 subagent-record entry 落盘（engine/engineHandle 字段
 * 经投影真实透传），路由/降级链（extractRecordEngine / readEngineSubagentHistory /
 * DEFAULT_SUBAGENT_ENGINE）全程真实现。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ScannedSessionMeta } from '../src/infra/pi/session-file-utils.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import { SessionService } from '../src/services/session/session-service.js'
import { convertPiHistory } from '../src/infra/pi/message-converter.js'

function createMockSessionStore(mainSessionFile: string, mainSessionId: string): ISessionStore {
  const meta: ScannedSessionMeta = {
    id: mainSessionId,
    filePath: mainSessionFile,
    cwd: '/proj',
    timestamp: new Date().toISOString(),
    name: null,
    lastModified: Date.now(),
    size: 0,
    outcome: null,
  }
  return {
    scanSessions: () => [meta],
    // u4c（D5⑤）：ISessionStore 新增流式归一化成员（本文件不触达，no-op 满足类型）
    normalizeSessionFileStreaming: () => {},
    invalidateScanCache: () => {},
    refreshAll: () => {},
    persistSessionEnd: () => {},
    persistPresetBinding: () => {},
    persistProjectBinding: () => {},
    persistAgentBinding: () => {},
    extractSessionOutcome: () => null,
    invalidateMetaCache: () => {},
    convertHistory: (raw: unknown[]) => convertPiHistory(raw),
    rebuildHistoryFromEntries: () => ({ messages: [], clientUuidMap: new Map(), orphanToolResults: [] }),
    parseSessionHeader: () => null,
    readSessionHeaderLine: () => null,
    readSessionJsonlText: () => null,
    readSessionEndMeta: () => null,
    persistHandoffSidecar: () => {},
    // G4/u-h4：port trash 签名改 Promise<void>（失败保留文件并 reject），本测试不触删除路径
    trash: () => Promise.resolve(),
  }
}

function createSvc(tempDir: string): SessionService {
  return new SessionService(
    { onSessionExit: () => {}, getClient: () => undefined, hasClient: () => false } as never,
    {} as never, // broker
    {} as never, // adapterFactory
    '/tmp',
    {} as never, // extensionService
    {} as never, // configStore
    createMockSessionStore(join(tempDir, 'main.jsonl'), 'main-sess-id'),
    {} as never, // gitInfoReader
    {} as never, // workspaceService
  )
}

/**
 * 带引擎字段的 v1 subagent-record entry（U1 后 engine/engineHandle 已进 shared
 * SubagentRecord 正式契约；投影层 projectEngineSpreadFields 真实透传）。
 */
function subagentRecordEntry(data: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'subagent-record',
    id: 'e-1',
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 1,
      id: 'bg-route-1',
      agent: 'reviewer',
      task: 'routed task',
      slug: 'rev',
      status: 'idle',
      startedAt: 1756000000000,
      endedAt: 1756000005000,
      result: 'routed outcome',
      ...data,
    },
  })
}

describe('SessionService.getSubagentHistory engine routing (P5)', () => {
  let tempDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sa-route-'))
    // session-service 的 getDataDir() 读 TAIJI_AGENT_DATA_DIR——隔离到 tempDir，
    // journal 前缀白名单按该 dataDir 推导
    prevDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tempDir
    writeFileSync(
      join(tempDir, 'main.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'main-sess-id', cwd: '/proj' })}\n`,
    )
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    if (prevDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = prevDataDir
  })

  it('routes zcode record to the engine chain (tier3 outcome-only)', async () => {
    writeFileSync(
      join(tempDir, 'main.jsonl'),
      `${subagentRecordEntry({ engine: 'zcode', engineHandle: { poolKey: 'reviewer', sessionRef: {} } })}\n`,
      { flag: 'a' },
    )

    const { messages } = await createSvc(tempDir).getSubagentHistory('main-sess-id', 'bg-route-1')

    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toBe('routed task')
    expect(messages[1]?.content).toBe('routed outcome')
  })

  it('routes zcode record to journal tier when journal exists inside engines root', async () => {
    const poolDir = join(tempDir, 'engines', 'zcode', 'reviewer')
    mkdirSync(poolDir, { recursive: true })
    const journalPath = join(poolDir, 'journal-bg-route-1.jsonl')
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ v: 1, ts: 1, taskId: 'bg-route-1', engineId: 'zcode', seq: 0, event: { type: 'text_delta', delta: 'journal answer' } }),
        JSON.stringify({ v: 1, ts: 2, taskId: 'bg-route-1', engineId: 'zcode', seq: 1, event: { type: 'turn_end' } }),
      ].join('\n') + '\n',
      'utf-8',
    )
    writeFileSync(
      join(tempDir, 'main.jsonl'),
      `${subagentRecordEntry({
        engine: 'zcode',
        engineHandle: { poolKey: 'reviewer', sessionRef: { dbPath: '.zcode/cli/db/db.sqlite', sessionId: 's1' }, journalPath },
      })}\n`,
      { flag: 'a' },
    )

    const { messages } = await createSvc(tempDir).getSubagentHistory('main-sess-id', 'bg-route-1')

    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.content).toBe('journal answer')
  })

  it('keeps pi records on the existing JSONL chain (sessionFile missing → [])', async () => {
    // pi record（无 engine 字段）：路由段落回现有链——sessionFile 为 null 时现有行为 = []
    writeFileSync(join(tempDir, 'main.jsonl'), `${subagentRecordEntry({})}\n`, { flag: 'a' })

    const svc = createSvc(tempDir)
    // 现有链路读取了主 session 文件（投影冷启动流式扫描定位 record）——路由前置
    // 数据面真实经过了会话文件读取（record 命中即文件已读，路由确实落在 pi 分支）
    const subagents = await svc.getSubagents('main-sess-id')
    expect(subagents.records.map((r) => r.subagentId)).toEqual(['bg-route-1'])
    expect(subagents.records[0]?.engine).toBeUndefined()

    const { messages } = await svc.getSubagentHistory('main-sess-id', 'bg-route-1')
    expect(messages).toEqual([])
  })
})
