/**
 * SessionService.getAgentCallHistory 测试。
 *
 * agent call 本质是 subagent（D4）：workflow trace[].sessionId 是 subagent record id（sa-xxx），
 * getAgentCallHistory 复用 getSubagentHistory 的 record 查找路径（subagentId → 主 session JSONL
 * 的 record.sessionFile），不再用 findAgentCallFile（按 header.id 扫目录，sa-xxx 不匹配 uuidv7）。
 *
 * 测试点：验证 getAgentCallHistory 委托 getSubagentHistory（同参透传 + 返回其结果，含空数组）。
 * getSubagentHistory 的 record 查找/路径校验逻辑由其自身测试覆盖，此处只验委托关系。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message, SubagentRecord } from '@xyz-agent/shared'

vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return { ...actual, scanPiSessions: () => [], parseSessionHeader: vi.fn() }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/tmp/pi-agent' }
})
vi.mock('../src/services/session-history.js', () => ({
  getHistoryFromFile: vi.fn().mockResolvedValue([]),
  getHistoryFromFilePath: vi.fn().mockResolvedValue([]),
}))
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: vi.fn(),
    getDefaultModel: () => ({ provider: 'test', modelId: 'test' }),
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})
vi.mock('../src/infra/system/trash.js', () => ({ trash: vi.fn() }))
vi.mock('../src/infra/pi/message-converter.js', () => ({ convertPiHistory: vi.fn((r) => r) }))

import { SessionService } from '../src/services/session/session-service.js'
import type { SessionRecords } from '../src/services/session/session-records.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

function createService(): SessionService {
  const pm = {
    getClient: vi.fn(() => null),
    list: vi.fn(() => []),
    createSession: vi.fn(),
    destroySession: vi.fn(),
    hasClient: vi.fn(() => false),
    onSessionExit: vi.fn(),
    destroyAll: vi.fn(),
  } as never
  const broker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as never
  const adapterFactory = vi.fn(() => ({ attach: vi.fn(), detach: vi.fn() })) as never
  const extensionService = { getExtensionPaths: vi.fn().mockResolvedValue([]) } as never
  const gitInfoReader = { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() } as never
  const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) } as never
  return new SessionService(
    pm,
    broker,
    adapterFactory,
    '/tmp',
    extensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    gitInfoReader,
    workspaceService,
  )
}

describe('SessionService.getAgentCallHistory', () => {
  it('委托 getSubagentHistory：同参透传 + 返回其结果（agent call 是 subagent，sa-xxx 经 record 查找）', async () => {
    const service = createService()
    const fakeMessages: Message[] = [
      { id: 'm1', role: 'user', content: 'hello', status: 'complete', timestamp: 1689222883000 },
    ]
    // S6 迁移：getSubagentHistory 实现落位 session-records，观察点随迁到 records 实例
    //（Facade.getAgentCallHistory 一行委托 → records.getAgentCallHistory → records.getSubagentHistory）
    const { records } = service as unknown as { records: SessionRecords }
    const spy = vi.spyOn(records, 'getSubagentHistory').mockResolvedValue({ messages: fakeMessages, truncated: false })

    const result = await service.getAgentCallHistory('main-sess-001', 'sa-agentcall-001')

    expect(spy).toHaveBeenCalledWith('main-sess-001', 'sa-agentcall-001')
    expect(result).toEqual({ messages: fakeMessages, truncated: false })
  })

  it('getSubagentHistory 返回空数组时透传（找不到 record 不 throw，前端显空对话流非错误态）', async () => {
    const service = createService()
    const { records } = service as unknown as { records: SessionRecords }
    vi.spyOn(records, 'getSubagentHistory').mockResolvedValue({ messages: [], truncated: false })

    const result = await service.getAgentCallHistory('main-sess', 'sa-missing')

    expect(result).toEqual({ messages: [], truncated: false })
  })
})

// ── getAgentCallFilePath（自 session-service-agent-call-path.test.ts 并入）──────────
// agent call 经 record.sessionFile 定位（subagentId → record）。返回路径字符串，
// 找不到 record / 无 sessionFile / 路径穿越 → 空串（展示型功能，不 throw）。

/** S6 迁移：getSubagents 实现落位 session-records，观察点随迁到 records 实例。 */
function recordsRef(service: SessionService): SessionRecords {
  return (service as unknown as { records: SessionRecords }).records
}

describe('SessionService.getAgentCallFilePath', () => {
  beforeEach(() => vi.clearAllMocks())

  it('record 有 sessionFile（在 piAgentDir 下）→ 返回路径', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue([
      { subagentId: 'sa-001', sessionFile: '/tmp/pi-agent/subagents/enc/sa-001.jsonl' } as SubagentRecord,
    ])
    const result = await service.getAgentCallFilePath('main-sess', 'sa-001')
    expect(result).toBe('/tmp/pi-agent/subagents/enc/sa-001.jsonl')
  })

  it('找不到 record → 空串', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue([])
    expect(await service.getAgentCallFilePath('main-sess', 'sa-missing')).toBe('')
  })

  it('record 无 sessionFile（null）→ 空串', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue([
      { subagentId: 'sa-001', sessionFile: null } as SubagentRecord,
    ])
    expect(await service.getAgentCallFilePath('main-sess', 'sa-001')).toBe('')
  })

  it('sessionFile 路径穿越（不在 piAgentDir 下）→ 空串（isStrictlyUnder 安全校验）', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue([
      { subagentId: 'sa-001', sessionFile: '/etc/passwd' } as SubagentRecord,
    ])
    expect(await service.getAgentCallFilePath('main-sess', 'sa-001')).toBe('')
  })
})
