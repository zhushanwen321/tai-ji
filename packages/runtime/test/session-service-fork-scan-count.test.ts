/**
 * W26（微项 12 / plan M-3）：同 handler 多次 scanSessions().find() 合并。
 *
 * fork handler 原链路两次全量扫描（facade 的 resolveEntryIdByTimestamp 与
 * lifecycle.forkSession 各自 scanSessions().find()）→ 合并为 facade 单次解析
 * （findScannedSession，force 旁路 TTL）后经 source 参数贯穿传递。
 *
 * 验收：forkSession 全链路 scanSessions 调用计数 = 1（CountingStore 计数）。
 *
 * Mock 基建复用 session-service.test.ts 同款（不 spawn 真 pi；fork 产物写入
 * mock getSessionsDir 指向的 tmp 目录，不碰真实数据目录）。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-service-fork-scan-count.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mocks = vi.hoisted(() => ({
  mockScannedSessions: [] as Array<{
    id: string
    filePath: string
    cwd: string
    name: string | null
    lastModified: number
    timestamp: string
    size: number
    outcome: 'done' | 'error' | 'stopped' | null
    launchPresetId?: string
    projectId?: string
  }>,
  defaultModel: {
    value: { provider: 'test-provider', modelId: 'test-model' } as
      { provider: string; modelId: string } | null,
  },
  refreshAllMock: vi.fn(),
  trashMock: vi.fn(),
  convertPiHistoryMock: vi.fn((raw: unknown) => raw),
}))

vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return {
    ...actual,
    scanPiSessions: () => mocks.mockScannedSessions,
  }
})
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: mocks.refreshAllMock,
    getDefaultModel: () => mocks.defaultModel.value,
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})
// getSessionsDir 指向测试临时目录（fork 产物真实写入 tmp，不碰真实数据目录）
const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/tmp/placeholder'), getPiAgentDir: vi.fn(() => '/mock/taiji/agent') }))
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: pathsMock.getSessionsDir,
    getPiAgentDir: pathsMock.getPiAgentDir,
  }
})
vi.mock('../src/infra/system/trash.js', () => ({ trash: mocks.trashMock }))
vi.mock('../src/infra/pi/message-converter.js', () => ({ convertPiHistory: mocks.convertPiHistoryMock }))
vi.mock('../src/infra/pi/entry-tree-builder.js', () => ({
  rebuildHistoryFromEntries: (entries: unknown[]) => ({ messages: entries as unknown[], clientUuidMap: new Map<string, string>() }),
}))
vi.mock('../src/services/session-history.js', () => ({
  getHistoryFromFile: vi.fn().mockResolvedValue([]),
  getHistoryFromFilePath: vi.fn().mockResolvedValue([]),
  getHistoryTailFromFile: vi.fn().mockResolvedValue({ messages: [], truncated: false }),
}))

import { SessionService } from '../src/services/session/session-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'
import type { ScanSessionsOptions, ScannedSessionMeta } from '../src/services/ports/session.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import type { IProcessManager } from '../src/services/ports/pi-engine.js'

/** 计数 store：统计 scanSessions 调用次数（find 合并验收探针）。 */
class CountingStore extends PiSessionStore {
  scanCount = 0
  override scanSessions(opts?: ScanSessionsOptions): ScannedSessionMeta[] {
    this.scanCount++
    return super.scanSessions(opts)
  }
}

describe('fork handler 单次 scanSessions（W26 微项 12 find 合并）', () => {
  let sessionsDir: string
  let sourceFile: string
  let service: SessionService
  let countingStore: CountingStore

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'fork-scan-'))
    pathsMock.getSessionsDir.mockReturnValue(sessionsDir)

    // 源 session 文件（真实 pi 格式 JSONL，含 fork 锚点 entry m2）
    sourceFile = join(sessionsDir, 'src-session.jsonl')
    const content = [
      JSON.stringify({ type: 'session', version: 3, id: 'src-1', timestamp: '2025-01-01T00:00:00Z', cwd: '/proj' }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2025-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2025-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } }),
    ].join('\n') + '\n'
    writeFileSync(sourceFile, content, 'utf-8')

    mocks.mockScannedSessions.length = 0
    mocks.mockScannedSessions.push({
      id: 'src-1',
      filePath: sourceFile,
      cwd: '/proj',
      name: 'source',
      lastModified: Date.now(),
      timestamp: '2025-01-01T00:00:00Z',
      size: content.length,
      outcome: null,
    })
    mocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }

    // ── SessionService 构造（基建同 session-service.test.ts createSetup 精简版）──
    const pm = {
      createSession: vi.fn(async (_id: string, _cwd: string) => ({
        getState: vi.fn(async () => ({ sessionId: `pi-fork-1`, sessionFile: `/fake/pi-fork-1.jsonl` })),
        switchSession: vi.fn(async () => {}),
        prompt: vi.fn(async () => ({})),
      })),
      destroySession: vi.fn(async () => {}),
      getClient: vi.fn(() => undefined),
      getSessionIdByClient: vi.fn(() => undefined),
      hasClient: vi.fn(() => false),
      rekey: vi.fn(),
      onSessionExit: vi.fn(),
      destroyAll: vi.fn(async () => {}),
    } as unknown as IProcessManager
    const broker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
    const adapterFactory = (_sid: string, _interceptor: unknown) => ({
      attach: vi.fn(),
      detach: vi.fn(),
    })
    const extensionService = { getExtensionPaths: vi.fn().mockResolvedValue([]) }
    const gitInfoReader: IGitInfoReader = { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() }
    const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) }
    const messageBus = { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), unsubscribeAll: vi.fn(), clearSession: vi.fn() }

    countingStore = new CountingStore()
    service = new SessionService(
      pm,
      broker as never,
      adapterFactory as never,
      '/tmp',
      extensionService as never,
      new PiConfigStore(),
      countingStore,
      gitInfoReader,
      workspaceService as never,
      messageBus as never,
    )
    service.setMessageBus(messageBus as never)
  })

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('fork 全链路 scanSessions 计数 = 1（facade 单次解析贯穿 lifecycle）', async () => {
    const result = await service.forkSession('src-1', 'm2', false, 'forked')
    expect(countingStore.scanCount).toBe(1)
    expect(result.id).toBeDefined()
  })

  it('行为等价：fork 产物文件写出且 parentSession 指回源文件', async () => {
    const result = await service.forkSession('src-1', 'm2', true, 'forked')
    expect(countingStore.scanCount).toBe(1)

    // 新文件在源 header cwd（/proj）的 encodeCwd 子目录（方案 B 布局，buildForkTarget
    // 与 import-service 写入形态对齐；pi 命名 <ISO_timestamp>_<uuid>.jsonl）
    const { readdirSync, existsSync, readFileSync } = await import('node:fs')
    const encodedDir = join(sessionsDir, '--proj--')
    const forkedFiles = readdirSync(encodedDir).filter((f) => f.endsWith('.jsonl'))
    expect(forkedFiles).toHaveLength(1)
    const forkedFilePath = join(encodedDir, forkedFiles[0])
    expect(existsSync(forkedFilePath)).toBe(true)
    const lines = readFileSync(forkedFilePath, 'utf-8').trim().split('\n')
    const header = JSON.parse(lines[0])
    expect(header.id).toBe(result.id)
    // FR-20：源 session 不在内存 active Map（历史 session fork 常态）→ fallbackParentId 用
    // 源 sessionId 作血缘键（parentSession 指回可追溯的源，而非可能失效的文件路径）
    expect(header.parentSession).toBe('src-1')
    // includeFrom=true：保留 m2（header + m1 + m2）
    expect(lines).toHaveLength(3)
  })

  it('源 session 不存在时抛错且不扫描（force 路径守卫）', async () => {
    await expect(service.forkSession('no-such', 'm2', false, 'x')).rejects.toThrow('source session not found')
    expect(countingStore.scanCount).toBe(1)
  })

  it('fromPiEntryId 缺失走 resolveEntryIdByTimestamp（同 source 复用，不二次扫描）', async () => {
    const result = await service.forkSession('src-1', undefined, false, 'forked', {
      fromMessageTimestamp: Date.parse('2025-01-01T00:00:02Z'),
      fromMessageRole: 'user',
    })
    expect(countingStore.scanCount).toBe(1)
    expect(result.id).toBeDefined()
  })
})
