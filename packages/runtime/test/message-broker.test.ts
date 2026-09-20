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
import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientPool, BrokerServices, ServerMessageBroker as BrokerType } from '../src/transport/message-broker.js'

// ── Mock ws 工厂 ───────────────────────────────────────────────────

/** 构造一个 mock ws：readyState=OPEN，send 为 vi.fn（可配置抛错 / bufferedAmount）。 */
function makeMockWs(opts: { throws?: boolean; bufferedAmount?: number } = {}): WebSocket {
  const sendFn = opts.throws
    ? vi.fn(() => { throw new Error('connection closed (TOCTOU)') })
    : vi.fn()
  return {
    readyState: WebSocket.OPEN,
    send: sendFn,
    ...(opts.bufferedAmount !== undefined ? { bufferedAmount: opts.bufferedAmount } : {}),
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

/**
 * RT-1#8：send() 的 stringify 守卫（照 reply :168-174 形态）。
 *
 * send 是 sendError 的最后手段路径（sendError → this.send(error envelope)）——
 * 序列化失败若直抛，异常沿调用方冒泡且 error envelope 无从发出。守卫收口为
 * error envelope：新 envelope 是受控构造的纯字符串 payload，序列化不再失败（结构上不递归）。
 */
describe('ServerMessageBroker RT-1#8 (send stringify 守卫)', () => {
  it('循环引用 payload → send 不抛，改发 error envelope（code=send_serialization_failed）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ws = makeMockWs()
      const pool: ClientPool = { clients: new Set([ws]) }
      const broker = new ServerMessageBroker(pool, mockServices)

      const cyclic: Record<string, unknown> = { type: 'app.info', id: 'x' }
      cyclic.payload = { self: cyclic }
      const msg = cyclic as unknown as Parameters<BrokerType['send']>[1]

      // 修复前：JSON.stringify 抛 TypeError 直接冒泡给调用方（含 sendError 路径）
      expect(() => broker.send(ws, msg)).not.toThrow()

      // 原 msg 未发出；发出的唯一一帧是 error envelope
      expect(vi.mocked(ws.send)).toHaveBeenCalledTimes(1)
      const sent = JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string) as {
        type: string
        payload: { code: string; message: string }
      }
      expect(sent.type).toBe('error')
      expect(sent.payload.code).toBe('send_serialization_failed')
      // 守卫留痕
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('send serialization failed'), expect.any(TypeError))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('正常 payload → send 原样序列化发送（守卫零行为变化）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const ws = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws]) }
    const broker = new ServerMessageBroker(pool, mockServices)

    const msg = { type: 'app.info', id: 'p1', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['send']>[1]
    broker.send(ws, msg)

    expect(vi.mocked(ws.send)).toHaveBeenCalledTimes(1)
    expect(JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string)).toEqual(msg)
  })
})

/**
 * RT-1#7：发送侧背压观测（bufferedAmount 超阈值 warn，每 socket 每次越限一条）。
 * 量级依据与去重语义见 src/utils/backpressure-warn.ts 模块注释。
 */
describe('ServerMessageBroker RT-1#7 (bufferedAmount 背压 warn)', () => {
  it('send 路径：bufferedAmount 超阈值 → warn 一条（含字节数）；持续超阈值不重复', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ws = makeMockWs({ bufferedAmount: 2 * 1024 * 1024 })
      const pool: ClientPool = { clients: new Set([ws]) }
      const broker = new ServerMessageBroker(pool, mockServices)
      const msg = { type: 'app.info', id: 'p1', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['send']>[1]

      broker.send(ws, msg)
      broker.send(ws, msg)
      broker.send(ws, msg)

      // 同一 socket 持续超阈值态：只 warn 一次
      const backpressureWarns = warnSpy.mock.calls.filter(([m]) => String(m).includes('[backpressure]'))
      expect(backpressureWarns).toHaveLength(1)
      expect(String(backpressureWarns[0][0])).toContain('channel=send')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('send 路径：水位降回阈值内后再次越限 → 再 warn（状态翻转去重）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 可变 bufferedAmount 的 ws mock（模拟对端消费后水位回落）
      const ws = { readyState: WebSocket.OPEN, send: vi.fn(), bufferedAmount: 2 * 1024 * 1024 } as unknown as WebSocket
      const pool: ClientPool = { clients: new Set([ws]) }
      const broker = new ServerMessageBroker(pool, mockServices)
      const msg = { type: 'app.info', id: 'p1', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['send']>[1]

      broker.send(ws, msg) // 越限 → warn #1
      ;(ws as { bufferedAmount: number }).bufferedAmount = 0
      broker.send(ws, msg) // 回落 → 无 warn，状态复位
      ;(ws as { bufferedAmount: number }).bufferedAmount = 2 * 1024 * 1024
      broker.send(ws, msg) // 再次越限 → warn #2

      const backpressureWarns = warnSpy.mock.calls.filter(([m]) => String(m).includes('[backpressure]'))
      expect(backpressureWarns).toHaveLength(2)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('broadcast 路径：单个积压 client warn，不影响其余 client 收帧', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ws1 = makeMockWs({ bufferedAmount: 3 * 1024 * 1024 })
      const ws2 = makeMockWs()
      const pool: ClientPool = { clients: new Set([ws1, ws2]) }
      const broker = new ServerMessageBroker(pool, mockServices)
      const msg = { type: 'app.info', id: 'push_bp', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['broadcast']>[0]

      broker.broadcast(msg)

      // 积压 client 触发 warn，正常 client 照常收帧
      expect(warnSpy.mock.calls.some(([m]) => String(m).includes('[backpressure]') && String(m).includes('channel=broadcast'))).toBe(true)
      expect(vi.mocked(ws2.send)).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('bufferedAmount 缺省（mock/非 WS 契约）→ no-op，不 warn 不抛', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // makeMockWs 不传 bufferedAmount 时属性缺省
      const ws = makeMockWs()
      const pool: ClientPool = { clients: new Set([ws]) }
      const broker = new ServerMessageBroker(pool, mockServices)
      const msg = { type: 'app.info', id: 'p1', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['send']>[1]

      expect(() => broker.send(ws, msg)).not.toThrow()
      expect(warnSpy.mock.calls.some(([m]) => String(m).includes('[backpressure]'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('ServerMessageBroker broadcast 哨兵豁免清单（AP-2）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 构造单 client broker + console.warn spy */
  async function buildWithWarnSpy() {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeMockWs()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices)
    return { broker, ws, warnSpy }
  }

  it.each([
    'plugin:modalState',
    'plugin:headerActionUpdate',
  ] as const)('豁免帧 %s：payload 带 sessionId 的全局广播不触发哨兵告警，帧照常下发', async (type) => {
    const { broker, ws, warnSpy } = await buildWithWarnSpy()
    const msg = {
      type,
      id: 'push_exempt',
      payload: { pluginId: 'p1', sessionId: 's1', state: 'open', epoch: 1 },
    } as unknown as Parameters<BrokerType['broadcast']>[0]

    expect(() => broker.broadcast(msg)).not.toThrow()

    expect(warnSpy).not.toHaveBeenCalled()
    expect(vi.mocked(ws.send)).toHaveBeenCalledTimes(1)
  })

  it('清单外帧 payload 带 sessionId 仍触发哨兵告警（豁免不漏放宽）', async () => {
    const { broker, warnSpy } = await buildWithWarnSpy()
    const msg = {
      type: 'session.list',
      id: 'push_guard',
      payload: { groups: [], sessionId: 's1' },
    } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('use IMessageBus.publish instead')
  })

  it('豁免帧 payload 无 sessionId（异常构造）不触发告警（哨兵本就只看 sessionId 存在性）', async () => {
    const { broker, warnSpy } = await buildWithWarnSpy()
    const msg = {
      type: 'plugin:modalState',
      id: 'push_nosid',
      payload: { pluginId: 'p1', state: 'open', epoch: 1 },
    } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    expect(warnSpy).not.toHaveBeenCalled()
  })
})
