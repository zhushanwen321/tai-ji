/**
 * RD-3#2：runtime 启动失败真因消费（use-connection 编排侧——状态转移）。
 *
 * 背景：main supervisor startAndNotify 失败（binary 缺失/端口占用等）发 runtime-error
 * 推送，此前全仓零消费——失败后 main 不自动重试，renderer 对 fallback 端口的 WS 自动
 * 重连必不可能成功，用户干等 60s 重连时长上限才见通用 failed。修复后编排行为（本文件锁定）：
 * - 推送到达（state 非 connected）→ setFailed 短路徒劳自动重连（用户拿到重试入口）；
 * - 推送到达但已 connected → 不置态（waitForHealth 超时但 runtime 实际存活的误伤防护）；
 * - init 时拉取 get-runtime-start-error 有记录（boot 竞态：推送早于监听安装已丢）→
 *   setFailed 短路且不再发起连接；
 * - 拉取无记录 → 正常走端口发现 + 连接（不短路）；
 * - teardown 卸载 onRuntimeError 监听（与安装配对）。
 *
 * 真因 message 的显示（连接屏 failed 分支）与落台账（error-reporter）在壳层 App.vue，
 * 由 renderer __tests__/App-runtime-start-error.test.ts 覆盖；本文件只锁 core 状态转移。
 *
 * 构造方式：与 use-connection-clear-pending.test.ts 同款（ws-client 1 处 vi.mock +
 * dispatcher no-op 注入 + 端口 fixture 捕获回调）。
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-runtime-start-error.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ConnectionState } from '../ws-client'
import { useConnection, setConnectionPorts, ensureDispatcher, type ConnectionPorts } from '../use-connection'

// ── ws-client mock：最小占位（对齐 clear-pending 同款）────────────────
const mockConnect = vi.fn()
let mockStateRef: Ref<ConnectionState> = ref('disconnected')
vi.mock('../ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: vi.fn(),
  getState: () => mockStateRef,
  setRestarting: () => {
    mockStateRef.value = 'restarting'
  },
  setFailed: () => {
    mockStateRef.value = 'failed'
  },
  onMessage: vi.fn(() => () => {}),
  onQueueDrop: vi.fn(() => () => {}),
}))

// ── 端口 fixture：捕获 onRuntimeError 回调 + 可控拉取值 ────────────────
let errorCb: ((error: { message: string }) => void) | null = null
let pullResult: string | null = null

function makePorts(): ConnectionPorts {
  return {
    ipc: {
      getRuntimePort: vi.fn().mockResolvedValue(undefined),
      getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
      getRuntimeToken: vi.fn(async () => null),
      onRuntimePort: vi.fn(() => () => {}),
      onRuntimeRestarting: vi.fn(() => () => {}),
      onRuntimeFailed: vi.fn(() => () => {}),
      onRuntimeError: (cb: (error: { message: string }) => void) => {
        errorCb = cb
        return () => {
          errorCb = null
        }
      },
      getRuntimeStartError: async () => pullResult,
      restartRuntime: vi.fn().mockResolvedValue(undefined),
    },
    visibility: {
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    },
    env: { isMock: false, isDev: false },
    effects: {},
    t: (key: string) => `[${key}]`,
    onRuntimeUnavailable: vi.fn(),
  }
}

describe('RD-3#2：runtime 启动失败真因消费（状态转移）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef = ref('disconnected')
    errorCb = null
    pullResult = null
    const ports = makePorts()
    setConnectionPorts(ports)
    // dispatcher 预装 no-op（对齐 clear-pending：route-inbound defaultPorts 不参与）
    ensureDispatcher(ports, () => {})
  })

  it('推送到达（disconnected）→ setFailed 短路徒劳自动重连', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(errorCb).not.toBeNull()

    errorCb!({ message: 'Runtime binary not found' })
    expect(mockStateRef.value).toBe('failed')
    teardown()
  })

  it('推送到达但已 connected → 不置态（waitForHealth 超时但 runtime 存活的误伤防护）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(errorCb).not.toBeNull()

    mockStateRef.value = 'connected'
    errorCb!({ message: 'waitForHealth timeout' })
    expect(mockStateRef.value).toBe('connected')
    teardown()
  })

  it('init 拉取有失败记录（boot 竞态丢推送）→ setFailed 短路且不发起连接', async () => {
    pullResult = 'EADDRINUSE: port 3310 already occupied'
    const { init, teardown } = useConnection()
    await init()

    expect(mockStateRef.value).toBe('failed')
    // 短路 = 不再对 fallback 端口发起徒劳 WS 连接（main 不会自动重试，重连必不可能成功）
    expect(mockConnect).not.toHaveBeenCalled()
    teardown()
  })

  it('init 拉取无记录 → 正常端口发现 + 连接（不短路）', async () => {
    const { init, teardown } = useConnection()
    await init()

    expect(mockStateRef.value).not.toBe('failed')
    expect(mockConnect).toHaveBeenCalled()
    teardown()
  })

  it('teardown 卸载 onRuntimeError 监听（与安装配对，重挂可再次安装）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(errorCb).not.toBeNull()

    teardown()
    expect(errorCb).toBeNull()
  })
})
