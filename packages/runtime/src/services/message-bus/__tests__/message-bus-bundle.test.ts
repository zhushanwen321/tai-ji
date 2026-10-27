import { closeCrashJournal, initCrashJournal } from '../../../infra/crash-journal.js';
import { ServerMessageBroker } from '../../../transport/message-broker.js';
import { scanPlanStateEntries } from '../../session/plan-state-extractor.js';
import { MessageBus, STATE_NO_KEY_TOPICS, STATE_TYPE_KEY_MAP, STATE_TYPE_KEY_PAYLOAD_DERIVED, TOPIC_TABLE } from '../message-bus.js';
import { DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS, formatReplyOversizeMessage, formatTruncationNote, guardOutboundPushFrame, type OutboundFrameGuardOptions } from '../outbound-frame-registry.js';
import type { BusClient } from '../types.js';
import type { ServerMessage } from '@taiji/shared';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/message-bus/__tests__/crash-journal-wiring.test.ts
// ======================================================================

import type { BrokerServices } from '../../../transport/message-broker.js';
/** 测试小阈值：告警 1KB / 截断 4KB（outbound-frame-guard.test.ts 同款校准法）。 */
const SMALL_OPTS: OutboundFrameGuardOptions = { warnBytes: 1024, truncateBytes: 4096 }


const createdDirs: string[] = []

let dataDir: string


function initDataDir(): string {
  dataDir = mkdtempSync(join(tmpdir(), 'frame-journal-wiring-'))
  createdDirs.push(dataDir)
  return dataDir
}


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


/** 最小 BrokerServices（reply 检查不读 services）。 */
const mockServices = {
  sessionService: { listPersistedSessions: () => [] },
  configService: { listProviders: () => [], getDefaultModel: () => null, loadSkills: () => [], loadAgents: () => [] },
  modelService: { aggregateModels: () => [] },
  pluginService: undefined,
  extensionService: undefined,
  projectRoot: '/mock',
  appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
} as unknown as BrokerServices

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('crash-journal-wiring', () => {
afterEach(async () => {
  vi.restoreAllMocks()
  // close 清空单例 → 下一用例 initCrashJournal 指向新 tmpdir（??= 幂等语义要求先清）
  await closeCrashJournal()
})
afterAll(() => {
  // maxRetries+retryDelay（crash-journal.test.ts 同款）：teardown 与在途异步写竞争吞瞬态
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
// ── push 通路（MessageBus.publish） ────────────────────────────────

describe('MessageBus.publish 条件信号事件接线（u1e）', () => {
  it('告警档帧 → frame-truncated(reason=warn-tier)；消息原样广播 seq 正常（双写不改变检查行为）', async () => {
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

describe('journal 未初始化（no-op 单例）时挂点零影响', () => {
  it('不 init journal：告警/截断/miss/reply 全部挂点不抛，检查行为照旧', () => {
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
    // 检查行为照旧：告警帧 + 截断帧送达，miss 帧丢弃 → 2 条
    expect(sentMessages(ws)).toHaveLength(2)

    const ws2 = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws2]) }, mockServices, { warnBytes: 1024, truncateBytes: 4096 })
    expect(() => broker.reply(ws2, 'req-1', 'message.error', { sessionId: 's1', message: 'x'.repeat(5000) })).not.toThrow()
    expect(wsSent(ws2)).toHaveLength(1)

    // journal 文件不存在（no-op writer 未产生任何写入）
    expect(existsSync(join(dataDir, 'logs', 'crashes'))).toBe(false)
  })
})
});

// ======================================================================
// ← src/services/message-bus/__tests__/message-bus-plan-state.test.ts
// ======================================================================

function makeClient_m2(): BusClient & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as BusClient & { send: ReturnType<typeof vi.fn> }
}


function planStateFrame(isActive: boolean): ServerMessage {
  return {
    type: 'session.planState',
    payload: {
      sessionId: 's1',
      planState: { isActive, planFilePath: isActive ? '/tmp/taiji-plan/auth/plan.md' : null, requirement: null, templateName: null },
    },
  } as unknown as ServerMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-bus-plan-state', () => {
describe('session.planState 两表登记（D1⑤）', () => {
  it('state 类：写 stateSnapshot（typeKey plan）且不入 streamRing', () => {
    const bus = new MessageBus()
    bus.publish('s1', planStateFrame(true))
    const sub = bus.subscribe('s1', makeClient_m2())
    expect(sub.stateSnapshot.map((m) => m.type)).toEqual(['session.planState'])
    expect(sub.snapshot).toHaveLength(0)
    // state 类分配 seq（订阅方 lastSeq 基线推进）
    expect(sub.lastSeq).toBe(1)
  })

  it('last-value 覆盖：同 typeKey 替换只留最新值（isActive 翻转可回放）', () => {
    const bus = new MessageBus()
    bus.publish('s1', planStateFrame(true))
    bus.publish('s1', planStateFrame(false))
    const sub = bus.subscribe('s1', makeClient_m2())
    expect(sub.stateSnapshot).toHaveLength(1)
    const payload = sub.stateSnapshot[0]!.payload as { planState: { isActive: boolean } }
    expect(payload.planState.isActive).toBe(false)
  })

  it('wire 直推：订阅中的 ws 收到该帧（广播正常）', () => {
    const bus = new MessageBus()
    const ws = makeClient_m2()
    bus.subscribe('s1', ws)
    bus.publish('s1', planStateFrame(true))
    const received = ws.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
    expect(received.map((m) => m.type)).toEqual(['session.planState'])
  })
})
describe('D9③ 派生视图边界：selfReview 不进 session.planState 帧', () => {
  it('entry 携带 selfReview → 派生 View 无 selfReview、帧经 bus 序列化全程无泄漏；state/resumeHint 无损透传', () => {
    const entry = {
      type: 'custom',
      customType: 'plan-state',
      id: 'e1',
      parentId: null,
      timestamp: '2026-09-24T00:00:00Z',
      data: {
        isActive: true,
        planFilePath: '/tmp/taiji-plan/auth/plan.md',
        requirement: '重构 auth 模块',
        templateName: 'tech-design',
        state: 'reviewing',
        resumeHint: 'resubmit',
        selfReview: '自审结论（消费方止于审批请求帧，不映射进本帧）',
      },
    }
    const view = scanPlanStateEntries([entry])
    expect(view).not.toBeNull()
    expect(view!.state).toBe('reviewing')
    expect(view!.resumeHint).toBe('resubmit')
    expect('selfReview' in view!).toBe(false)

    const bus = new MessageBus()
    const ws = makeClient_m2()
    bus.subscribe('s1', ws)
    bus.publish('s1', {
      type: 'session.planState',
      payload: { sessionId: 's1', planState: view },
    } as unknown as ServerMessage)
    const received = ws.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
    // 序列化全帧不含 selfReview（派生视图边界止于审批请求帧，planState 帧有界前提不扩展）
    expect(JSON.stringify(received)).not.toContain('selfReview')
    const payload = received[0]!.payload as { planState: { state: string; resumeHint: string } }
    expect(payload.planState.state).toBe('reviewing')
    expect(payload.planState.resumeHint).toBe('resubmit')
  })
})
});

// ======================================================================
// ← src/services/message-bus/__tests__/message-bus-ring-bytes.test.ts
// ======================================================================

/** 检查静默档：阈值足够大，测试帧不触发出站帧检查（warn/截断都不触发），隔离 B7 变量。 */
const QUIET_OPTS: OutboundFrameGuardOptions = { warnBytes: 8 * 1024 * 1024, truncateBytes: 32 * 1024 * 1024 }


/** 截断启用档（对齐 outbound-frame-guard.test.ts 的 SMALL_OPTS）：告警 1KB / 截断 4KB。 */
const TRUNC_OPTS: OutboundFrameGuardOptions = { warnBytes: 1024, truncateBytes: 4096 }


// ── helpers ──────────────────────────────────────────────────────

/** mock BusClient（最小契约：readyState + send）。 */
function makeClient_m3(): BusClient & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as BusClient & { send: ReturnType<typeof vi.fn> }
}


function sentMessages_m2(client: ReturnType<typeof makeClient_m3>): ServerMessage[] {
  return client.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
}


/** stream 类帧（message.status）——pad 撑到目标字节数附近。 */
function makeStreamFrame(n: number, padLen: number): ServerMessage {
  return {
    type: 'message.status',
    payload: { sessionId: 's1', status: 'running', n, pad: 'x'.repeat(padLen) },
  } as ServerMessage
}


/** 未注册类型帧（fallback=stream）：blob 字段检查不认识，warn 档区间内 passthrough 完整。 */
function makeUnregisteredFrame(blobLen: number): ServerMessage {
  const type: string = 'message.future_unknown_type' // widen：未入表类型不在 ServerMessageType（fallback=stream 语义入口）
  return {
    type,
    payload: { sessionId: 's1', blob: 'y'.repeat(blobLen) },
  } as ServerMessage
}


/** message.message_end 帧（注册表覆盖类型——截断档替换 content 字段的入口）。 */
function makeMessageEndFrame_m2(textLen: number): ServerMessage {
  return {
    type: 'message.message_end',
    payload: {
      sessionId: 's1',
      entry: {
        type: 'message',
        parentId: null,
        timestamp: '2026-09-14T00:00:00.000Z',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(textLen) }] },
      },
    },
  } as unknown as ServerMessage
}


/** state 类帧（typeKey='commands'）。 */
function makeCommandsFrame(padLen: number): ServerMessage {
  return {
    type: 'session.commands',
    payload: { sessionId: 's1', commands: [{ name: 'cmd', pad: 'c'.repeat(padLen) }] },
  } as ServerMessage
}


/** 实际序列化字节数（publish 后对象已带 seq，与 ring 驻留份逐字节一致）。 */
function frameBytes(msg: ServerMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), 'utf8')
}


/** ring 当前驻留帧（按 seq 顺序，浅拷贝）——subscribe snapshot 即 ring 窗口行为范围。 */
function ringSnapshot(bus: MessageBus, sid = 's1'): ServerMessage[] {
  return bus.subscribe(sid, makeClient_m3()).snapshot
}


/** ring 驻留帧的实际总字节（行为化验证记账口径：Σ 序列化字节）。 */
function ringResidentBytes(frames: ServerMessage[]): number {
  return frames.reduce((acc, m) => acc + frameBytes(m), 0)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-bus-ring-bytes', () => {
afterEach(() => {
  vi.restoreAllMocks()
})
// ── 预算内多帧驱逐 ─────────────────────────────────────────────────

describe('B7 · 预算内多帧驱逐（超预算从最旧加速淘汰）', () => {
  it('字节累计超预算时从最旧驱逐至回到预算内；记账与实际驻留字节一致', () => {
    const budget = 1100
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    // 每帧 ~356B：3 帧 ~1068 ≤ 1100 全保留；第 4 帧后 ~1424 > 1100 → 淘汰最旧至 ~1068 ≤ 1100
    const f1 = makeStreamFrame(1, 260)
    const f2 = makeStreamFrame(2, 260)
    const f3 = makeStreamFrame(3, 260)
    const f4 = makeStreamFrame(4, 260)
    for (const f of [f1, f2, f3]) bus.publish('s1', f)
    let snap = ringSnapshot(bus)
    expect(snap).toHaveLength(3)
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)

    bus.publish('s1', f4)
    snap = ringSnapshot(bus)
    // 最旧 f1 被加速淘汰，窗口 = f2,f3,f4（条数上限 100 远未触顶——驱逐由字节预算驱动）
    expect(snap.map((m) => (m.payload as { n: number }).n)).toEqual([2, 3, 4])
    expect(snap[0]).toBe(f2)
    // 记账一致性：驻留字节回到预算内，且恰为实际序列化字节之和（无幽灵增量/漏扣减）
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)
    expect(ringResidentBytes(snap)).toBe(frameBytes(f2) + frameBytes(f3) + frameBytes(f4))
    // seq 分配不受驱逐影响（4 次 publish，lastSeq=4，无回滚）
    expect(bus.subscribe('s1', makeClient_m3()).lastSeq).toBe(4)
  })

  it('大帧一次跨越预算：一次淘汰多帧至回到预算内（不是每 push 只逐一帧）', () => {
    const budget = 1150
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const f1 = makeStreamFrame(1, 60)
    const f2 = makeStreamFrame(2, 60)
    const f3 = makeStreamFrame(3, 60)
    for (const f of [f1, f2, f3]) bus.publish('s1', f) // 3×~156B ≈ 468 ≤ 1150
    // 大帧 ~916B：总 ~1384 > 1150 → 淘汰 f1（~156B）后 ~1228 仍 > 1150 → 再淘汰 f2 → ~1072 ≤ 1150
    const big = makeStreamFrame(4, 820)
    bus.publish('s1', big)
    const snap = ringSnapshot(bus)
    expect(snap.map((m) => (m.payload as { n: number }).n)).toEqual([3, 4])
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)
  })

  it('容量覆盖写淘汰同步扣减：capacity 覆盖最旧帧后 bytes 不留幽灵增量', () => {
    // capacity=2、预算 900B：f1/f2/f3 各 ~356B。容量覆盖淘汰 f1 后实际驻留 = f2+f3 ≈ 712 ≤ 900。
    // 若覆盖写漏扣减（bytes=1068 幽灵）：1068 > 900 会误驱逐 f2——snapshot 断言可判别。
    const budget = 900
    const bus = new MessageBus(2, QUIET_OPTS, budget)
    const f1 = makeStreamFrame(1, 260)
    const f2 = makeStreamFrame(2, 260)
    const f3 = makeStreamFrame(3, 260)
    bus.publish('s1', f1)
    bus.publish('s1', f2)
    bus.publish('s1', f3) // 容量满：覆盖 f1（应扣减其字节）
    const snap = ringSnapshot(bus)
    expect(snap.map((m) => (m.payload as { n: number }).n)).toEqual([2, 3])
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)
    expect(ringResidentBytes(snap)).toBe(frameBytes(f2) + frameBytes(f3))
  })
})
// ── 单帧 > 预算超调下界终止 ─────────────────────────────────────────

describe('B7 · 单帧超预算超调下界终止（不逐新帧不死循环）', () => {
  it('单帧 > 预算：仅剩最新帧即停，驻留不误逐，publish 同步返回（死循环会挂死测试）', () => {
    const budget = 512
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const big = makeStreamFrame(1, 2000) // ~2KB > 512 预算（< 检查阈值，不截断）
    bus.publish('s1', big)
    const snap = ringSnapshot(bus)
    // 下界：仅剩最新帧即停——刚 push 的帧不被逐（驱逐循环 size > 1 终止）
    expect(snap).toHaveLength(1)
    expect(snap[0]).toBe(big)
    // 允许瞬时超调：驻留字节 > 预算是接受态（单帧 truncated ≤32MB > 16MB 同构）
    expect(frameBytes(snap[0])).toBeGreaterThan(budget)
    // seq 正常分配（无回滚），后续 publish 正常推进（不死循环的证据）
    expect(bus.subscribe('s1', makeClient_m3()).lastSeq).toBe(1)
    const next = makeStreamFrame(2, 60)
    bus.publish('s1', next)
    expect(bus.subscribe('s1', makeClient_m3()).lastSeq).toBe(2)
  })

  it('超预算单帧驻留后，后续 push 恢复驱逐能力（大帧被作为最旧淘汰）', () => {
    const budget = 512
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const big = makeStreamFrame(1, 2000)
    bus.publish('s1', big) // 瞬时超调驻留（size=1 下界）
    const small = makeStreamFrame(2, 60)
    bus.publish('s1', small) // bytes ~2.1KB > 512、size=2 → 淘汰最旧（big）→ ~110 ≤ 512 停
    const snap = ringSnapshot(bus)
    expect(snap.map((m) => (m.payload as { n: number }).n)).toEqual([2])
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)
  })
})
// ── truncated 版记账口径 ───────────────────────────────────────────

describe('B7 · truncated 版记账口径（截断档帧按实际入 ring 字节计）', () => {
  it('截断档帧按 truncated 版字节记账：不按外层截断前 bytes 高估（防过早驱逐）', () => {
    // 预算 800B：小帧 A ~150B + 截断档帧 B（原始 ~5.5KB → truncated 占位 ~300B）。
    // 正确口径（truncated 版）：~450 ≤ 800 → A、B 都驻留。
    // 错误口径（复用截断前 5.5KB）：~5.6KB > 800 → 驱逐 A 后仍 > 800 → 只剩 B——断言可判别。
    const budget = 800
    const bus = new MessageBus(100, TRUNC_OPTS, budget)
    const ws = makeClient_m3()
    bus.subscribe('s1', ws)
    const A = makeStreamFrame(1, 100)
    const B = makeMessageEndFrame_m2(5000) // > truncate 4KB → replaced（truncated 版入 ring）
    bus.publish('s1', A)
    bus.publish('s1', B)

    const snap = ringSnapshot(bus)
    expect(snap).toHaveLength(2)
    expect(snap[0]).toBe(A) // A 未被过早驱逐 → 证明记账用的是 truncated 版字节
    const truncatedStored = snap[1]!
    const content = (truncatedStored.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(content[0]?.text).toContain('已在传输层截断')
    // 记账一致性：驻留字节 = 实际 truncated 版序列化之和，在预算内且远小于原始 5.5KB 口径
    const resident = ringResidentBytes(snap)
    expect(resident).toBeLessThanOrEqual(budget)
    expect(frameBytes(A) + frameBytes(truncatedStored)).toBe(resident)
  })
})
// ── stateSnapshot 覆盖式计量 ────────────────────────────────────────

describe('B7 · stateSnapshot 覆盖式计量（仅观测，不驱逐）', () => {
  it('同 typeKey set 替换按当前值重计（非累计求和）：缩值替换后不再虚假触发 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const budget = 500
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const big = makeCommandsFrame(420) // ~600B（帧骨架 + pad）
    bus.publish('s1', big)
    // 超预算 → warn #1（仅观测信号）
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('stateSnapshot')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('observe-only')

    // 缩值替换：当前值口径 total = 小帧字节 ≤ 500 → 不再 warn。
    // 累计求和的错误口径会得到 600+~130 > 500 再次触发（虚假）——断言 0 次新增可判别。
    const small = makeCommandsFrame(0) // ~130B
    bus.publish('s1', small)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // 观测不驱逐：快照存活且只留最新值（覆盖语义），ring 不受 state 记账影响
    const sub = bus.subscribe('s1', makeClient_m3())
    expect(sub.stateSnapshot).toHaveLength(1)
    expect(sub.stateSnapshot[0]).toBe(small)
    expect(sub.snapshot).toHaveLength(0)
  })

  it('不同 typeKey 各计当前值：跨 key 累计超预算触发 warn，key 内替换不叠加', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const budget = 500
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const cmds = makeCommandsFrame(0) // ~130B
    bus.publish('s1', cmds)
    expect(warnSpy).not.toHaveBeenCalled()
    // 第二个 typeKey（context）~450B：跨 key 合计 ~580 > 500 → warn
    const ctx: ServerMessage = {
      type: 'context.update',
      payload: { sessionId: 's1', usagePercent: 50, pad: 'z'.repeat(400) },
    } as ServerMessage
    bus.publish('s1', ctx)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    // 同 key（context）替换为小值：合计回到 ~130+~60 ≤ 500 → 不再新增 warn（当前值口径）
    const ctxSmall: ServerMessage = {
      type: 'context.update',
      payload: { sessionId: 's1', usagePercent: 50 },
    } as ServerMessage
    bus.publish('s1', ctxSmall)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const sub = bus.subscribe('s1', makeClient_m3())
    expect(sub.stateSnapshot.map((m) => m.type).sort()).toEqual(['context.update', 'session.commands'])
  })
})
// ── 记账不截断（单帧行为不变） ───────────────────────────────────────

describe('B7 · 记账不截断（单帧行为完全不变，wire≡ring 同一份）', () => {
  it('8-32MB warn 档（小阈值同构）：超预算也照旧双完整——wire 收完整帧 + ring 存完整帧，不驱逐不截断', () => {
    const budget = 512
    const bus = new MessageBus(100, TRUNC_OPTS, budget) // warn 1KB / truncate 4KB
    const ws = makeClient_m3()
    bus.subscribe('s1', ws)
    const blobLen = 2000 // ~2KB ∈ (warn 1KB, truncate 4KB] → warn 档 passthrough 完整
    const frame = makeUnregisteredFrame(blobLen)
    bus.publish('s1', frame)

    // wire：收到完整帧（blob 原样，无截断无占位）
    const received = sentMessages_m2(ws)
    expect(received).toHaveLength(1)
    expect((received[0]!.payload as { blob: string }).blob).toBe('y'.repeat(blobLen))
    // ring：存完整帧（同一对象引用，字节 > 预算靠下界驻留——记账不改变单帧处置）
    const snap = ringSnapshot(bus)
    expect(snap).toHaveLength(1)
    expect(snap[0]).toBe(frame)
    expect((snap[0]!.payload as { blob: string }).blob).toBe('y'.repeat(blobLen))
    // wire ≡ ring 逐字节一致
    expect(JSON.stringify(received[0])).toBe(JSON.stringify(snap[0]))
  })

  it('32MB 截断档（小阈值同构）：超预算下 wire 与 ring 仍是同一份截断版，预算不引入二次截断/丢帧', () => {
    const budget = 300
    const bus = new MessageBus(100, TRUNC_OPTS, budget) // truncate 4KB
    const ws = makeClient_m3()
    bus.subscribe('s1', ws)
    const original = makeMessageEndFrame_m2(5000) // > 4KB → truncated 版
    bus.publish('s1', original)

    // wire：截断版送达（content 为占位文案——既有行为）
    const received = sentMessages_m2(ws)
    expect(received).toHaveLength(1)
    const wireContent = (received[0]!.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(wireContent[0]?.text).toContain('已在传输层截断')
    // ring：同一份截断版（超预算靠下界驻留，无二次截断）
    const snap = ringSnapshot(bus)
    expect(snap).toHaveLength(1)
    expect(JSON.stringify(snap[0])).toBe(JSON.stringify(received[0]))
    // 入参零污染（既有不变式保持）：调用方持有的 original 仍是完整 5KB 文本
    const originalContent = (original.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(originalContent[0]?.text).toBe('x'.repeat(5000))
  })

  it('预算生效下 seq 连续与广播计数不变：截断版照常占 seq 双写（记账零旁效）', () => {
    const budget = 256
    const bus = new MessageBus(100, TRUNC_OPTS, budget)
    const ws = makeClient_m3()
    bus.subscribe('s1', ws)
    bus.publish('s1', makeStreamFrame(1, 60)) // 小帧 seq 1
    bus.publish('s1', makeMessageEndFrame_m2(5000)) // 截断版占 seq 2
    bus.publish('s1', makeStreamFrame(3, 60)) // 小帧 seq 3
    const received = sentMessages_m2(ws)
    // 三条全部广播（wire 面零变化），seq 连续（无 gap——记账/驱逐不触 seq）
    expect(received).toHaveLength(3)
    expect(received.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(bus.subscribe('s1', makeClient_m3()).lastSeq).toBe(3)
  })

  it('默认构造（16MB 预算）下常规小消息零行为变化：驻留/回放/seq 与既有语义一致', () => {
    const bus = new MessageBus() // 默认 1000 帧 / 16MB 预算 / 生产检查阈值
    const ws = makeClient_m3()
    bus.subscribe('s1', ws)
    const f1 = makeStreamFrame(1, 200)
    const f2 = makeStreamFrame(2, 200)
    bus.publish('s1', f1)
    bus.publish('s1', f2)
    const sub = bus.subscribe('s1', makeClient_m3())
    expect(sub.snapshot).toHaveLength(2) // 小消息远低于预算：零驱逐
    expect(sub.snapshot[0]).toBe(f1)
    expect(sub.snapshot[1]).toBe(f2)
    expect(sub.lastSeq).toBe(2)
    expect(sentMessages_m2(ws)).toHaveLength(2)
  })
})
});

// ======================================================================
// ← src/services/message-bus/__tests__/outbound-frame-guard.test.ts
// ======================================================================

/** 测试小阈值：告警 1KB / 截断 4KB（远小于生产 8MB/32MB，行为逻辑同构）。 */
const SMALL_OPTS_m2: OutboundFrameGuardOptions = { warnBytes: 1024, truncateBytes: 4096 }


// ── fixture 工厂（对齐 event-adapter.ts / event-interpreter.ts 的真实帧形态） ──

/** message.message_end 帧（toolResult 大结果场景——content 是 block 数组）。 */
function makeMessageEndFrame_m3(content: unknown): ServerMessage {
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


/** message.tool_call_start 帧（write 类工具大参数场景）。 */
function makeToolCallStartFrame(argumentsRecord: Record<string, unknown>): ServerMessage {
  return {
    type: 'message.tool_call_start',
    payload: {
      sessionId: 's1',
      entry: { type: 'message', timestamp: '2026-09-09T00:00:00.000Z', messageId: 'm1', arguments: argumentsRecord },
    },
  } as unknown as ServerMessage
}


/** mock BusClient（最小契约：readyState + send；cast 与 test/message-broker.test.ts 同惯例）。 */
function makeClient_m4(): BusClient & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as BusClient & { send: ReturnType<typeof vi.fn> }
}


/** mock WsType（broker reply 通路参数是 ws.WebSocket 类型；cast 与 test/message-broker.test.ts 同惯例）。 */
function makeWsClient_m2(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket
}


/** 取 mock WsType 的 send 调用记录（[0] = 序列化后的 JSON 文本）。 */
function wsSent_m2(ws: WebSocket): unknown[][] {
  return (ws as unknown as { send: ReturnType<typeof vi.fn> }).send.mock.calls
}


function sentMessages_m3(client: ReturnType<typeof makeClient_m4>): ServerMessage[] {
  return client.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
}


// ── reply 通路（ServerMessageBroker） ──────────────────────────────

/** 最小 BrokerServices（reply 检查不读 services，构造满足类型即可）。 */
const mockServices_m2 = {
  sessionService: { listPersistedSessions: () => [] },
  configService: { listProviders: () => [], getDefaultModel: () => null, loadSkills: () => [], loadAgents: () => [] },
  modelService: { aggregateModels: () => [] },
  pluginService: undefined,
  extensionService: undefined,
  projectRoot: '/mock',
  appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
} as unknown as BrokerServices

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('outbound-frame-guard', () => {
afterEach(() => {
  vi.restoreAllMocks()
})
// ── guardOutboundPushFrame 纯函数 ──────────────────────────────────

describe('guardOutboundPushFrame（push 通路检查纯函数）', () => {
  it('小消息 passthrough：注册表未命中类型零开销路径，内容原样、入参零污染', () => {
    const msg: ServerMessage = { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }
    const before = JSON.stringify(msg)
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('passthrough')
    if (r.action === 'passthrough') expect(r.message).toBe(msg) // 同一引用，零拷贝零改动
    expect(JSON.stringify(msg)).toBe(before)
  })

  it('8MB 告警档（小阈值 1KB）：介于告警/截断档之间的帧 passthrough 且 warn 日志含类型与字节数', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const big = 'y'.repeat(2000)
    const msg: ServerMessage = { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', note: big } }
    const bytes = Buffer.byteLength(JSON.stringify(msg), 'utf8')
    expect(bytes).toBeGreaterThan(SMALL_OPTS_m2.warnBytes)
    expect(bytes).toBeLessThanOrEqual(SMALL_OPTS_m2.truncateBytes)
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('passthrough')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('message.complete')
    expect(warnSpy.mock.calls[0]?.[0]).toContain(`bytes=${bytes}`)
  })

  it('content 类占位形态：message_end 超限 → content 整字段替换为 [{type:text,text:含截断文案}]，帧其余部分原样', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const msg = makeMessageEndFrame_m3([{ type: 'text', text: 'x'.repeat(5000) }])
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    expect(r.bytesBefore).toBeGreaterThan(SMALL_OPTS_m2.truncateBytes)
    expect(r.bytesAfter).toBeLessThanOrEqual(SMALL_OPTS_m2.truncateBytes)
    expect(r.fieldPaths).toEqual(['payload.entry.message.content'])
    const content = (r.message.payload as { entry: { message: { content: unknown } } }).entry.message.content
    expect(Array.isArray(content)).toBe(true)
    expect(content).toHaveLength(1)
    expect((content as Array<{ type: string; text: string }>)[0]?.type).toBe('text')
    expect((content as Array<{ type: string; text: string }>)[0]?.text).toContain('已在传输层截断')
    expect((content as Array<{ type: string; text: string }>)[0]?.text).toContain('session 文件')
    // 入参零污染：原始 content 保持大文本（调用方 event-adapter 持有的 entry 不被截断污染）
    const originalContent = (msg.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(originalContent[0]?.text).toBe('x'.repeat(5000))
    expect(warnSpy).toHaveBeenCalledOnce() // replaced 也记一条大帧告警
  })

  it('record 类占位形态：tool_call_start 的 arguments 超限 → 类型保持 record {truncated,reason,originalBytes}', () => {
    const msg = makeToolCallStartFrame({ content: 'w'.repeat(5000), file_path: '/tmp/a.txt' })
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    expect(r.fieldPaths).toEqual(['payload.entry.arguments'])
    const args = (r.message.payload as { entry: { arguments: Record<string, unknown> } }).entry.arguments
    // record 契约保持：仍是 plain object，不谎报为其他类型
    expect(typeof args).toBe('object')
    expect(args['truncated']).toBe(true)
    expect(args['reason']).toBe('payload_too_large')
    expect(typeof args['originalBytes']).toBe('number')
    expect(args['originalBytes']).toBeGreaterThan(SMALL_OPTS_m2.warnBytes)
    // 原始 arguments 零污染
    expect((msg.payload as { entry: { arguments: { content: string } } }).entry.arguments.content).toBe('w'.repeat(5000))
  })

  it('array-string 类占位形态：subagent.stream_delta 的 lines 超限 → [占位字符串]（元素与原元素同型）', () => {
    const msg: ServerMessage = {
      type: 'subagent.stream_delta',
      payload: { sessionId: 's1', recordId: 'r1', lines: ['x'.repeat(5000)] },
    }
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    const lines = (r.message.payload as { lines: string[] }).lines
    expect(Array.isArray(lines)).toBe(true)
    expect(lines).toHaveLength(1)
    expect(typeof lines[0]).toBe('string')
    expect(lines[0]).toContain('已在传输层截断')
  })

  it('subagent.stream_chunk（B2 chunk 通道）小消息不登记：超限走 miss 整条丢弃（跳号 → 消费端失步拉取恢复），不截断', () => {
    // 设计 §4.3 chunk 超限特例：截断占位文本会被拼进消息流成为内容污染——chunk 刻意不
    // 进 LARGE_FIELD_REGISTRY，超限唯一形态 = registry_miss 整条丢弃；产生端计数已先推进，
    // 消费端表现为 deltaSeq 跳号，走 session.getSubagentStreamState 拉取恢复。
    const msg: ServerMessage = {
      type: 'subagent.stream_chunk',
      payload: { sessionId: 's1', recordId: 'r1', msgSeq: 1, deltaSeq: 7, delta: 'x'.repeat(5000) },
    }
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('dropped')
    if (r.action !== 'dropped') return
    expect(r.dropReason).toBe('registry_miss')
    // 入参零污染（不 mutate）
    expect((msg.payload as { delta: string }).delta).toBe('x'.repeat(5000))
  })

  it('array-entry 类占位形态：traceEntryAppended 的 entries 超限 → 单元素 PiMessageEntry 占位数组（reducer 可消化形态）', () => {
    const msg: ServerMessage = {
      type: 'session.traceEntryAppended',
      payload: {
        sessionId: 's1',
        entries: [{ type: 'message', id: 'e1', timestamp: '2026-09-09T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] } }],
        leafId: 'e1',
      },
    }
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    const entries = (r.message.payload as { entries: Array<Record<string, unknown>> }).entries
    expect(Array.isArray(entries)).toBe(true)
    expect(entries).toHaveLength(1)
    const placeholder = entries[0]
    // 占位 entry 带 id（幂等消化锚点——文件头「reducer 按 entry.id 幂等消化」自洽）；
    // 'truncated-<seq>-array-entry' 命名空间与真实 pi entry id（uuidv7）无碰撞
    expect(placeholder['id']).toMatch(/^truncated-\d+-array-entry$/)
    expect(placeholder['type']).toBe('message')
    const body = placeholder['message'] as { role?: string; content?: Array<{ type: string; text: string }> }
    expect(body.role).toBe('assistant')
    expect(body.content?.[0]?.type).toBe('text')
    expect(body.content?.[0]?.text).toContain('已在传输层截断')
  })

  it('array-entry 占位 id 唯一性：同 session 两次截断帧的占位 entry id 互不相同（防 reducer 按 id 折叠两条不同消息）', () => {
    const makeFrame = (): ServerMessage => ({
      type: 'session.traceEntryAppended',
      payload: {
        sessionId: 's1',
        entries: [{ type: 'message', id: 'e1', timestamp: '2026-09-09T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] } }],
        leafId: 'e1',
      },
    } as unknown as ServerMessage)
    const r1 = guardOutboundPushFrame(makeFrame(), 's1', SMALL_OPTS_m2)
    const r2 = guardOutboundPushFrame(makeFrame(), 's1', SMALL_OPTS_m2)
    if (r1.action !== 'replaced' || r2.action !== 'replaced') return
    const id1 = (r1.message.payload as { entries: Array<Record<string, unknown>> }).entries[0]?.['id']
    const id2 = (r2.message.payload as { entries: Array<Record<string, unknown>> }).entries[0]?.['id']
    expect(typeof id1).toBe('string')
    expect(id1).not.toBe(id2)
  })

  it('string 类占位形态：bashResult 的 output 超限 → 占位文案字符串本体（类型保持 string）', () => {
    const msg: ServerMessage = {
      type: 'message.bashResult',
      payload: { sessionId: 's1', command: 'cat big.txt', output: 'x'.repeat(5000), exitCode: 0, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1 },
    }
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    const output = (r.message.payload as { output: string }).output
    expect(typeof output).toBe('string')
    expect(output).toContain('已在传输层截断')
  })

  it('miss 兜底：注册表未覆盖类型（message.complete）超限 → dropped(registry_miss)，8MB 告警档 warn 先于 error 日志（D3 代价 B / A10④）', () => {
    const order: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('warn') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error') })
    const msg: ServerMessage = { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', blob: 'x'.repeat(5000) } }
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('dropped')
    if (r.action !== 'dropped') return
    expect(r.dropReason).toBe('registry_miss')
    // miss 消息必先打告警（哨兵前置暴露），error 随后
    expect(order).toEqual(['warn', 'error'])
    expect(warnSpy.mock.calls[0]?.[0]).toContain('large outbound push frame (warn)')
    expect(warnSpy.mock.calls[0]?.[0]).toContain('message.complete')
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]?.[0]).toContain('registry miss')
    expect(errorSpy.mock.calls[0]?.[0]).toContain('message.complete')
  })

  it('miss 兜底（超限来自未注册字段）：注册字段未超告警档不替换 → dropped(registry_miss)，warn 先于 error', () => {
    const order: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('warn') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error') })
    // content 只有 500 字节（< warn 1KB），超限来自未注册的 blob 字段
    const msg: ServerMessage = {
      type: 'message.message_end',
      payload: {
        sessionId: 's1',
        entry: {
          type: 'message',
          timestamp: '2026-09-09T00:00:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(500) }] },
        },
        blob: 'z'.repeat(5000),
      },
    } as unknown as ServerMessage
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('dropped')
    if (r.action !== 'dropped') return
    expect(r.dropReason).toBe('registry_miss')
    expect(order).toEqual(['warn', 'error'])
  })

  it('miss 兜底：注册字段替换后帧仍超截断档 → dropped(still_oversize_after_truncate)，warn 先于 error', () => {
    const order: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('warn') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error') })
    // content 超限会被替换，但未注册的 blob 字段仍把帧撑过截断档
    const msg: ServerMessage = {
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
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS_m2)
    expect(r.action).toBe('dropped')
    if (r.action !== 'dropped') return
    expect(r.dropReason).toBe('still_oversize_after_truncate')
    expect(order).toEqual(['warn', 'error'])
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('检查零抛错：resolveSessionFilePath 抛错不打断截断流程，占位路径退化为「（见 runtime 日志）」', () => {
    const throwing: OutboundFrameGuardOptions = {
      ...SMALL_OPTS_m2,
      resolveSessionFilePath: () => {
        throw new Error('path resolution exploded')
      },
    }
    const msg = makeMessageEndFrame_m3([{ type: 'text', text: 'x'.repeat(5000) }])
    const r = guardOutboundPushFrame(msg, 's1', throwing)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    const content = (r.message.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(content[0]?.text).toContain('（见 runtime 日志）')
  })

  it('占位文案路径可得时填实路径；formatTruncationNote 含 MB 体积', () => {
    const withPath: OutboundFrameGuardOptions = {
      ...SMALL_OPTS_m2,
      resolveSessionFilePath: (sid) => (sid === 's1' ? '/data/agent/sessions/x/1_s1.jsonl' : null),
    }
    const note = formatTruncationNote(5 * 1024 * 1024, 's1', withPath)
    expect(note).toContain('5.0 MB')
    expect(note).toContain('/data/agent/sessions/x/1_s1.jsonl')
    // 不可得（null / 未注入）→ 占位
    expect(formatTruncationNote(1024, 's2', withPath)).toContain('（见 runtime 日志）')
    expect(formatTruncationNote(1024, 's1', SMALL_OPTS_m2)).toContain('（见 runtime 日志）')
    // 生产默认阈值来自 shared 常量（不重复断言数值本身，只锚定引用关系）
    expect(DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS.warnBytes).toBeGreaterThan(0)
  })
})
// ── MessageBus 集成（seq 连续性 / ring 回放 / 重订阅） ─────────────

describe('MessageBus.publish 出站检查集成', () => {
  it('push 截断后 seq 连续：超限帧截断版正常占 seq 入 ring 广播，无 gap', () => {
    const bus = new MessageBus(100, SMALL_OPTS_m2)
    const ws = makeClient_m4()
    bus.subscribe('s1', ws)
    ws.send.mockClear()

    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } })
    bus.publish('s1', makeMessageEndFrame_m3([{ type: 'text', text: 'x'.repeat(5000) }]))
    bus.publish('s1', { type: 'message.status', payload: { sessionId: 's1', status: 'running' } })

    const received = sentMessages_m3(ws)
    expect(received).toHaveLength(3)
    // seq 1/2/3 连续——截断版占 seq 2，不产生 gap
    expect(received.map((m) => m.seq)).toEqual([1, 2, 3])
    const truncated = received[1]
    expect(truncated.type).toBe('message.message_end')
    const content = (truncated.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(content[0]?.text).toContain('已在传输层截断')
  })

  it('ring 回放/重订阅视角拿到同一份截断版（回放内容 === 在场广播内容）', () => {
    const bus = new MessageBus(100, SMALL_OPTS_m2)
    const liveWs = makeClient_m4()
    bus.subscribe('s1', liveWs)
    bus.publish('s1', makeMessageEndFrame_m3([{ type: 'text', text: 'x'.repeat(5000) }]))

    const liveReceived = sentMessages_m3(liveWs)
    expect(liveReceived).toHaveLength(1)

    // 模拟断连重连：新 ws subscribe → ring 快照回放
    const reconnectWs = makeClient_m4()
    const { snapshot, lastSeq } = bus.subscribe('s1', reconnectWs)
    expect(lastSeq).toBe(1)
    expect(snapshot).toHaveLength(1)
    // 回放版与在场广播版逐字节一致（同一份截断对象）
    expect(JSON.stringify(snapshot[0])).toBe(JSON.stringify(liveReceived[0]))
    const replayContent = (snapshot[0]?.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(replayContent[0]?.text).toContain('已在传输层截断')
  })

  it('miss 兜底：未注册类型超限帧整条丢弃（不占 seq 不广播），后续消息 seq 仍连续；丢弃前先打 8MB 告警档 warn', () => {
    const order: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('warn') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error') })
    const bus = new MessageBus(100, SMALL_OPTS_m2)
    const ws = makeClient_m4()
    bus.subscribe('s1', ws)
    ws.send.mockClear()

    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }) // seq 1
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', blob: 'x'.repeat(5000) } }) // dropped，无 seq
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }) // seq 2

    const received = sentMessages_m3(ws)
    expect(received).toHaveLength(2)
    expect(received.map((m) => m.seq)).toEqual([1, 2])
    expect(received.every((m) => (m.payload as { blob?: string }).blob === undefined)).toBe(true)
    // D3 代价 B：miss 丢弃前必先打告警档 warn
    expect(order).toEqual(['warn', 'error'])
    expect(warnSpy.mock.calls[0]?.[0]).toContain('large outbound push frame (warn)')
    expect(errorSpy).toHaveBeenCalledOnce()

    // 重订阅 lastSeq 同样不包含被丢帧（seq 2，非 3）
    const { lastSeq } = bus.subscribe('s1', makeClient_m4())
    expect(lastSeq).toBe(2)
  })

  it('transient 超限帧截断直传：不占 seq、无 seq 字段、截断版送达', () => {
    const bus = new MessageBus(100, SMALL_OPTS_m2)
    const ws = makeClient_m4()
    bus.subscribe('s1', ws)
    ws.send.mockClear()

    bus.publish('s1', {
      type: 'terminal.data',
      payload: { sessionId: 's1', data: 'x'.repeat(5000) },
    })

    const received = sentMessages_m3(ws)
    expect(received).toHaveLength(1)
    expect(received[0]?.seq).toBeUndefined()
    expect((received[0]?.payload as { data: string }).data).toContain('已在传输层截断')
    // transient 不占 seq：后续 stream 消息从 seq 1 起
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } })
    expect(sentMessages_m3(ws)[1]?.seq).toBe(1)
  })

  it('小消息完全不受影响：未注册类型小消息内容逐字节原样（零开销路径，stringify 恰好 1 次——w09 TC-V1 契约）', () => {
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    const bus = new MessageBus(100, SMALL_OPTS_m2)
    const ws = makeClient_m4()
    bus.subscribe('s1', ws)
    const msg: ServerMessage = { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }
    const before = JSON.stringify(msg)
    stringifySpy.mockClear()
    bus.publish('s1', msg)
    // 单条消息全程恰好 1 次 stringify（检查测量复用广播序列化，小消息零额外开销）
    expect(stringifySpy).toHaveBeenCalledTimes(1)
    stringifySpy.mockRestore()
    const received = sentMessages_m3(ws)
    expect(received).toHaveLength(1)
    expect(received[0]?.payload).toEqual({ sessionId: 's1', stopReason: 'end_turn' })
    expect(JSON.stringify({ type: received[0]?.type, payload: received[0]?.payload })).toBe(before)
  })

  it('序列化失败（循环引用）零抛错：丢弃 + seq 回滚（后续消息 seq 连续，不产生断裂）', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new MessageBus(100, SMALL_OPTS_m2)
    const ws = makeClient_m4()
    bus.subscribe('s1', ws)
    const cyclic: Record<string, unknown> = { type: 'message.complete' }
    cyclic['payload'] = { sessionId: 's1', self: cyclic }
    expect(() => bus.publish('s1', cyclic as unknown as ServerMessage)).not.toThrow()
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } })
    const received = sentMessages_m3(ws)
    // 循环引用消息被丢且 seq 回滚（后续消息仍从 seq 1 起）
    expect(received).toHaveLength(1)
    expect(received[0]?.seq).toBe(1)
    expect(errorSpy).toHaveBeenCalledOnce()
  })
})
describe('ServerMessageBroker.reply 出站检查', () => {
  it('reply 超限 → 整帧替换 type:error + payload_too_large 错误 envelope（id 保留，前端 pending 可 reject 完成收尾）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient_m2()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices_m2, { warnBytes: 1024, truncateBytes: 4096 })

    broker.reply(ws, 'req-42', 'message.error', { sessionId: 's1', message: 'x'.repeat(5000) })

    expect(wsSent_m2(ws)).toHaveLength(1)
    const sent = JSON.parse(wsSent_m2(ws)[0][0] as string) as { type: string; id: string; payload: { code: string; message: string; sessionId?: string } }
    // 错误 envelope 形态（core pending.resolveEnvelope 的 reject 完成收尾前提：type==='error' + id 命中）
    expect(sent.type).toBe('error')
    expect(sent.id).toBe('req-42')
    expect(sent.payload.code).toBe('payload_too_large')
    expect(sent.payload.message).toContain('加载更早')
    expect(sent.payload.message).toContain('session 文件')
    expect(sent.payload.sessionId).toBe('s1')
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('reply 超限 + 注入 resolver → 错误 envelope message 含 resolver 解析的 session 文件实路径（u8 两通路接线对称）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient_m2()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices_m2, {
      warnBytes: 1024,
      truncateBytes: 4096,
      resolveSessionFilePath: (sid) => (sid === 's1' ? '/data/agent/sessions/x/1_s1.jsonl' : null),
    })

    broker.reply(ws, 'req-50', 'message.error', { sessionId: 's1', message: 'x'.repeat(5000) })

    expect(wsSent_m2(ws)).toHaveLength(1)
    const sent = JSON.parse(wsSent_m2(ws)[0][0] as string) as { payload: { code: string; message: string } }
    expect(sent.payload.code).toBe('payload_too_large')
    expect(sent.payload.message).toContain('/data/agent/sessions/x/1_s1.jsonl')
    expect(sent.payload.message).not.toContain('（见 runtime 日志）')
  })

  it('reply 超限 + 未注入 resolver（默认）→ message 退化为「（见 runtime 日志）」占位（回归保护）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient_m2()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices_m2, { warnBytes: 1024, truncateBytes: 4096 })

    broker.reply(ws, 'req-51', 'message.error', { sessionId: 's1', message: 'x'.repeat(5000) })

    expect(wsSent_m2(ws)).toHaveLength(1)
    const sent = JSON.parse(wsSent_m2(ws)[0][0] as string) as { payload: { code: string; message: string } }
    expect(sent.payload.code).toBe('payload_too_large')
    expect(sent.payload.message).toContain('（见 runtime 日志）')
  })

  it('reply 介于告警/截断档之间 → warn 日志但原样送达；小 reply 零日志零改动', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient_m2()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices_m2, { warnBytes: 1024, truncateBytes: 4096 })

    // 告警档：原样送达（type 保持 message.error）
    broker.reply(ws, 'req-1', 'message.error', { sessionId: 's1', message: 'y'.repeat(2000) })
    const warned = JSON.parse(wsSent_m2(ws)[0][0] as string) as { type: string; payload: { message: string } }
    expect(warned.type).toBe('message.error')
    expect(warned.payload.message).toBe('y'.repeat(2000))
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // 小 reply：零日志、原样
    warnSpy.mockClear()
    broker.reply(ws, 'req-2', 'message.complete', { sessionId: 's1', stopReason: 'end_turn' })
    const small = JSON.parse(wsSent_m2(ws)[1][0] as string) as { type: string; id: string }
    expect(small.type).toBe('message.complete')
    expect(small.id).toBe('req-2')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('reply 序列化失败（循环引用）→ 复用 error envelope 完成收尾，不抛错不悬挂', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ws = makeWsClient_m2()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices_m2, { warnBytes: 1024, truncateBytes: 4096 })

    const cyclic: Record<string, unknown> = { sessionId: 's1' }
    cyclic['self'] = cyclic
    expect(() => broker.reply(ws, 'req-9', 'message.error', cyclic as never)).not.toThrow()

    const sent = JSON.parse(wsSent_m2(ws)[0][0] as string) as { type: string; id: string; payload: { code: string } }
    expect(sent.type).toBe('error')
    expect(sent.id).toBe('req-9')
    expect(sent.payload.code).toBe('reply_serialization_failed')
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('生产默认阈值 = shared 常量（无参构造可发送 8KB 级 reply——低于 8MB 告警档零日志）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient_m2()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices_m2)
    broker.reply(ws, 'req-3', 'message.error', { sessionId: 's1', message: 'z'.repeat(8 * 1024) })
    expect(wsSent_m2(ws)).toHaveLength(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('formatReplyOversizeMessage 含体积与恢复指引（reply/push 两通路文案契约）', () => {
    const msg = formatReplyOversizeMessage(5 * 1024 * 1024, 's1', SMALL_OPTS_m2)
    expect(msg).toContain('5.0 MB')
    expect(msg).toContain('加载更早')
    expect(msg).toContain('（见 runtime 日志）')
  })
})
});

// ======================================================================
// ← src/services/message-bus/__tests__/state-type-key-map-guard.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('state-type-key-map-guard', () => {
describe('state-type-key-map-guard', () => {
/**
 * TOPIC_TABLE ↔ STATE_TYPE_KEY_MAP 一致性检查（code-harden RT-1#5）。
 *
 * 此前风险只在 message-bus.ts 注释里自认（「state 类未映射 typeKey 则静默不写快照，
 * 重连派生视图失效」），无机器检查——新增 state 类型漏登记 STATE_TYPE_KEY_MAP 时零红灯、
 * 零日志。本文件把该风险变成测试期检查：
 *
 * 不变量：TOPIC_TABLE 中每个 'state' 类 type 的 typeKey 出处必须三居其一（scheduler-widget-push
 * D3 扩展为两形态登记 + 例外白名单）：
 * ① 静态映射——STATE_TYPE_KEY_MAP 有 typeKey（type → 固定 key，写快照、重连可回放）；
 * ② 派生登记——STATE_TYPE_KEY_PAYLOAD_DERIVED 有派生函数（type → 从 payload 派生 key，
 *    widget 帧的 (session, widgetKey) 粒度去重）；派生 miss（如 widgetKey 缺失/空串）时
 *    运行时按 state-no-key 同款处理（不入快照 + warn 一次，live 不变）；
 * ③ 例外白名单——STATE_NO_KEY_TOPICS 显式登记（带设计理由，现仅
 *    session.subagentEntriesAppended 一例：增量流非 last-value，靠 reducer 幂等 + 快照拉取对账）。
 * 三者都不满足 = 漂移，本测试红。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/message-bus/__tests__/state-type-key-map-guard.test.ts
 */
describe('TOPIC_TABLE ↔ STATE_TYPE_KEY_MAP 一致性检查（RT-1#5）', () => {
  it('每个 state 类 type 都有 typeKey 出处（静态映射 / 派生登记 / 例外白名单三居其一，漏登记即红）', () => {
    const drift: string[] = []
    for (const [type, kind] of Object.entries(TOPIC_TABLE)) {
      if (kind !== 'state') continue
      if (STATE_NO_KEY_TOPICS.has(type)) continue
      if (type in STATE_TYPE_KEY_MAP) continue
      if (type in STATE_TYPE_KEY_PAYLOAD_DERIVED) continue
      drift.push(type)
    }
    expect(
      drift,
      `state 类 type 无 typeKey 出处（重连派生视图将静默失效）：${drift.join(', ')}——补静态映射 STATE_TYPE_KEY_MAP，或载荷派生形态登记进 STATE_TYPE_KEY_PAYLOAD_DERIVED，或确属 state-no-key 形态时登记进 STATE_NO_KEY_TOPICS 并附理由`,
    ).toEqual([])
  })

  it('例外白名单不空转：每项都真实登记为 state 类（例外清单自身不漂移）', () => {
    const stale: string[] = []
    for (const type of STATE_NO_KEY_TOPICS) {
      if (TOPIC_TABLE[type] !== 'state') stale.push(type)
    }
    expect(
      stale,
      `STATE_NO_KEY_TOPICS 存在非 state 类条目（例外已失效，应移除）：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('STATE_TYPE_KEY_MAP 不含非 state 类条目（映射表自身不漂移）', () => {
    const stale: string[] = []
    for (const type of Object.keys(STATE_TYPE_KEY_MAP)) {
      if (TOPIC_TABLE[type] !== 'state') stale.push(type)
    }
    expect(
      stale,
      `STATE_TYPE_KEY_MAP 存在 TOPIC_TABLE 未登记为 state 类的条目：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('STATE_TYPE_KEY_PAYLOAD_DERIVED 不含非 state 类条目（派生登记表自身不漂移）', () => {
    const stale: string[] = []
    for (const type of Object.keys(STATE_TYPE_KEY_PAYLOAD_DERIVED)) {
      if (TOPIC_TABLE[type] !== 'state') stale.push(type)
    }
    expect(
      stale,
      `STATE_TYPE_KEY_PAYLOAD_DERIVED 存在 TOPIC_TABLE 未登记为 state 类的条目：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('已知例外 session.subagentEntriesAppended 在白名单内（锚定既有 state-no-key 形态）', () => {
    expect(STATE_NO_KEY_TOPICS.has('session.subagentEntriesAppended')).toBe(true)
  })

  it('widget 两类型在派生登记表内（锚定 scheduler-widget-push D3 的载荷派生形态）', () => {
    // 锚定意图：widget 帧的快照去重粒度是 (session, widgetKey)，必须走派生登记而非
    // 静态 key（静态 key 会让同 session 多个 widget 互相覆盖）。若未来改回静态映射
    // 或移除派生登记，本断言红——改动者须确认快照粒度语义后同步本文件。
    expect('extension:widget' in STATE_TYPE_KEY_PAYLOAD_DERIVED).toBe(true)
    expect('extension:widgetGui' in STATE_TYPE_KEY_PAYLOAD_DERIVED).toBe(true)
    // 不应同时出现在静态表（一 type 只一形态，防双源歧义）
    expect('extension:widget' in STATE_TYPE_KEY_MAP).toBe(false)
    expect('extension:widgetGui' in STATE_TYPE_KEY_MAP).toBe(false)
  })
})

describe('btw.* TOPIC/STATE 登记锚定（btw-question D6，M2-a；W4b 线枚举帧退役）', () => {
  it('btw.create / btw.remove 纯 RPC reply 不入 TOPIC_TABLE（D6：btw 域无 publish 面）', () => {
    // 锚定意图：create/remove 走 reply 通道（同名 request/reply，broker.reply 直发），
    // 从不经 bus.publish——入表即误导（topicOf 对 reply 无意义，state 登记会造出永空的
    // 快照槽位）。原 btw.list 的 state 登记（typeKey 'btw'）随该消息退役删除：btw 线进
    // 通用列表（session.list {surface:'btw', mainSessionId}，设计 §3.3.1/§5-W4b），
    // create/remove 后不再 publish 线列表帧。若未来确需广播，须先裁决语义再改本断言。
    expect('btw.create' in TOPIC_TABLE).toBe(false)
    expect('btw.remove' in TOPIC_TABLE).toBe(false)
    expect('btw.create' in STATE_TYPE_KEY_MAP).toBe(false)
    expect('btw.remove' in STATE_TYPE_KEY_MAP).toBe(false)
  })

  it('btw.list 已退役：三张登记表（TOPIC_TABLE / STATE_TYPE_KEY_MAP / 派生表 / 例外白名单）零残留', () => {
    // 锚定意图：线枚举消息与其 state 广播面整体收缩——任何一张表残留 'btw.list' 登记
    // 都意味着「零订阅方的死消息面」复活（协议已删、publish 点已删，登记表是最后漏网点）。
    expect('btw.list' in TOPIC_TABLE).toBe(false)
    expect('btw.list' in STATE_TYPE_KEY_MAP).toBe(false)
    expect('btw.list' in STATE_TYPE_KEY_PAYLOAD_DERIVED).toBe(false)
    expect(STATE_NO_KEY_TOPICS.has('btw.list')).toBe(false)
  })
})
})
describe('message-bus-occupancy', () => {
/**
 * message-bus × session.occupancy state topic 单测（session-occupancy-send-closure u5a-p3-runtime ③）。
 *
 * 锁定 TOPIC_TABLE['session.occupancy']='state' + STATE_TYPE_KEY_MAP['session.occupancy']='occupancy'
 * 的机制生效（写快照 / 回放），不重复 MessageBus 通用机制测试（message-bus.test.ts）：
 * - publish occupancy 帧 → 分配 seq + 写 stateSnapshot（key='occupancy'）+ 不入 ring
 * - last-value 覆盖：同 key 两次 publish，快照只留最新
 * - 重连回放：subscribe 返回的 stateSnapshot 含 occupancy 帧（G4 断连/切回恢复）
 * - 非快照帧（stream 类）不覆盖 occupancy key（快照按 typeKey 分区）
 *
 * 运行：cd packages/runtime && npx vitest run test/message-bus-occupancy.test.ts
 */
function occupancyFrame(turn: string, seq?: number): ServerMessage {
  return {
    type: 'session.occupancy',
    ...(seq !== undefined ? { seq } : {}),
    payload: { sessionId: 's1', turn, compacting: false, bash: false },
  } as ServerMessage
}

function makeWs() {
  return { readyState: 1, send: vi.fn() }
}

describe('MessageBus · session.occupancy state topic', () => {
  it('publish occupancy 帧：分配 seq + 写 stateSnapshot（key=occupancy）+ 不入 ring + 推订阅者', () => {
    const bus = new MessageBus()
    const ws = makeWs()
    bus.subscribe('s1', ws)
    bus.publish('s1', occupancyFrame('dispatching'))
    expect(ws.send).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string) as ServerMessage
    expect(sent.type).toBe('session.occupancy')
    expect(sent.seq).toBe(1)
    // 快照写入 + 不入 ring：重订阅回放只见 stateSnapshot，ring snapshot 为空
    bus.unsubscribe('s1', ws)
    const replay = bus.subscribe('s1', makeWs())
    expect(replay.snapshot).toHaveLength(0)
    expect(replay.stateSnapshot.map((m) => m.type)).toEqual(['session.occupancy'])
    expect(replay.lastSeq).toBe(1)
  })

  it('last-value 覆盖：同 key 两次 publish 快照只留最新（状态去重语义）', () => {
    const bus = new MessageBus()
    bus.publish('s1', occupancyFrame('dispatching'))
    bus.publish('s1', occupancyFrame('generating'))
    const { stateSnapshot, lastSeq } = bus.subscribe('s1', makeWs())
    expect(stateSnapshot).toHaveLength(1)
    expect((stateSnapshot[0].payload as { turn: string }).turn).toBe('generating')
    expect(lastSeq).toBe(2)
  })

  it('重连回放（G4）：断连前占用中（generating+compacting），重连 subscribe 从快照恢复同值', () => {
    const bus = new MessageBus()
    const wsA = makeWs()
    bus.subscribe('s1', wsA)
    bus.publish('s1', {
      type: 'session.occupancy',
      payload: { sessionId: 's1', turn: 'generating', compacting: true, bash: false },
    } as ServerMessage)
    bus.unsubscribeAll(wsA) // 断连
    // 重连：新 ws 订阅，从 stateSnapshot 恢复占用派生视图（不依赖当时的 live 广播）
    const wsB = makeWs()
    const replay = bus.subscribe('s1', wsB)
    expect(replay.stateSnapshot).toHaveLength(1)
    expect(replay.stateSnapshot[0].payload).toEqual({
      sessionId: 's1', turn: 'generating', compacting: true, bash: false,
    })
  })

  it('快照按 typeKey 分区：stream 类帧不覆盖 occupancy key，occupancy 不冲刷 ring', () => {
    const bus = new MessageBus()
    bus.publish('s1', occupancyFrame('generating'))
    bus.publish('s1', { type: 'message.error', payload: { sessionId: 's1', message: 'x' } } as ServerMessage)
    bus.publish('s1', { type: 'session.state_changed', payload: { sessionId: 's1' } } as unknown as ServerMessage)
    const { stateSnapshot, snapshot } = bus.subscribe('s1', makeWs())
    const keys = stateSnapshot.map((m) => m.type)
    expect(keys).toContain('session.occupancy')
    expect(keys).toContain('session.state_changed')
    expect(stateSnapshot.filter((m) => m.type === 'session.occupancy')).toHaveLength(1)
    // occupancy 是 state 类不入 ring：ring 只含 message.error（stream 类）
    expect(snapshot.map((m) => m.type)).toEqual(['message.error'])
  })

  it('clearSession 清 occupancy 快照（session 销毁 / respawn 清场：无帧 = idle 缺省）', () => {
    const bus = new MessageBus()
    bus.publish('s1', occupancyFrame('generating'))
    bus.clearSession('s1')
    const { stateSnapshot } = bus.subscribe('s1', makeWs())
    expect(stateSnapshot).toHaveLength(0)
  })
})
})
});
