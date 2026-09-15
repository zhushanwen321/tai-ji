/**
 * u8-pi-respawn / 实施计划偏差表 D1 移交接线测试：MessageBus 构造第二参注入
 * resolveSessionFilePath（u4a outbound-frame-registry 的注入点）后，占位文案路径解析生效。
 *
 * 断言：
 * - 构造带 resolver 的 MessageBus，publish 超截断档的注册表帧（message.bashResult）→
 *   订阅者收到截断版占位文案含 session 文件实路径（生产路径从「（见 runtime 日志）」升级）；
 * - resolver 抛错/返回空 → 占位退化「（见 runtime 日志）」（resolvePathSafe 既有契约不回归）。
 *
 * 组合根（index.ts）的 resolver 闭包（活跃 session 直读 sessionFilePath / 冷 session 扫盘
 * 兜底）随 index.ts `import 即执行 main()` 不可直测，其正确性由组合根 code review +
 * typecheck 保证；本文件锁定的是注入点消费端契约（u4a 测试模式参考，SMALL_OPTS 同型）。
 * 纯内存逻辑，不触 fs。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { MessageBus } from '../src/services/message-bus/message-bus.js'
import type { BusClient } from '../src/services/message-bus/types.js'

const SMALL_OPTS = { warnBytes: 1024, truncateBytes: 4096 }

function makeClient(): BusClient & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as BusClient & { send: ReturnType<typeof vi.fn> }
}

function sentMessages(client: ReturnType<typeof makeClient>): ServerMessage[] {
  return client.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('D1 移交接线：MessageBus 第二参 resolveSessionFilePath', () => {
  it('注入 resolver 后，超限截断占位文案携带 session 文件实路径（订阅者视角）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bus = new MessageBus(1000, {
      ...SMALL_OPTS,
      resolveSessionFilePath: (sessionId) =>
        sessionId === 's1' ? '/data/agent/sessions/x/1_s1.jsonl' : null,
    })
    const ws = makeClient()
    bus.subscribe('s1', ws)
    // message.bashResult：LARGE_FIELD_REGISTRY 登记的 string 类大字段帧（u4a 穷举表）
    bus.publish('s1', {
      type: 'message.bashResult',
      payload: { sessionId: 's1', output: 'x'.repeat(5000), command: 'cat big.log', exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
    } as unknown as ServerMessage)
    const received = sentMessages(ws)
    expect(received).toHaveLength(1)
    const note = (received[0].payload as { output: string }).output
    expect(note).toContain('/data/agent/sessions/x/1_s1.jsonl')
    expect(note).not.toContain('（见 runtime 日志）')
    expect(warnSpy).toHaveBeenCalled() // 截断 warn 哨兵照常
  })

  it('resolver 返回 null / 抛错 → 占位退化为「（见 runtime 日志）」（resolvePathSafe 契约不回归）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new MessageBus(1000, {
      ...SMALL_OPTS,
      resolveSessionFilePath: (sessionId) => {
        if (sessionId === 'boom') throw new Error('resolver exploded')
        return undefined
      },
    })
    const ws = makeClient()
    bus.subscribe('s2', ws)
    const wsBoom = makeClient()
    bus.subscribe('boom', wsBoom)
    const mkFrame = (sid: string): ServerMessage =>
      ({
        type: 'message.bashResult',
        payload: { sessionId: sid, output: 'x'.repeat(5000), command: 'c', exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
      }) as unknown as ServerMessage
    bus.publish('s2', mkFrame('s2'))
    bus.publish('boom', mkFrame('boom'))
    for (const wsCase of [ws, wsBoom]) {
      const note = (sentMessages(wsCase)[0].payload as { output: string }).output
      expect(note).toContain('（见 runtime 日志）')
    }
  })
})
