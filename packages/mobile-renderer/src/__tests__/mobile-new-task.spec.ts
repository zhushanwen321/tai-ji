// 新建任务表单测试（remote-use U1.4c：NewTaskSheet 提交调 createSessionFlow 编排）。
//
// core createSessionFlow mock（模块级 vi.mock 隔离 WS），断言：
//   - 两字段填写后提交 → createSessionFlow 被调（cwd + segments 编排入参）
//   - 创建成功 emit created（App 据此切到聊天视图）+ close
//   - 空字段提交被组件层拦截（required 提示，不触编排）
//   - 创建成功后首条消息自动发送编排（createMobileTask 内 useChat.send）：以新 session id +
//     migratedSegments 被调；send 失败不回滚创建（created/close 照常，表单不误报失败）
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import NewTaskSheet from '../views/NewTaskSheet.vue'
import { i18n } from '../i18n'
import type { SessionSummary } from '@taiji/shared'
import type { UseChatDeps } from '@taiji/core'

const createdSession: SessionSummary = {
  id: 'sid-new',
  label: 'demo task',
  cwd: '/repo/demo',
  status: 'idle',
  lastActiveAt: Date.now(),
  modelId: '',
  tokenCount: 0,
}

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { mockCreateSessionFlow, mockSend } = vi.hoisted(() => ({
  mockCreateSessionFlow: vi.fn(),
  mockSend: vi.fn<(sid: string, segments: unknown[]) => Promise<void>>(),
}))

// createSessionFlow 整体替换（隔离 WS）；createUseChat 包真实工厂只换 send：
// app-runtime 的 createMobileTask 编排（创建 → 激活 → 自动发首条消息）保持全真实，
// 仅发送出口可观测（编排落在 app-runtime 生产代码，mock 组件层会变成断言 mock 自身）
vi.mock('@taiji/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core')>()
  return {
    ...actual,
    createSessionFlow: mockCreateSessionFlow,
    createUseChat: (deps: UseChatDeps) => ({ ...actual.createUseChat(deps), send: mockSend }),
  }
})

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

  it('空字段提交被组件层拦截：提交键 disabled（required 守卫），不触编排', async () => {
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
    // 用户可见面：编排成功后表单不出现错误提示
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
    // 发送失败只 console 留痕，不进表单错误提示（session 已存在，失败面仅首条消息投递）
    expect(errSpy).toHaveBeenCalledWith('[mobile-task] first message send failed:', expect.any(Error))
    expect(wrapper.find('[data-testid="new-task-error"]').exists()).toBe(false)
    errSpy.mockRestore()
    wrapper.unmount()
  })
})
