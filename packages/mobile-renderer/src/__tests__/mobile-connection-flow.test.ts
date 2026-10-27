import { i18n } from '../i18n';
import type { ConnectionCredentialController } from '../platform/connection-profile';
import NewTaskSheet from '../views/NewTaskSheet.vue';
import type { ConnectionState, UseChatDeps } from '@taiji/core';
import type { SessionSummary } from '@taiji/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← connection-view.test.ts
// ======================================================================

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { mockGetState, mockDisconnect, mockInitConnection, mockResetSuppression, mockOnGoingAway } =
  vi.hoisted(() => ({
    mockGetState: vi.fn(),
    mockDisconnect: vi.fn(),
    mockInitConnection: vi.fn(),
    mockResetSuppression: vi.fn(),
    mockOnGoingAway: vi.fn(),
  }))

// 簇内并集 mock（connection-view 连接编排出口 + new-task 创建流出口同表覆写；
// spread actual —— 其余 core 导出保持真实）。
vi.mock('@taiji/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core')>()
  return {
    ...actual,
    getState: mockGetState,
    disconnect: mockDisconnect,
    initConnection: mockInitConnection,
    resetAuthRejectionSuppression: mockResetSuppression,
    onGoingAway: mockOnGoingAway,
    createSessionFlow: mockCreateSessionFlow,
    createUseChat: (deps: UseChatDeps) => ({ ...actual.createUseChat(deps), send: mockSend }),
  }
})

import { connectionBannerI18nKey, hasConnectedOnce, notifyAuthRejected, notifyTokenInputRequired, runtimeRestarting, setupConnectionView, shellConnectionState, submitRemoteToken, tokenSubmit, } from '../shell/connection-view';
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

  it('connected：切 connected + 置 hasConnectedOnce + 收尾 submitting + 触发凭据处置', async () => {
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

describe('D8 重启感知：close 1001 → 重启文案分流（不升级 failed 全屏）', () => {
  // setupConnectionView（文件顶层）注册的 onGoingAway 回调（mock 捕获）——模拟 ws-client
  // onclose 读到 close 1001（runtime 计划内关停）时的信号触发
  function triggerGoingAway(): void {
    expect(mockOnGoingAway).toHaveBeenCalledTimes(1)
    const cb = mockOnGoingAway.mock.calls[0]?.[0]
    expect(typeof cb).toBe('function')
    ;(cb as () => void)()
  }

  beforeEach(() => {
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    runtimeRestarting.value = false
    coreState.value = 'disconnected'
  })

  it('close 1001：runtimeRestarting 置位 + 文案切 restarting；重连中间态不升级 failed', async () => {
    // 断线初态：现状文案（reconnecting）
    expect(runtimeRestarting.value).toBe(false)
    expect(connectionBannerI18nKey.value).toBe('mobile.reconnecting')

    triggerGoingAway()
    expect(runtimeRestarting.value).toBe(true)
    expect(connectionBannerI18nKey.value).toBe('mobile.restarting')

    // 重启窗口内的重连中间态：视图停留 connecting（非 failed 全屏），重启文案保持
    await toCoreState('reconnecting')
    expect(shellConnectionState.value).toBe('connecting')
    expect(shellConnectionState.value).not.toBe('failed')
    expect(connectionBannerI18nKey.value).toBe('mobile.restarting')
  })

  it('非 1001 断线（onGoingAway 未触发）：文案维持现状 reconnecting 不变', async () => {
    await toCoreState('connected')
    // 网络断（close code 非 1001，无 goingAway 信号）→ 掉回重连态
    await toCoreState('reconnecting')
    expect(runtimeRestarting.value).toBe(false)
    expect(shellConnectionState.value).toBe('connecting')
    expect(connectionBannerI18nKey.value).toBe('mobile.reconnecting')
  })

  it('重启完成重连成功（connected）：runtimeRestarting 复位，文案回现状', async () => {
    triggerGoingAway()
    expect(connectionBannerI18nKey.value).toBe('mobile.restarting')

    await toCoreState('connected')
    expect(runtimeRestarting.value).toBe(false)
    expect(connectionBannerI18nKey.value).toBe('mobile.reconnecting')
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

  it('失败后可重试：再次提交走成功路径，submitting 置位且 error 清空（收尾留给 auth 结果）', async () => {
    mockInitConnection.mockRejectedValueOnce(new Error('connect refused'))
    await submitRemoteToken('tok-retry')
    expect(tokenSubmit.value.error).toBe('failed')

    await submitRemoteToken('tok-retry')
    // 编排提交成功 ≠ 提交中收尾：auth 结果（connected / 拒绝）异步落地时才收尾
    expect(tokenSubmit.value).toEqual({ submitting: true, error: null })
  })
})

// ======================================================================
// ← mobile-new-task.spec.ts
// ======================================================================

const createdSession: SessionSummary = {
  id: 'sid-new',
  label: 'demo task',
  cwd: '/repo/demo',
  status: 'idle',
  lastActiveAt: Date.now(),
}

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { mockCreateSessionFlow, mockSend } = vi.hoisted(() => ({
  mockCreateSessionFlow: vi.fn(),
  mockSend: vi.fn<(sid: string, segments: unknown[]) => Promise<void>>(),
}))

// createSessionFlow 整体替换（隔离 WS）；createUseChat 包真实工厂只换 send：
// app-runtime 的 createMobileTask 编排（创建 → 激活 → 自动发首条消息）保持全真实，
// 仅发送出口可观测（编排落在 app-runtime 生产代码，mock 组件层会变成断言 mock 自身）
// @taiji/core 并集 mock 见簇首（connection-view 节顶部）：本节覆盖项已并入同一工厂。

function mountSheet(open = true) {
  return mount(NewTaskSheet, {
    props: { open },
    global: { plugins: [i18n] },
  })
}

describe('NewTaskSheet 提交调 createSessionFlow（remote-use-mobile D7（移动壳 v1 功能集裁定）新建任务行）', () => {
  beforeEach(() => {
    mockCreateSessionFlow.mockReset()
  })

  it('两字段填写后提交：createSessionFlow 以 (cwd, segments) 入参被调，emit created + close', async () => {
    mockCreateSessionFlow.mockResolvedValue({ session: createdSession, migratedSegments: [{ type: 'text', text: 'demo task' }] })
    const wrapper = mountSheet()
    await wrapper.get('[data-testid="new-task-cwd"]').setValue('/repo/demo')
    await wrapper.get('[data-testid="new-task-message"]').setValue('demo task')
    await wrapper.get('[data-testid="new-task-submit"]').trigger('click')
    await flushPromises()

    expect(mockCreateSessionFlow).toHaveBeenCalledTimes(1)
    const [ctx, input] = mockCreateSessionFlow.mock.calls[0] as [
      { defaultCwd: string; onCwdFallback?: unknown },
      { cwd: string; segments: Array<{ type: string; text?: string }> },
    ]
    expect(ctx.defaultCwd).toBe('')
    expect(input.cwd).toBe('/repo/demo')
    expect(input.segments).toEqual([{ type: 'text', text: 'demo task' }])
    expect(wrapper.emitted('created')).toEqual([[createdSession]])
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  it('空字段提交被组件层拦截：提交键 disabled（required 检查），不触编排', async () => {
    const wrapper = mountSheet()
    await wrapper.get('[data-testid="new-task-message"]').setValue('only message')
    // cwd 缺失 → 提交键 disabled（组件层拦截），click 不触达 onSubmit
    const submit = wrapper.get('[data-testid="new-task-submit"]')
    expect((submit.element as HTMLButtonElement).disabled).toBe(true)
    await submit.trigger('click')
    await flushPromises()

    expect(mockCreateSessionFlow).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('创建成功后首条消息自动发送编排（createMobileTask：创建 → 激活 → useChat.send）', () => {
  beforeEach(() => {
    mockCreateSessionFlow.mockReset()
    mockSend.mockReset()
  })

  it('创建成功：send 以新 session id + migratedSegments 自动被调，emit created + close，无错误提示', async () => {
    mockCreateSessionFlow.mockResolvedValue({ session: createdSession, migratedSegments: [{ type: 'text', text: 'demo task' }] })
    mockSend.mockResolvedValue(undefined)
    const wrapper = mountSheet()
    await wrapper.get('[data-testid="new-task-cwd"]').setValue('/repo/demo')
    await wrapper.get('[data-testid="new-task-message"]').setValue('demo task')
    await wrapper.get('[data-testid="new-task-submit"]').trigger('click')
    await flushPromises()

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith('sid-new', [{ type: 'text', text: 'demo task' }])
    expect(wrapper.emitted('created')).toEqual([[createdSession]])
    expect(wrapper.emitted('close')).toBeTruthy()
    // 用户可见部分：编排成功后表单不出现错误提示
    expect(wrapper.find('[data-testid="new-task-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('send 失败不回滚创建：created + close 照常上抛，表单不误报创建失败（仅 console 留痕）', async () => {
    mockCreateSessionFlow.mockResolvedValue({ session: createdSession, migratedSegments: [{ type: 'text', text: 'demo task' }] })
    mockSend.mockRejectedValue(new Error('ws down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mountSheet()
    await wrapper.get('[data-testid="new-task-cwd"]').setValue('/repo/demo')
    await wrapper.get('[data-testid="new-task-message"]').setValue('demo task')
    await wrapper.get('[data-testid="new-task-submit"]').trigger('click')
    await flushPromises()

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('created')).toEqual([[createdSession]])
    expect(wrapper.emitted('close')).toBeTruthy()
    // 发送失败只 console 留痕，不进表单错误提示（session 已存在，失败情形仅首条消息投递）
    expect(errSpy).toHaveBeenCalledWith('[mobile-task] first message send failed:', expect.any(Error))
    expect(wrapper.find('[data-testid="new-task-error"]').exists()).toBe(false)
    errSpy.mockRestore()
    wrapper.unmount()
  })
})

describe('NewTaskSheet backdrop 遮罩（点击关闭）', () => {
  it('open=true：backdrop 渲染，点击 emit close', async () => {
    const wrapper = mountSheet(true)
    const backdrop = wrapper.get('[data-testid="new-task-backdrop"]')
    expect(backdrop.element).toBeTruthy()
    await backdrop.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  it('open=false：backdrop 不渲染（v-if 整树关闭）', () => {
    const wrapper = mountSheet(false)
    expect(wrapper.find('[data-testid="new-task-backdrop"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
