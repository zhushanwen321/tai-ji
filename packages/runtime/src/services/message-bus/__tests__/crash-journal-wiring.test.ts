/**
 * u1e 条件信号事件接线测试（crash-forensics-and-watchdog §3.3 D1 写入点矩阵）。
 *
 * 覆盖映射（impl-plan u1e 验收条款）：
 * - push 告警档帧 → 台账 frame-truncated(reason=warn-tier)；守卫原有行为不变（原样广播、seq 正常）
 * - push 截断档帧 → 台账 frame-truncated(reason=trunc-tier)；截断仍截断（截断版广播、入 ring）
 * - push 注册表 miss → 台账 registry-miss；仍走原分支（不占 seq 不广播，后续 seq 连续）
 * - push 替换后仍超限 → registry-miss（reason=still_oversize_after_truncate 区分两 miss 形态）
 * - reply 超限（broker）→ frame-truncated(trunc-tier)；错误 envelope 形态不变
 * - reply 告警档 → frame-truncated(warn-tier)；reply 原样送达
 * - 台账未初始化（no-op 单例）时挂点不抛、守卫行为照旧（best-effort 双写不反噬主链）
 *
 * 真实 IO（不 mock fs/writer）：写删目标 mkdtempSync 自建 tmp 目录自删（fs-guard 白名单），
 * 断言经 writer.close() 后读 runtime.jsonl 逐行 JSON.parse——整条「挂点 → getCrashJournal
 * 单例 → writer 落盘」链路被真实覆盖。
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { ServerMessage } from '@taiji/shared'
import { initCrashJournal, closeCrashJournal } from '../../../infra/crash-journal.js'
import { MessageBus } from '../message-bus.js'
import type { OutboundFrameGuardOptions } from '../outbound-frame-registry.js'
import { ServerMessageBroker } from '../../../transport/message-broker.js'
import type { BrokerServices } from '../../../transport/message-broker.js'
import type { BusClient } from '../types.js'

/** 测试小阈值：告警 1KB / 截断 4KB（outbound-frame-guard.test.ts 同款校准法）。 */
const SMALL_OPTS: OutboundFrameGuardOptions = { warnBytes: 1024, truncateBytes: 4096 }

const createdDirs: string[] = []
let dataDir: string

function initDataDir(): string {
  dataDir = mkdtempSync(join(tmpdir(), 'frame-journal-wiring-'))
  createdDirs.push(dataDir)
  return dataDir
}

afterEach(async () => {
  vi.restoreAllMocks()
  // close 清空单例 → 下一用例 initCrashJournal 指向新 tmpdir（??= 幂等语义要求先清）
  await closeCrashJournal()
})

afterAll(() => {
  // maxRetries+retryDelay（crash-journal.test.ts 同款）：teardown 与在途异步写竞争吞瞬态
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 读 runtime.jsonl 全部行并逐行 JSON.parse（不存在返回空数组）。 */
function readJournalRecords(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, 'logs', 'crashes', 'runtime.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

// ── fixture 工厂（outbound-frame-guard.test.ts 同型） ──────────────

function makeMessageEndFrame(content: unknown): ServerMessage {
  return {
    type: 'message.message_end',
    payload: {
      sessionId: 's1',
      entry: {
        type: 'message',
        parentId: null,
        timestamp: '2026-09-09T00:00:00.000Z',
        message: { role: 'toolResult', content },
      },
    },
  } as unknown as ServerMessage
}

function makeClient(): BusClient & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as BusClient & { send: ReturnType<typeof vi.fn> }
}

function makeWsClient(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket
}

function wsSent(ws: WebSocket): unknown[][] {
  return (ws as unknown as { send: ReturnType<typeof vi.fn> }).send.mock.calls
}

function sentMessages(client: ReturnType<typeof makeClient>): ServerMessage[] {
  return client.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
}

/** 最小 BrokerServices（reply 守卫不读 services）。 */
const mockServices = {
  sessionService: { listPersistedSessions: () => [] },
  configService: { listProviders: () => [], getDefaultModel: () => null, loadSkills: () => [], loadAgents: () => [] },
  modelService: { aggregateModels: () => [] },
  pluginService: undefined,
  extensionService: undefined,
  projectRoot: '/mock',
  appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
} as unknown as BrokerServices

// ── push 通路（MessageBus.publish） ────────────────────────────────

describe('MessageBus.publish 条件信号事件接线（u1e）', () => {
  it('告警档帧 → frame-truncated(reason=warn-tier)；消息原样广播 seq 正常（双写不改变守卫行为）', async () => {
    const dir = initDataDir()
    initCrashJournal(dir)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bus = new MessageBus(100, SMALL_OPTS)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    ws.send.mockClear()

    const big = 'y'.repeat(2000) // > warn 1KB、≤ truncate 4KB
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', note: big } })

    // 既有行为不变：告警档不截断，帧原样送达
    const received = sentMessages(ws)
    expect(received).toHaveLength(1)
    expect(received[0]?.seq).toBe(1)
    expect((received[0]?.payload as { note: string }).note).toBe(big)

    await closeCrashJournal()
    const records = readJournalRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ layer: 'runtime', event: 'frame-truncated', reason: 'warn-tier', sessionId: 's1' })
    const detail = JSON.parse(records[0]!.detailDigest as string) as Record<string, unknown>
    expect(detail['frameType']).toBe('message.complete')
    expect(detail['channel']).toBe('push')
    expect(Number(detail['bytes'])).toBeGreaterThan(SMALL_OPTS.warnBytes)
  })

  it('截断档帧 → frame-truncated(reason=trunc-tier)；截断仍截断（截断版广播，digest 含 bytesBefore/After/fieldPaths）', async () => {
    const dir = initDataDir()
    initCrashJournal(dir)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bus = new MessageBus(100, SMALL_OPTS)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    ws.send.mockClear()

    bus.publish('s1', makeMessageEndFrame([{ type: 'text', text: 'x'.repeat(5000) }]))

    // 既有行为不变：截断版占 seq 入 ring 广播
    const received = sentMessages(ws)
    expect(received).toHaveLength(1)
    expect(received[0]?.seq).toBe(1)
    const content = (received[0]?.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(content[0]?.text).toContain('已在传输层截断')

    await closeCrashJournal()
    const records = readJournalRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ layer: 'runtime', event: 'frame-truncated', reason: 'trunc-tier', sessionId: 's1' })
    const detail = JSON.parse(records[0]!.detailDigest as string) as Record<string, unknown>
    expect(detail['frameType']).toBe('message.message_end')
    expect(Number(detail['bytesBefore'])).toBeGreaterThan(SMALL_OPTS.truncateBytes)
    expect(Number(detail['bytesAfter'])).toBeLessThanOrEqual(SMALL_OPTS.truncateBytes)
    expect(detail['fieldPaths']).toEqual(['payload.entry.message.content'])
    expect(detail['channel']).toBe('push')
  })

  it('注册表 miss → registry-miss(reason=registry_miss)；仍走原分支（不占 seq 不广播，后续 seq 连续）', async () => {
    const dir = initDataDir()
    initCrashJournal(dir)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new MessageBus(100, SMALL_OPTS)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    ws.send.mockClear()

    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }) // seq 1
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', blob: 'x'.repeat(5000) } }) // dropped
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }) // seq 2

    // 既有行为不变：miss 帧整条丢弃不占 seq，后续消息 seq 连续无 gap
    const received = sentMessages(ws)
    expect(received.map((m) => m.seq)).toEqual([1, 2])

    await closeCrashJournal()
    const records = readJournalRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ layer: 'runtime', event: 'registry-miss', reason: 'registry_miss', sessionId: 's1' })
    const detail = JSON.parse(records[0]!.detailDigest as string) as Record<string, unknown>
    expect(detail['frameType']).toBe('message.complete')
    expect(detail['dropReason']).toBe('registry_miss')
    expect(detail['channel']).toBe('push')
    // 双写时序：miss 的 warn 哨兵日志照打（既有判定分支零改动）
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('替换后仍超限 → registry-miss(reason=still_oversize_after_truncate)（两 miss 形态按 reason 区分）', async () => {
    const dir = initDataDir()
    initCrashJournal(dir)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new MessageBus(100, SMALL_OPTS)
    bus.subscribe('s1', makeClient())

    // content 超限会被替换，但未注册 blob 字段仍把帧撑过截断档 → still_oversize_after_truncate
    const msg = {
      type: 'message.message_end',
      payload: {
        sessionId: 's1',
        entry: {
          type: 'message',
          timestamp: '2026-09-09T00:00:00.000Z',
          message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
        },
        blob: 'z'.repeat(5000),
      },
    } as unknown as ServerMessage
    bus.publish('s1', msg)

    await closeCrashJournal()
    const records = readJournalRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'registry-miss', reason: 'still_oversize_after_truncate', sessionId: 's1' })
  })
})

// ── reply 通路（ServerMessageBroker.reply） ─────────────────────────

describe('ServerMessageBroker.reply 条件信号事件接线（u1e）', () => {
  it('reply 超限 → frame-truncated(reason=trunc-tier)；错误 envelope 形态不变（type:id:code 保留）', async () => {
    const dir = initDataDir()
    initCrashJournal(dir)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices, { warnBytes: 1024, truncateBytes: 4096 })

    broker.reply(ws, 'req-42', 'message.error', { sessionId: 's1', message: 'x'.repeat(5000) })

    // 既有行为不变：整帧替换 payload_too_large 错误 envelope（id 保留、含分页恢复指引）
    expect(wsSent(ws)).toHaveLength(1)
    const sent = JSON.parse(wsSent(ws)[0][0] as string) as { type: string; id: string; payload: { code: string; message: string } }
    expect(sent.type).toBe('error')
    expect(sent.id).toBe('req-42')
    expect(sent.payload.code).toBe('payload_too_large')
    expect(sent.payload.message).toContain('加载更早')

    await closeCrashJournal()
    const records = readJournalRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ layer: 'runtime', event: 'frame-truncated', reason: 'trunc-tier', sessionId: 's1' })
    const detail = JSON.parse(records[0]!.detailDigest as string) as Record<string, unknown>
    expect(detail['frameType']).toBe('message.error')
    expect(detail['channel']).toBe('reply')
    expect(Number(detail['bytes'])).toBeGreaterThan(4096)
  })

  it('reply 告警档 → frame-truncated(reason=warn-tier)；reply 原样送达（双写不改变行为）', async () => {
    const dir = initDataDir()
    initCrashJournal(dir)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices, { warnBytes: 1024, truncateBytes: 4096 })

    broker.reply(ws, 'req-1', 'message.error', { sessionId: 's1', message: 'y'.repeat(2000) })

    // 既有行为不变：告警档不改动 reply
    expect(wsSent(ws)).toHaveLength(1)
    const sent = JSON.parse(wsSent(ws)[0][0] as string) as { type: string; payload: { message: string } }
    expect(sent.type).toBe('message.error')
    expect(sent.payload.message).toBe('y'.repeat(2000))

    await closeCrashJournal()
    const records = readJournalRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'frame-truncated', reason: 'warn-tier', sessionId: 's1' })
    const detail = JSON.parse(records[0]!.detailDigest as string) as Record<string, unknown>
    expect(detail['channel']).toBe('reply')
  })

  it('payload 无 sessionId 的 reply → 事件 sessionId=null（schema 字段可空契约）', async () => {
    const dir = initDataDir()
    initCrashJournal(dir)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices, { warnBytes: 1024, truncateBytes: 4096 })

    // payload 无 sessionId 的超限 reply：事件照记，sessionId 落 null
    broker.reply(ws, 'req-8', 'message.error', { message: 'x'.repeat(5000) } as never)

    await closeCrashJournal()
    const records = readJournalRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'frame-truncated', reason: 'trunc-tier' })
    expect(records[0]!.sessionId ?? null).toBeNull()
  })
})

// ── best-effort 契约 ───────────────────────────────────────────────

describe('台账未初始化（no-op 单例）时挂点零影响', () => {
  it('不 init 台账：告警/截断/miss/reply 全部挂点不抛，守卫行为照旧', () => {
    initDataDir() // 只建目录，不 initCrashJournal
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const bus = new MessageBus(100, SMALL_OPTS)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    ws.send.mockClear()
    expect(() => {
      bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', note: 'y'.repeat(2000) } })
      bus.publish('s1', makeMessageEndFrame([{ type: 'text', text: 'x'.repeat(5000) }]))
      bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', blob: 'x'.repeat(5000) } })
    }).not.toThrow()
    // 守卫行为照旧：告警帧 + 截断帧送达，miss 帧丢弃 → 2 条
    expect(sentMessages(ws)).toHaveLength(2)

    const ws2 = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws2]) }, mockServices, { warnBytes: 1024, truncateBytes: 4096 })
    expect(() => broker.reply(ws2, 'req-1', 'message.error', { sessionId: 's1', message: 'x'.repeat(5000) })).not.toThrow()
    expect(wsSent(ws2)).toHaveLength(1)

    // 台账文件不存在（no-op writer 未产生任何写入面）
    expect(existsSync(join(dataDir, 'logs', 'crashes'))).toBe(false)
  })
})
