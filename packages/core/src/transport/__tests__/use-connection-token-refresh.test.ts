/**
 * runtime 重启 token 刷新编排测试（S1-W1 / MF-2）。
 *
 * 锁定 use-connection 的 refreshTokenAndConnect 编排半边（auth 链路的 renderer 侧）：
 * runtime 重启 = supervisor 重新 spawn = token 已刷新，旧 token 对新 runtime 的
 * auth 必失败（1008 → 重连循环直到 failed）。重连路径必须先经 IPC getRuntimeToken
 * 拿新值再 connect(url, 新 token 凭据对象)——本文件钉住该编排，回归后果 = runtime 重启后
 * 应用失联。
 *
 * 覆盖：
 * - TC-T1: init 已知端口路径——connect 前先 IPC 取 token，connect(url, {auth:'token', token})
 * - TC-T2: onRuntimePort 推新端口 → disconnect + 重新拉 token + connect(newUrl, 新 token 凭据对象)
 * - TC-T3: getRuntimeToken 抛错 → warn 落日志 + 降级空串 token 握手探测（仍发起连接，重连不阻断）
 * - TC-T4: getRuntimeToken 返回 null → connect(url, {auth:'token', token:''})（同 T3 降级语义）
 *
 * 用例自包含：beforeEach 经 teardown() 复位 use-connection 的模块级单例装配（监听 /
 * initialised 幂等守卫 / 连接簿记），每条用例经 initConnection() 自己走首连装配路径——
 * onRuntimePort 监听（portCb）由本用例的 init 安装，不依赖其他用例的执行残留；任意
 * 单条筛选（vitest -t）/重排都能独立运行。init 装配自身的调用（首连 token/connect）
 * 不计入分支断言：装配后 mockClear，断言基准 = 本用例驱动的行为。
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
      // RD-3#2：启动失败真因消费端口（推送置 failed 短路徒劳重连 + init 拉取兜底）
      onRuntimeError: () => () => {},
      getRuntimeStartError: async () => null,
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
  // 复位上一条用例遗留的单例装配（teardown 拆全部监听 + initialised=false + 清簿记，
  // 使本用例的 init 走首连装配路径；teardown 会触发一次 mocked disconnect，故先复位
  // 再 clearAllMocks——断言计数不被上一条用例或复位动作污染）
  useConnection().teardown()
  vi.clearAllMocks()
  getRuntimeToken.mockReset()
  // onRuntimePort 重连守卫要求 state !== 'disconnected'（runtime 存活期间常态为 connected）
  mockStateRef.value = 'connected'
})

/** 每条用例自含装配：init 走首连路径（teardown 已复位 initialised），onRuntimePort 监听由本用例安装（portCb 就绪） */
async function initConnection(): Promise<void> {
  await useConnection().init()
}

/** 等 fire-and-forget 的 refreshTokenAndConnect 完成（IPC mock resolve + connect 微任务） */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('S1-W1: runtime 重启 token 刷新编排（refreshTokenAndConnect）', () => {
  it('TC-T1: init 已知端口路径——connect 前先 IPC 取 token，connect(url, token)', async () => {
    getRuntimeToken.mockResolvedValue('token-1')
    await initConnection()
    // dispatcher 已安装（init 副作用，不与 token 编排耦合）
    expect(inboundHandler).not.toBeNull()
    // 首连凭据经 IPC 下发：getRuntimeToken 先于 connect，token 透传
    expect(getRuntimeToken).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4000', { auth: 'token', token: 'token-1' })
  })

  it('TC-T2: onRuntimePort 推新端口 → disconnect + 重新拉 token + connect(newUrl, newToken)', async () => {
    getRuntimeToken.mockResolvedValue('token-2')
    await initConnection()
    // init 首连已消费一次 token 拉取（装配副作用），清零后断言基准 = 端口触发路径
    getRuntimeToken.mockClear()
    portCb!(4500)
    await flushAsync()
    // 旧连接先断开
    expect(vi.mocked(disconnect)).toHaveBeenCalledTimes(1)
    // runtime 重启 = token 已刷新：重连前必须重新拉取（不得复用旧 token）
    expect(getRuntimeToken).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4500', { auth: 'token', token: 'token-2' })
  })

  it('TC-T3: getRuntimeToken 抛错 → warn 落日志 + 降级为无 token 连接（重连不被阻断）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getRuntimeToken.mockRejectedValue(new Error('ipc gone'))
    await initConnection()
    // init 首连路径（token 拉取同样抛错）已产生 warn，清零后断言基准 = 端口触发路径
    warnSpy.mockClear()
    portCb!(4600)
    await flushAsync()
    // warn 分支可见（排查依据），连接仍发起（空串 token 握手探测：本地 runtime 恒配 token，
    // 探测必被拒走重连链——S4 裁决，不因「拿不到凭据」假设 skip 假 connected）
    expect(warnSpy).toHaveBeenCalled()
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4600', { auth: 'token', token: '' })
    warnSpy.mockRestore()
  })

  it('TC-T4: getRuntimeToken 返回 null → connect(url, {auth:"token", token:""})（无凭据不阻断重连）', async () => {
    getRuntimeToken.mockResolvedValue(null)
    await initConnection()
    portCb!(4700)
    await flushAsync()
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4700', { auth: 'token', token: '' })
  })
})
