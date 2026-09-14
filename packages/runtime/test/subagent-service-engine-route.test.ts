/**
 * P5 接线测试：SessionService.getSubagentHistory 的 record 路由段——engine 字段路由
 * 到分协议读取链（非 pi → readEngineSubagentHistory 三级降级；pi → 现有 JSONL 直读链）。
 *
 * 为什么 mock extractSubagentsFromSessionFile：record 的 engine/engineHandle 字段由
 * 并行任务在 shared SubagentRecord / extractor 投影写入（落地前端到端链路无写方），
 * 此处 mock 列表函数注入带 engine 的 record，只验证 session-service 的路由接线；
 * 降级链本体由 subagent-extractor-engine.test.ts 用真实现覆盖。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SubagentRecord } from '@xyz-agent/shared'
import type { ScannedSessionMeta } from '../src/infra/pi/session-file-utils.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import { SessionService } from '../src/services/session/session-service.js'
import { convertPiHistory } from '../src/infra/pi/message-converter.js'

vi.mock('../src/services/session/subagent-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session/subagent-extractor.js')>()
  return {
    ...actual,
    // 只 mock 列表派生（record 注入点）；路由/降级链（extractRecordEngine /
    // readEngineSubagentHistory / DEFAULT_SUBAGENT_ENGINE）用真实现
    extractSubagentsFromSessionFile: vi.fn(),
  }
})

// vi.mock 提升后此处 import 拿到的是 mock 版（extractSubagentsFromSessionFile 可配置）
import { extractSubagentsFromSessionFile } from '../src/services/session/subagent-extractor.js'

const mockExtract = vi.mocked(extractSubagentsFromSessionFile)

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

/** 带引擎字段的 record（U1 后 engine/engineHandle 已进 shared SubagentRecord 正式契约）。 */
function zcodeRecord(engineHandle: unknown): SubagentRecord {
  return {
    subagentId: 'bg-route-1',
    sessionFile: null,
    agent: 'reviewer',
    slug: 'rev',
    task: 'routed task',
    status: 'closed',
    startedAt: 1756000000000,
    endedAt: 1756000005000,
    result: 'routed outcome',
    engine: 'zcode',
    engineHandle: engineHandle as SubagentRecord['engineHandle'],
  }
}

describe('SessionService.getSubagentHistory engine routing (P5)', () => {
  let tempDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sa-route-'))
    // session-service 的 getDataDir() 读 XYZ_AGENT_DATA_DIR——隔离到 tempDir，
    // journal 前缀白名单按该 dataDir 推导
    prevDataDir = process.env.XYZ_AGENT_DATA_DIR
    process.env.XYZ_AGENT_DATA_DIR = tempDir
    writeFileSync(join(tempDir, 'main.jsonl'), `${JSON.stringify({ type: 'session', id: 'main-sess-id', cwd: '/proj' })}\n`)
    mockExtract.mockReset()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    if (prevDataDir === undefined) delete process.env.XYZ_AGENT_DATA_DIR
    else process.env.XYZ_AGENT_DATA_DIR = prevDataDir
    vi.restoreAllMocks()
  })

  it('routes zcode record to the engine chain (tier3 outcome-only)', async () => {
    // [G3] extractor 返回形状改为 {records, oversize}——mock 适配（oversize=false 走正常提取链）
    mockExtract.mockReturnValue({ records: [zcodeRecord({ poolKey: 'reviewer', sessionRef: {} })], oversize: false })

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
    mockExtract.mockReturnValue({
      records: [
        zcodeRecord({ poolKey: 'reviewer', sessionRef: { dbPath: '.zcode/cli/db/db.sqlite', sessionId: 's1' }, journalPath }),
      ],
      oversize: false,
    })

    const { messages } = await createSvc(tempDir).getSubagentHistory('main-sess-id', 'bg-route-1')

    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.content).toBe('journal answer')
  })

  it('keeps pi records on the existing JSONL chain (sessionFile missing → [])', async () => {
    // pi record（无 engine 字段）：路由段落回现有链——sessionFile 为 null 时现有行为 = []
    const record = zcodeRecord(undefined)
    delete record.engine
    delete record.engineHandle
    mockExtract.mockReturnValue({ records: [record], oversize: false })

    const { messages } = await createSvc(tempDir).getSubagentHistory('main-sess-id', 'bg-route-1')
    expect(messages).toEqual([])
    // 现有链路读取了主 session 文件（scanSessions 定位）——路由确实落在 pi 分支
    expect(mockExtract).toHaveBeenCalled()
  })
})
