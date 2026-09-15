/**
 * ServerMessageBroker W3 单元测试（U9）。
 *
 * 覆盖 M6：broadcast 单 ws.send 抛错中断其余 client。
 *
 * 场景：
 * - broker 池中有 3 个 ws：ws1（send 抛 Error）、ws2/ws3（send 正常）
 * - 所有 ws.readyState = WebSocket.OPEN
 * - 调 broker.broadcast(msg)
 * - 修复前：ws1.send 抛错，for 循环中断，ws2/ws3 收不到消息
 * - 修复后：ws1 抛错被 try-catch 吞掉，ws2/ws3 正常收到
 *
 * 测试策略：直接构造 broker，注入 mock 的 ClientPool（含 mock ws）和 BrokerServices，
 * 不依赖真实 WebSocket / ConnectionManager。
 */
import { describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientPool, BrokerServices, ServerMessageBroker as BrokerType } from '../src/transport/message-broker.js'

// ── Mock ws 工厂 ───────────────────────────────────────────────────

/** 构造一个 mock ws：readyState=OPEN，send 为 vi.fn（可配置抛错）。 */
function makeMockWs(opts: { throws?: boolean } = {}): WebSocket {
  const sendFn = opts.throws
    ? vi.fn(() => { throw new Error('connection closed (TOCTOU)') })
    : vi.fn()
  return {
    readyState: WebSocket.OPEN,
    send: sendFn,
  } as unknown as WebSocket
}

// ── Mock BrokerServices（broadcast 不读 services，但构造需要满足类型） ──

const mockServices = {
  sessionService: { listPersistedSessions: () => [] },
  configService: {
    listProviders: () => [],
    getDefaultModel: () => null,
    loadSkills: () => [],
    loadAgents: () => [],
    getSkillDirs: () => [],
    getAgentDirs: () => [],
  },
  modelService: { aggregateModels: () => [] },
  pluginService: undefined,
  extensionService: undefined,
  projectRoot: '/mock',
  appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
} as unknown as BrokerServices

// ── Tests ──────────────────────────────────────────────────────────

describe('ServerMessageBroker W3 M6 (broadcast try-catch)', () => {
  it('U9: single ws.send throw does not interrupt broadcast to other clients', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const ws1 = makeMockWs({ throws: true })
    const ws2 = makeMockWs()
    const ws3 = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws1, ws2, ws3]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'session.list', id: 'push_1', payload: { groups: [] } } as unknown as Parameters<BrokerType['broadcast']>[0]

    // broadcast 不应抛错（即使 ws1.send 抛）
    expect(() => broker.broadcast(msg)).not.toThrow()

    // ws2/ws3 的 send 应被调用（未被 ws1 抛错中断）
    expect(vi.mocked(ws2.send)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ws3.send)).toHaveBeenCalledTimes(1)

    // ws1 也尝试调用了（只是抛错被吞）
    expect(vi.mocked(ws1.send)).toHaveBeenCalledTimes(1)

    // 验证传给 ws2 的 payload 是序列化后的 msg
    const sent2 = vi.mocked(ws2.send).mock.calls[0][0]
    expect(JSON.parse(sent2 as string)).toEqual(msg)
  })

  it('U9b: broadcast with all clients throwing completes without throwing', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const ws1 = makeMockWs({ throws: true })
    const ws2 = makeMockWs({ throws: true })
    const pool: ClientPool = { clients: new Set([ws1, ws2]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'session.list', id: 'push_1', payload: { groups: [] } } as unknown as Parameters<BrokerType['broadcast']>[0]

    // 所有 client 都抛错，broadcast 自身不抛
    expect(() => broker.broadcast(msg)).not.toThrow()
  })
})

/**
 * L6（perf-quick-batch）：broadcast 单次 stringify。
 *
 * 现状缺陷：broadcast 循环内对每个 client 调 this.send → send 内 JSON.stringify(msg)，
 * N 个客户端 = N 次重复序列化同一对象。高并发广播 + 大 payload（如 session.list）
 * 下主线程被重复 stringify 阻塞。
 *
 * 修复目标：循环外 stringify 一次得 payload 字符串，循环内 ws.send(payload) 直接发送。
 * - stringify 调用次数恒为 1（与 N 无关）
 * - 单 client send 抛错仍不影响其余（复用 U9 的 try-catch 语义）
 * - 各客户端收到逐字节一致 payload
 *
 * [红灯] 当前实现循环内逐 client stringify，N=3 时 stringify 被调 3 次 ≠ 1 → fail。
 */
describe('ServerMessageBroker L6 (broadcast 单次 stringify)', () => {
  it('L6-1: N 客户端 broadcast 时 JSON.stringify 恒调用 1 次（与 N 无关）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const stringifySpy = vi.spyOn(JSON, 'stringify')

    const ws1 = makeMockWs()
    const ws2 = makeMockWs()
    const ws3 = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws1, ws2, ws3]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'session.list', id: 'push_l6', payload: { groups: [] } } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    // 核心断言：3 个客户端，stringify 只调 1 次（循环外提取）。当前实现调 3 次 → 红灯。
    expect(stringifySpy).toHaveBeenCalledTimes(1)

    stringifySpy.mockRestore()
  })

  it('L6-2: 单 client stringify 仍只 1 次（N=1 边界）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const stringifySpy = vi.spyOn(JSON, 'stringify')

    const ws1 = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws1]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'app.info', id: 'push_l6b', payload: { appVersion: '1.0.0', piVersion: '0.80.3' } } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    expect(stringifySpy).toHaveBeenCalledTimes(1)
    stringifySpy.mockRestore()
  })

  it('L6-3: 各客户端收到逐字节一致 payload（含中文/emoji）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const ws1 = makeMockWs()
    const ws2 = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws1, ws2]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    // 含 Unicode 字符，验证序列化结果一致性（不是每客户端独立序列化导致潜在差异）
    const msg = { type: 'error', id: 'push_l6c', payload: { code: 'ERR_测试', message: '失败 emoji 🚀' } } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    const sent1 = vi.mocked(ws1.send).mock.calls[0][0]
    const sent2 = vi.mocked(ws2.send).mock.calls[0][0]
    // 两客户端收到完全相同的字符串
    expect(sent1).toBe(sent2)
    // 且可反序列化回原 msg
    expect(JSON.parse(sent1 as string)).toEqual(msg)
  })
})
