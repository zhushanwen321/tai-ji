import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from '../src/services/session/session-service.js'
import { convertPiHistory } from '../src/infra/pi/message-converter.js'
import { getPiAgentDir } from '../src/infra/pi/pi-paths.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { ScannedSessionMeta } from '../src/infra/pi/session-file-utils.js'

/**
 * W3 测试：SessionService.getSubagents + getSubagentHistory
 *
 * 用真实临时文件验证端到端链路：
 * 1. 构造主 session JSONL（含 subagent toolCall + toolResult）
 * 2. 构造 subagent JSONL（含 user + assistant message）
 * 3. mock sessionStore.scanSessions 返回主 session 元信息
 * 4. 调 getSubagents → 验证 SubagentRecord[]
 * 5. 调 getSubagentHistory → 验证 Message[]
 */

function createMockSessionStore(mainSessionFile: string, mainSessionId: string, mainCwd: string): ISessionStore {
  const meta: ScannedSessionMeta = {
    id: mainSessionId,
    filePath: mainSessionFile,
    cwd: mainCwd,
    timestamp: new Date().toISOString(),
    name: null,
    lastModified: Date.now(),
    size: 0,
    outcome: null,
  }
  return {
    scanSessions: () => [meta],
    // W26（D9-1）：ISessionStore 接口新增目录 TTL 缓存失效成员
    invalidateScanCache: () => {},
    // u4c（D5⑤）：ISessionStore 新增流式归一化成员（本文件不触达，no-op 满足类型）
    normalizeSessionFileStreaming: () => {},
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
    // session-trace（A31/A32）：ISessionStore 接口新增 trace 读取成员（本测试不触达 trace 路径）
    readSessionHeaderLine: () => null,
    readSessionJsonlText: () => null,
    readSessionEndMeta: () => null,
    persistHandoffSidecar: () => {},
    // G4/u-h4：port trash 签名改 Promise<void>（失败保留文件并 reject），本测试不触删除路径
    trash: () => Promise.resolve(),
  }
}

/** Minimal pm mock — SessionService 构造函数需要 onSessionExit */
function createMockPm() {
  return {
    onSessionExit: () => {},
    getClient: () => undefined,
    hasClient: () => false,
  }
}

describe('SessionService.getSubagents', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-svc-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('extracts subagent list from main session JSONL', async () => {
    const mainSessionFile = join(tempDir, 'main.jsonl')
    const subagentFile = join(tempDir, 'sub1.jsonl')
    const toolCallId = 'call_test1'

    // 主 session JSONL（含一个 background subagent）
    const mainEntries = [
      { type: 'session', id: 'main-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'reviewer', slug: 'review-code', task: 'Review code' },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult',
          toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'bg-test-1-111',
                sessionFile: subagentFile,
                bgResponse: {
                  status: 'running',
                  message: 'detached, will notify on completion',
                },
              }),
            },
          ],
        },
      },
    ]
    writeFileSync(mainSessionFile, mainEntries.map((e) => JSON.stringify(e)).join('\n'))

    // subagent JSONL
    const subEntries = [
      { type: 'session', id: 'sub-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:01:00Z' },
      {
        type: 'message',
        id: 'sub-msg-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Review this code' }],
          timestamp: Date.now(),
        },
      },
      {
        type: 'message',
        id: 'sub-msg-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I have reviewed the code.' }],
          timestamp: Date.now(),
        },
      },
    ]
    writeFileSync(subagentFile, subEntries.map((e) => JSON.stringify(e)).join('\n'))

    const sessionStore = createMockSessionStore(mainSessionFile, 'main-sess-id', '/proj')
    const svc = new SessionService(
      createMockPm() as never, // pm
      {} as never, // broker
      {} as never, // adapterFactory
      '/tmp',      // projectRoot
      {} as never, // extensionService
      {} as never, // configStore
      sessionStore,
      {} as never, // gitInfoReader
      {} as never, // workspaceService
    )

    const subagents = await svc.getSubagents('main-sess-id')
    expect(subagents.records).toHaveLength(1)
    expect(subagents.oversize).toBe(false)
    expect(subagents.records[0].subagentId).toBe('bg-test-1-111')
    expect(subagents.records[0].agent).toBe('reviewer')
    expect(subagents.records[0].slug).toBe('review-code')
    expect(subagents.records[0].status).toBe('running')
    expect(subagents.records[0].sessionFile).toBe(subagentFile)
  })

  it('returns empty array for unknown session', async () => {
    const sessionStore = createMockSessionStore('/nonexistent', 'unknown', '/proj')
    const svc = new SessionService(
      createMockPm() as never, {} as never, {} as never, '/tmp', {} as never, {} as never,
      sessionStore, {} as never, {} as never,
    )

    const subagents = await svc.getSubagents('nonexistent-id')
    expect(subagents.records).toHaveLength(0)
  })
})

describe('SessionService.getSubagentHistory', () => {
  let tempDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-hist-'))
    // 隔离数据目录到 tempDir，使 getPiAgentDir() 返回 tempDir/agent —— 测试文件写入真实
    // piAgentDir 下（getSubagentHistory W-R1 路径穿越校验），又不污染真实 ~/.taiji。
    prevDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    if (prevDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = prevDataDir
  })

  it('reads subagent JSONL and converts to Message[]', async () => {
    const mainSessionFile = join(tempDir, 'main.jsonl')
    // subagent JSONL 必须落在 piAgentDir 下（getSubagentHistory W-R1 路径穿越校验）。
    // 真实 subagent 文件由 pi-subagent-workflow 写入 getSubagentSessionDir(mainCwd)，位于 piAgentDir 内。
    const subagentDir = join(getPiAgentDir(), 'subagents', 'mock-subagent-hist')
    mkdirSync(subagentDir, { recursive: true })
    const subagentFile = join(subagentDir, 'subagent.jsonl')
    const toolCallId = 'call_hist1'

    // 主 session JSONL
    const mainEntries = [
      { type: 'session', id: 'main-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'reviewer', slug: 'review-hist', task: 'Review' },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult',
          toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'bg-hist-1-222',
                sessionFile: subagentFile,
                bgResponse: { status: 'running', message: 'detached, will notify on completion' },
              }),
            },
          ],
        },
      },
    ]
    writeFileSync(mainSessionFile, mainEntries.map((e) => JSON.stringify(e)).join('\n'))

    // subagent JSONL（含 user + assistant 消息）
    const subEntries = [
      { type: 'session', id: 'sub-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:01:00Z' },
      {
        type: 'message',
        id: 'sub-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Please review this code file.' }],
          timestamp: Date.now(),
        },
      },
      {
        type: 'message',
        id: 'sub-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The code looks good. No issues found.' }],
          timestamp: Date.now(),
        },
      },
    ]
    writeFileSync(subagentFile, subEntries.map((e) => JSON.stringify(e)).join('\n'))

    const sessionStore = createMockSessionStore(mainSessionFile, 'main-sess-id', '/proj')
    const svc = new SessionService(
      createMockPm() as never, {} as never, {} as never, '/tmp', {} as never, {} as never,
      sessionStore, {} as never, {} as never,
    )

    const { messages } = await svc.getSubagentHistory('main-sess-id', 'bg-hist-1-222')

    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages.some((m) => m.role === 'user')).toBe(true)
    expect(messages.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('returns empty array for unknown subagentId', async () => {
    const mainSessionFile = join(tempDir, 'main.jsonl')
    writeFileSync(mainSessionFile, JSON.stringify({ type: 'session', id: 'main-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' }) + '\n')

    const sessionStore = createMockSessionStore(mainSessionFile, 'main-sess-id', '/proj')
    const svc = new SessionService(
      createMockPm() as never, {} as never, {} as never, '/tmp', {} as never, {} as never,
      sessionStore, {} as never, {} as never,
    )

    const { messages } = await svc.getSubagentHistory('main-sess-id', 'nonexistent-subagent')
    expect(messages).toHaveLength(0)
  })
})
