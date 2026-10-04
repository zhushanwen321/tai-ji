// 新建任务表单测试（remote-use U1.4c：NewTaskSheet 提交调 createSessionFlow 编排）。
//
// core createSessionFlow mock（模块级 vi.mock 隔离 WS），断言：
//   - 两字段填写后提交 → createSessionFlow 被调（cwd + segments 编排入参）
//   - 创建成功 emit created（App 据此切到聊天视图）+ close
//   - 空字段提交被组件层拦截（required 提示，不触编排）
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import NewTaskSheet from '../views/NewTaskSheet.vue'
import { i18n } from '../i18n'
import type { SessionSummary } from '@taiji/shared'

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
const { mockCreateSessionFlow } = vi.hoisted(() => ({ mockCreateSessionFlow: vi.fn() }))

vi.mock('@taiji/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core')>()
  return {
    ...actual,
    createSessionFlow: mockCreateSessionFlow,
  }
})

function mountSheet(open = true) {
  return mount(NewTaskSheet, {
    props: { open },
    global: { plugins: [i18n] },
  })
}

describe('NewTaskSheet 提交调 createSessionFlow（D7 新建任务行）', () => {
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
