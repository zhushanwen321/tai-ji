/**
 * CW wave `session-active-ssot` T5：runtime 重连清理 ask-user pending
 * （自 renderer __tests__/useConnection-clear-pending.test.ts 迁入 core）。
 *
 * 锁定改动：onRuntimeRestarting / onRuntimeFailed 分支除原有 pending.rejectAll 外，
 * 额外经 onRuntimeUnavailable 端口触发对话流清理（renderer 实现：
 * chatStore.finalizeAllStreaming + extensionUIStore.clearAllPending）。原因：pi 进程死了
 * 之后 ask-user 的 extension.ui_request Promise 永远不会被 resolve（runtime 重启是全新
 * 实例），必须清空 pending，否则 UI 卡 waiting 态 + Promise 永挂。
 *
 * 注意：onRuntimePort（正常端口重连，pi 还活着）不清 pending、不触发清理。
 *
 * 迁移改造（§10.2 D-1）：store 调用已迁 renderer useMessageEffects（该层由
 * useMessageEffects.test.ts 覆盖），本测试断言 core 侧端口行为：
 * onRuntimeUnavailable(reason) 调用 + pending.rejectAll。
 *
 * 构造方式（D9 测试 seam 复位）：ws-client 1 处 vi.mock（use-connection 顶层依赖，
 * 不可消）+ dispatcher 1 处注入（no-op，本测试不处理入站消息）；pending 走真实模块
 * + spyOn 观察 rejectAll 调用（不再 vi.mock 模块内部），断言语义与改写前一致。
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-clear-pending.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import type { ConnectionState } from '../ws-client'
import { useConnection, setConnectionPorts, ensureDispatcher, type ConnectionPorts } from '../use-connection'
import * as pendingApi from '../api/pending'

// ── ws-client mock：最小占位（init 需要）──────────────────────────────
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
let mockStateRef: Ref<ConnectionState> = ref('disconnected')
vi.mock('../ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  getState: () => mockStateRef,
  // [汇合点改造] setRestarting/setFailed 置态（与真实实现对齐）——IPC 崩溃监听器只置态，
  // pending 清理 + onRuntimeUnavailable 经 stateWatch 的 state 迁移汇合触发。
  setRestarting: () => {
    mockStateRef.value = 'restarting'
  },
  setFailed: () => {
    mockStateRef.value = 'failed'
  },
  onMessage: vi.fn(() => () => {}),
  onQueueDrop: vi.fn(() => () => {}),
}))

// ── pending 真实模块 + spyOn（D9 消 vi.mock 模块内部）─────────────────
// use-connection 的 rejectAll 直连 transport/api/pending（D3），与 dispatcher 构造无关
// ——用 spyOn 真实模块观察调用（透传原实现，空 pendingMap 时 no-op），断言语义不变；
// route-inbound defaultPorts 不参与（dispatcher 经下方 ensureDispatcher 注入 no-op，
// 本测试不处理入站消息）。
const rejectAllSpy = vi.spyOn(pendingApi, 'rejectAll')

// ── 端口 mock：捕获 onRuntimeRestarting/onRuntimeFailed/onRuntimePort 注册的回调 ──
// 每个 onRuntime* 返回一个 unregister，同时把传入的 cb 暴露给测试触发。
let restartingCb: (() => void) | null = null
let failedCb: (() => void) | null = null
let portCb: ((port: number) => void) | null = null
const mockRuntimeCleanup = vi.fn()
const mockT = vi.fn((key: string) => `[${key}]`)

function makePorts(): ConnectionPorts {
  return {
    ipc: {
      getRuntimePort: vi.fn().mockResolvedValue(undefined),
      getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
getRuntimeToken: vi.fn(async () => null),
      onRuntimePort: (cb: (port: number) => void) => {
        portCb = cb
        return () => {
          portCb = null
        }
      },
      onRuntimeRestarting: (cb: () => void) => {
        restartingCb = cb
        return () => {
          restartingCb = null
        }
      },
      onRuntimeFailed: (cb: () => void) => {
        failedCb = cb
        return () => {
          failedCb = null
        }
      },
      restartRuntime: vi.fn().mockResolvedValue(undefined),
    },
    visibility: {
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    },
    // 非 mock 路径：init 才注册 onRuntimePort/onRuntimeRestarting/onRuntimeFailed 监听
    env: { isMock: false, isDev: false },
    effects: {},
    t: mockT,
    onRuntimeUnavailable: mockRuntimeCleanup,
  }
}

describe('T5: runtime 重连清理 ask-user pending（clearAllPending）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef = ref('disconnected')
    restartingCb = null
    failedCb = null
    portCb = null
    const ports = makePorts()
    setConnectionPorts(ports)
    // D9：注入 no-op dispatcher——init() 内 ensureDispatcher(ports) 幂等跳过，
    // route-inbound defaultPorts 不参与（本测试只观察 pending 清理端口行为）
    ensureDispatcher(ports, () => {})
  })

  it('onRuntimeRestarting → onRuntimeUnavailable("restart") + rejectAll（pi 死了 ask-user Promise 永挂，必须清）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(restartingCb).not.toBeNull()

    // 先连上（汇合点按 connected→restarting 迁移触发清理；未连上场景由 restarting 分支无条件覆盖）
    mockStateRef.value = 'connected'
    await nextTick()
    restartingCb!()
    // setRestarting 置态 → stateWatch flush（微任务）触发汇合清理
    await nextTick()
    expect(mockRuntimeCleanup).toHaveBeenCalledTimes(1)
    expect(mockRuntimeCleanup).toHaveBeenCalledWith('restart')
    expect(rejectAllSpy).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('onRuntimeFailed → onRuntimeUnavailable("disconnect") + rejectAll（runtime 重启用尽，pending 同样永挂）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(failedCb).not.toBeNull()

    mockStateRef.value = 'connected'
    await nextTick()
    failedCb!()
    await nextTick()
    expect(mockRuntimeCleanup).toHaveBeenCalledTimes(1)
    expect(mockRuntimeCleanup).toHaveBeenCalledWith('disconnect')
    expect(rejectAllSpy).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('未连上时 runtime 崩溃（disconnected → restarting）→ 仍触发清理（对齐原 IPC 监听器无条件语义）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(restartingCb).not.toBeNull()

    // 从未进入 connected，IPC 崩溃仍收口（restarting 分支不要求 oldState=connected）
    restartingCb!()
    await nextTick()
    expect(mockRuntimeCleanup).toHaveBeenCalledTimes(1)
    expect(mockRuntimeCleanup).toHaveBeenCalledWith('restart')
    teardown()
  })

  it('onRuntimePort（正常端口变化）→ 不触发清理（pi 还活着，pending 有效）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(portCb).not.toBeNull()

    // 模拟 runtime 重启成功推新端口（state 非 disconnected 才会重连，但清理与 connect 无关）
    mockStateRef.value = 'connected'
    await nextTick()
    portCb!(9999)
    // 关键断言：正常端口重连不清 pending、不触发清理（state 未离开 connected）
    expect(mockRuntimeCleanup).not.toHaveBeenCalled()
    expect(rejectAllSpy).not.toHaveBeenCalled()
    teardown()
  })
})
