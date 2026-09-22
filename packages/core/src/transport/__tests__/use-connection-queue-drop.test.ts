/**
 * pre-auth 队列丢弃 → pending 立即 reject 的生产接线（onQueueDrop 消费方，use-connection 侧）。
 *
 * 分工：ws-client.invariants.test.ts ⑥ 锁定 ws-client 侧广播（清队时机 / reason / 队列
 * 边界）；本文件锁定 use-connection 消费侧接线：
 * - auth 失败（reason='auth-failed'）清队 → 带 id 消息的 pending **立即** reject
 *   （同步回调内完成，不等 request 层 65s sweep）
 * - 无 id 消息安全跳过（无 pending 可收）
 * - teardown 注销 onQueueDrop 单槽；二次 init/teardown 不泄漏、不重复 reject
 * - mock 模式也注册（对齐 stateWatch「任何模式都安装」——disconnect() 同样走清队路径）
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-queue-drop.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ClientMessage } from '@taiji/shared'
import type { ConnectionState } from '../ws-client'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'

// ── ws-client mock：state ref 直驱 + onQueueDrop 单槽（对齐真实实现的 last-writer-wins）──
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
let mockStateRef: Ref<ConnectionState> = ref('disconnected')
let queueDropCb: ((msgs: ClientMessage[], reason: string) => void) | null = null
vi.mock('../ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onQueueDrop: (cb: (msgs: ClientMessage[], reason: string) => void) => {
    queueDropCb = cb
    return () => {
      if (queueDropCb === cb) queueDropCb = null
    }
  },
}))

const mockReject = vi.fn()
const mockT = vi.fn((key: string) => `[${key}]`)

// pending 模块 mock（D3 后 use-connection 的 reject 直连 transport/api/pending，
// 不再经 ConnectionPorts 注入——mock 须拦截模块本身；闭包转发 mockReject，
// 工厂执行早于 const 初始化，惰性解引用避开 TDZ）
vi.mock('../api/pending', () => ({
  reject: (...args: unknown[]) => mockReject(...args),
  rejectAll: vi.fn(),
  resolve: vi.fn(),
  has: vi.fn(),
  resolveEnvelope: vi.fn(),
}))

function makePorts(isMock: boolean): ConnectionPorts {
  return {
    ipc: {
      getRuntimePort: vi.fn().mockResolvedValue(undefined),
      getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
      getRuntimeToken: vi.fn().mockResolvedValue('tok'),
      onRuntimePort: () => () => {},
      onRuntimeRestarting: () => () => {},
      onRuntimeFailed: () => () => {},
      // RD-3#2：启动失败真因消费端口（推送置 failed 短路徒劳重连 + init 拉取兜底）
      onRuntimeError: () => () => {},
      getRuntimeStartError: async () => null,
      restartRuntime: vi.fn().mockResolvedValue(undefined),
    },
    visibility: {
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    },
    env: { isMock, isDev: false },
    effects: {},
    t: mockT,
    onRuntimeUnavailable: vi.fn(),
  }
}

/** 带 id 的 RPC 型 ClientMessage（生产 request.ts command() 同款形状，as 断言体例对齐 invariants ⑥） */
function rpcMsg(id?: string): ClientMessage {
  return { type: 'config.sessions', id, payload: {} } as ClientMessage
}

/** 断言某次 reject 调用的错误形状（Error 实例 + t() 文案 + code='disconnected'，对齐 stateWatch 断连分支） */
function expectDisconnectedReject(callIndex: number, id: string): void {
  const [actualId, actualErr] = mockReject.mock.calls[callIndex] as [string, Error & { code?: string }]
  expect(actualId).toBe(id)
  expect(actualErr).toBeInstanceOf(Error)
  expect(actualErr.message).toBe('[connection.disconnectedError]')
  expect(actualErr.code).toBe('disconnected')
}

describe('pre-auth 队列丢弃 → pending 立即 reject（onQueueDrop 生产接线）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef = ref('disconnected')
    queueDropCb = null
    setConnectionPorts(makePorts(false))
  })

  it('auth 失败清队 → 对应 pending 立即 reject（不等 65s sweep；错误同型 stateWatch 断连分支）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(queueDropCb).not.toBeNull()

    // ws-client 侧 auth.result ok:false → dropPreAuthQueue('auth-failed') 广播；此处直接驱动
    // 已注册的消费方回调（ws-client 侧链路已由 invariants ⑥ 锁定）。「立即」证明：无任何
    // timer 推进 / 微任务等待，同步断言 reject 已发生——旧行为要等 request 层 65s sweep。
    queueDropCb!([rpcMsg('q-auth-1'), rpcMsg('q-auth-2')], 'auth-failed')

    expect(mockReject).toHaveBeenCalledTimes(2)
    expectDisconnectedReject(0, 'q-auth-1')
    expectDisconnectedReject(1, 'q-auth-2')
    teardown()
  })

  it('无 id 消息安全跳过（不 reject、不抛错）；混合批次只收带 id 的', async () => {
    const { init, teardown } = useConnection()
    await init()

    queueDropCb!([{ type: 'ping', payload: {} }, rpcMsg('q-has-id'), rpcMsg()], 'closed')

    expect(mockReject).toHaveBeenCalledTimes(1)
    expectDisconnectedReject(0, 'q-has-id')
    teardown()
  })

  it('teardown 注销 onQueueDrop 单槽；二次 init/teardown 不泄漏、不重复 reject', async () => {
    const handle = useConnection()
    await handle.init()
    expect(queueDropCb).not.toBeNull()
    handle.teardown()
    // 取消函数已清空单槽：teardown 后 ws-client 侧清队广播无消费方
    expect(queueDropCb).toBeNull()

    // 二次 init：重新注册，一次 drop 只 reject 一次（不因前次生命周期残留而重复）
    await handle.init()
    expect(queueDropCb).not.toBeNull()
    queueDropCb!([rpcMsg('q-2nd')], 'disconnected')
    expect(mockReject).toHaveBeenCalledTimes(1)
    expectDisconnectedReject(0, 'q-2nd')
    handle.teardown()
    expect(queueDropCb).toBeNull()
  })

  it('mock 模式也注册（对齐 stateWatch 任何模式都安装——mock disconnect() 同样走清队路径）', async () => {
    setConnectionPorts(makePorts(true))
    const { init, teardown } = useConnection()
    await init()
    expect(queueDropCb).not.toBeNull()

    queueDropCb!([rpcMsg('q-mock')], 'disconnected')
    expect(mockReject).toHaveBeenCalledTimes(1)
    expectDisconnectedReject(0, 'q-mock')
    teardown()
  })
})
