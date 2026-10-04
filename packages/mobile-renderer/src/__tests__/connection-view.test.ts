// connection-view 转移优先级测试（W6 抽取后补：转移 watch 的直接断言——mobile-shell.spec
// 直改视图 ref 驱动渲染不经转移逻辑，此处闭环三信号优先级不变量）。
//
// core getState 经 vi.mock 替换为本地可写 ref（ws-client 真实 state 无测试写入口，且本
// 测试聚焦转移规则而非 ws 状态机）；断言面：
//   - token-input 粘滞：进入后不被 connecting/reconnecting/failed 中间态覆盖，connected 才切出
//   - failed 终态（非 token-input 前提下）
//   - connected 置 hasConnectedOnce 后断连不复位（BM5 布局粘滞锚点）
//   - onAuthRejected 仅「提交中」才写 tokenSubmit.error（非提交路径拒绝不误报）
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/connection-view.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { nextTick, ref } from 'vue'
import type { ConnectionState } from '@taiji/core'
import type { ConnectionCredentialController } from '../platform/connection-profile'

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { mockGetState, mockDisconnect, mockInitConnection, mockResetSuppression } = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  mockDisconnect: vi.fn(),
  mockInitConnection: vi.fn(),
  mockResetSuppression: vi.fn(),
}))

vi.mock('@taiji/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core')>()
  return {
    ...actual,
    getState: mockGetState,
    disconnect: mockDisconnect,
    initConnection: mockInitConnection,
    resetAuthRejectionSuppression: mockResetSuppression,
  }
})

import {
  hasConnectedOnce,
  notifyAuthRejected,
  notifyTokenInputRequired,
  setupConnectionView,
  shellConnectionState,
  submitRemoteToken,
  tokenSubmit,
} from '../shell/connection-view'

// 本地可写连接态（readonly 形态差异不影响 watch：两者都按 .value 替换触发）
const coreState = ref<ConnectionState>('disconnected')
mockGetState.mockImplementation(() => coreState)

// satisfies：校验满足 controller 契约的同时保留 vi.fn 的 Mock 类型（断言用 mockClear）
const controller = {
  handleAuthSuccess: vi.fn(),
  handleAuthFailure: vi.fn(),
  adoptManualToken: vi.fn(),
} satisfies ConnectionCredentialController
setupConnectionView(controller)

async function toCoreState(s: ConnectionState): Promise<void> {
  coreState.value = s
  await nextTick()
}

describe('connection-view 转移优先级（三信号不变量）', () => {
  beforeEach(() => {
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    tokenSubmit.value = { submitting: false, error: null }
    coreState.value = 'disconnected'
    controller.handleAuthSuccess.mockClear()
  })

  it('connected：切 connected + 置 hasConnectedOnce + 收口 submitting + 触发凭据处置', async () => {
    tokenSubmit.value = { submitting: true, error: null }
    await toCoreState('connected')
    expect(shellConnectionState.value).toBe('connected')
    expect(hasConnectedOnce.value).toBe(true)
    expect(tokenSubmit.value.submitting).toBe(false)
    expect(controller.handleAuthSuccess).toHaveBeenCalledTimes(1)
  })

  it('token-input 粘滞：中间态（connecting/reconnecting/failed）不覆盖，connected 才切出', async () => {
    notifyTokenInputRequired()
    expect(shellConnectionState.value).toBe('token-input')

    await toCoreState('connecting')
    expect(shellConnectionState.value).toBe('token-input')
    await toCoreState('reconnecting')
    expect(shellConnectionState.value).toBe('token-input')
    // 粘滞优先级高于 failed：token 输入视图是恢复入口，预算用尽的指引不抢走它
    await toCoreState('failed')
    expect(shellConnectionState.value).toBe('token-input')

    await toCoreState('connected')
    expect(shellConnectionState.value).toBe('connected')
  })

  it('failed 终态（非 token-input 前提）：core failed → 视图 failed', async () => {
    await toCoreState('failed')
    expect(shellConnectionState.value).toBe('failed')
  })

  it('hasConnectedOnce 断连不复位：connected 后掉回 connecting，锚点保持（BM5 布局粘滞根）', async () => {
    await toCoreState('connected')
    await toCoreState('connecting')
    expect(shellConnectionState.value).toBe('connecting')
    expect(hasConnectedOnce.value).toBe(true)
  })

  it('onAuthRejected 仅提交中的拒绝写 error=invalid；非提交路径拒绝不误报', () => {
    notifyAuthRejected()
    expect(tokenSubmit.value).toEqual({ submitting: false, error: null })

    tokenSubmit.value = { submitting: true, error: null }
    notifyAuthRejected()
    expect(tokenSubmit.value).toEqual({ submitting: false, error: 'invalid' })
  })
})

describe('submitRemoteToken 提交编排（TokenInputView 提交路径，含 catch 失败分支）', () => {
  beforeEach(() => {
    tokenSubmit.value = { submitting: false, error: null }
    controller.adoptManualToken.mockClear()
    mockResetSuppression.mockClear()
    mockDisconnect.mockClear()
    mockInitConnection.mockReset()
    mockInitConnection.mockResolvedValue(undefined)
  })

  it('提交通道抛错：error=failed 且 submitting 复位（TokenInputView 可见错误态）；编排各步仍按序执行', async () => {
    mockInitConnection.mockRejectedValueOnce(new Error('connect refused'))

    await submitRemoteToken('tok-retry')

    expect(tokenSubmit.value).toEqual({ submitting: false, error: 'failed' })
    // catch 不跳过前置编排步骤：采纳凭据 → 解除抑制位 → 清残态 → 重连
    expect(controller.adoptManualToken).toHaveBeenCalledWith('tok-retry')
    expect(mockResetSuppression).toHaveBeenCalledTimes(1)
    expect(mockDisconnect).toHaveBeenCalledTimes(1)
    expect(mockInitConnection).toHaveBeenCalledTimes(1)
  })

  it('失败后可重试：再次提交走成功路径，submitting 置位且 error 清空（收口留给 auth 结果）', async () => {
    mockInitConnection.mockRejectedValueOnce(new Error('connect refused'))
    await submitRemoteToken('tok-retry')
    expect(tokenSubmit.value.error).toBe('failed')

    await submitRemoteToken('tok-retry')
    // 编排提交成功 ≠ 提交中收口：auth 结果（connected / 拒绝）异步落地时才收口
    expect(tokenSubmit.value).toEqual({ submitting: true, error: null })
  })
})
