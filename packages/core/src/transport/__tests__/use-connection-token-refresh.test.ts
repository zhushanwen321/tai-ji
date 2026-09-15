/**
 * runtime 重启 token 刷新编排测试（S1-W1 / MF-2）。
 *
 * 锁定 use-connection 的 refreshTokenAndConnect 编排半边（auth 链路的 renderer 侧）：
 * runtime 重启 = supervisor 重新 spawn = token 已刷新，旧 token 对新 runtime 的
 * auth 必失败（1008 → 重连循环直到 failed）。重连路径必须先经 IPC getRuntimeToken
 * 拿新值再 connect(url, newToken)——本文件钉住该编排，回归后果 = runtime 重启后
 * 应用失联。
 *
 * 覆盖：
 * - TC-T1: init 已知端口路径——connect 前先 IPC 取 token，connect(url, token)
 * - TC-T2: onRuntimePort 推新端口 → disconnect + 重新拉 token + connect(newUrl, newToken)
 * - TC-T3: getRuntimeToken 抛错 → warn 落日志 + 降级无 token 连接（仍 connect(url, undefined)）
 * - TC-T4: getRuntimeToken 返回 null → connect(url, undefined)（无凭据不阻断重连）
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-token-refresh.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import type { ConnectionState } from '../ws-client'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'
import { connect, disconnect } from '../ws-client'

// ── ws-client mock：捕获 connect/disconnect 调用 + 可控连接状态 ref ──
const mockStateRef = ref<ConnectionState>('disconnected')
let inboundHandler: ((msg: ServerMessage) => void) | null = null
vi.mock('../ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  onMessage: (cb: (msg: ServerMessage) => void) => {
    inboundHandler = cb
    return () => {
      inboundHandler = null
    }
  },
  onQueueDrop: vi.fn(() => () => {}),
}))

// ── 其余端口 mock（use-connection-reconnect-resubscribe.test.ts 同款）──
// D3 后 pending/events/subscribe 三件套不再经 ConnectionPorts 注入（dispatcher 缺省
// 直连 transport/api 真实模块）；本文件只断言 token 编排，三件套零断言依赖——
// 真实模块链加载即无副作用（ws-client 已 mock，domains/session→request 顶层零调用）。

/** 被测 IPC 桩：token 拉取可编程返回值；onRuntimePort 回调被捕获供测试触发 */
const getRuntimeToken = vi.fn<() => Promise<string | null | undefined>>()
let portCb: ((port: number) => void) | null = null

function makePorts(): ConnectionPorts {
  return {
    ipc: {
      getRuntimePort: vi.fn().mockResolvedValue(4000),
      getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
      getRuntimeToken,
      onRuntimePort: vi.fn((cb: (port: number) => void) => {
        portCb = cb
        return () => {
          portCb = null
        }
      }),
      onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
      onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
      restartRuntime: vi.fn().mockResolvedValue(undefined),
    },
    visibility: {
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    },
    env: { isMock: false, isDev: false },
    effects: {},
    t: vi.fn((key: string) => `[${key}]`),
    onRuntimeUnavailable: vi.fn(),
  }
}

beforeAll(() => {
  setConnectionPorts(makePorts())
})

beforeEach(() => {
  vi.clearAllMocks()
  getRuntimeToken.mockReset()
  // onRuntimePort 重连守卫要求 state !== 'disconnected'（runtime 存活期间常态为 connected）
  mockStateRef.value = 'connected'
})

/** 等 fire-and-forget 的 refreshTokenAndConnect 完成（IPC mock resolve + connect 微任务） */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('S1-W1: runtime 重启 token 刷新编排（refreshTokenAndConnect）', () => {
  it('TC-T1: init 已知端口路径——connect 前先 IPC 取 token，connect(url, token)', async () => {
    getRuntimeToken.mockResolvedValue('token-1')
    const { init } = useConnection()
    await init()
    // dispatcher 已安装（init 副作用，不与 token 编排耦合）
    expect(inboundHandler).not.toBeNull()
    // 首连凭据经 IPC 下发：getRuntimeToken 先于 connect，token 透传
    expect(getRuntimeToken).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4000', 'token-1')
  })

  it('TC-T2: onRuntimePort 推新端口 → disconnect + 重新拉 token + connect(newUrl, newToken)', async () => {
    getRuntimeToken.mockResolvedValue('token-2')
    portCb!(4500)
    await flushAsync()
    // 旧连接先断开
    expect(vi.mocked(disconnect)).toHaveBeenCalledTimes(1)
    // runtime 重启 = token 已刷新：重连前必须重新拉取（不得复用旧 token）
    expect(getRuntimeToken).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4500', 'token-2')
  })

  it('TC-T3: getRuntimeToken 抛错 → warn 落日志 + 降级为无 token 连接（重连不被阻断）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getRuntimeToken.mockRejectedValue(new Error('ipc gone'))
    portCb!(4600)
    await flushAsync()
    // warn 分支可见（排查依据），连接仍发起（undefined token 走无凭据路径）
    expect(warnSpy).toHaveBeenCalled()
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4600', undefined)
    warnSpy.mockRestore()
  })

  it('TC-T4: getRuntimeToken 返回 null → connect(url, undefined)（无凭据不阻断重连）', async () => {
    getRuntimeToken.mockResolvedValue(null)
    portCb!(4700)
    await flushAsync()
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4700', undefined)
  })
})
