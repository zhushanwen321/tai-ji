// NewTaskSheet 组件级单测（remote-use-mobile-v2 §6.12 新建任务 Sheet）。
//
// 锁定数据面与提交语义：
// - chip 主路径：project.load 清单 × sessionList 聚合 → chip 行 + cwd 派生（选中 chip
//   的只读展示 / 无 chip 可选手输兜底）；手输逃生口（chip 模式下切换手输）；
// - 提交语义（v1 承接）：必填校验空值不调 RPC / createMobileTask 透传（cwd、
//   firstMessage、clientUuid 幂等键、选中 chip 的 projectId 归属）/ 成功 emit created+close /
//   返回 null 与 RPC 异常的降级提示；
// - project.load 失败降级手输（§6.12 降级链终点）。
//
// mock 策略（对齐 model-sheet.test 先例）：app-runtime 部分模块级 mock——fetchProjects /
// createMobileTask 替换；sessionList 走真实 sessionStore.applySnapshot 播种（sessions-screen
// 测试同款唯一写入口）。Sheet 内容经 portal 渲染到 document.body（document 查询）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import type { Project, SessionSummary } from '@taiji/shared'
import NewTaskSheet from '../NewTaskSheet.vue'
import { i18n } from '../../i18n'
import { sessionStore } from '../../shell/app-runtime'
import type { MobileNewTaskInput } from '../../shell/app-runtime'
import { resetSessionsRuntimeForTesting } from '../../shell/sessions-runtime'

const { fetchProjectsMock, createTaskMock } = vi.hoisted(() => ({
  fetchProjectsMock: vi.fn<() => Promise<{ projects: Project[]; activeProjectId: string }>>(),
  createTaskMock: vi.fn<(input: MobileNewTaskInput) => Promise<SessionSummary | null>>(),
}))

vi.mock('../../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/app-runtime')>()
  return { ...actual, fetchProjects: fetchProjectsMock, createMobileTask: createTaskMock }
})

const MADE: SessionSummary = { id: 's-new', label: '新会话', cwd: '/w', status: 'idle', lastActiveAt: 1 }

function bodyEl(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

function seedProjectSession(): void {
  sessionStore.applySnapshot({
    groups: [
      {
        cwd: '/w',
        sessions: [
          { id: 's-old', label: '旧会话', cwd: '/w/alpha-recent', status: 'idle', lastActiveAt: 5, projectId: 'proj-alpha' },
        ],
      },
    ],
  })
}

async function mountSheet(): Promise<VueWrapper> {
  const wrapper = mount(NewTaskSheet, {
    props: { open: true },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

async function fillAndSubmit(cwd: string, message: string, wrapper: VueWrapper): Promise<void> {
  const cwdInput = bodyEl('new-task-cwd') as HTMLInputElement | null
  if (cwdInput) {
    cwdInput.value = cwd
    cwdInput.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const msg = bodyEl('new-task-message') as HTMLTextAreaElement | null
  if (msg) {
    msg.value = message
    msg.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await flushPromises()
  bodyEl('new-task-submit')!.click()
  await flushPromises()
  void wrapper
}

beforeEach(() => {
  fetchProjectsMock.mockReset().mockResolvedValue({
    projects: [{ id: 'proj-alpha', name: 'Alpha', lastUsedAt: 0 }],
    activeProjectId: 'proj-alpha',
  })
  createTaskMock.mockReset().mockResolvedValue(MADE)
  resetSessionsRuntimeForTesting()
  seedProjectSession()
})

afterEach(() => {
  document.body.innerHTML = ''
  resetSessionsRuntimeForTesting()
})

describe('NewTaskSheet 项目 chip 主路径（§6.12）', () => {
  it('chip 行渲染（项目名 + 会话计数）+ 选中 chip → cwd 派生只读展示', async () => {
    const wrapper = await mountSheet()

    const chip = bodyEl('new-task-chip-proj-alpha')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('Alpha')
    expect(chip!.textContent).toContain('/w/alpha-recent')

    chip!.click()
    await flushPromises()
    // chip 选中后 cwd 只读展示（派生值，非 Input）
    expect(bodyEl('new-task-cwd-derived')).not.toBeNull()
    expect(bodyEl('new-task-cwd-derived')!.textContent).toContain('/w/alpha-recent')
    wrapper.unmount()
  })

  it('手输逃生口：chip 模式点切换 → Input 形态（目标项目不在清单时不必回桌面）', async () => {
    const wrapper = await mountSheet()

    bodyEl('new-task-manual-switch')!.click()
    await flushPromises()

    expect(bodyEl('new-task-chips')).toBeNull()
    expect(bodyEl('new-task-cwd')).not.toBeNull()
    wrapper.unmount()
  })

  it('选中 chip 提交：createMobileTask 透传 cwd + projectId（D14 创建时归属）→ emit created + close', async () => {
    const wrapper = await mountSheet()

    bodyEl('new-task-chip-proj-alpha')!.click()
    await flushPromises()
    await fillAndSubmit('', '第一条消息', wrapper)

    expect(createTaskMock).toHaveBeenCalledTimes(1)
    const arg = createTaskMock.mock.calls[0]![0]
    expect(arg.cwd).toBe('/w/alpha-recent')
    expect(arg.firstMessage).toBe('第一条消息')
    expect(arg.projectId).toBe('proj-alpha')
    expect(typeof arg.clientUuid).toBe('string')
    expect(wrapper.emitted('created')).toEqual([[MADE]])
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('NewTaskSheet 提交语义（v1 承接：必填校验 + 幂等键）', () => {
  it('必填校验（disabled 承载）：message 为空 → 提交钮禁用，不调 RPC 不显错误行', async () => {
    const wrapper = await mountSheet()

    bodyEl('new-task-chip-proj-alpha')!.click()
    await flushPromises()

    const submit = bodyEl('new-task-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    submit.click()
    await flushPromises()

    expect(createTaskMock).not.toHaveBeenCalled()
    expect(bodyEl('new-task-error')).toBeNull()
    wrapper.unmount()
  })

  it('手输路径提交：cwd/message 均填 → createMobileTask（projectId 缺省 = 默认项目兜底）', async () => {
    const wrapper = await mountSheet()

    bodyEl('new-task-manual-switch')!.click()
    await flushPromises()
    await fillAndSubmit('/manual/path', '手输任务', wrapper)

    expect(createTaskMock).toHaveBeenCalledTimes(1)
    const arg = createTaskMock.mock.calls[0]![0]
    expect(arg.cwd).toBe('/manual/path')
    expect(arg.projectId).toBeUndefined()
    wrapper.unmount()
  })

  it('createMobileTask 返回 null（guard 命中未创建）：降级提示，不 emit created', async () => {
    createTaskMock.mockResolvedValue(null)
    const wrapper = await mountSheet()

    bodyEl('new-task-manual-switch')!.click()
    await flushPromises()
    await fillAndSubmit('/w', '消息', wrapper)

    expect(bodyEl('new-task-error')).not.toBeNull()
    expect(wrapper.emitted('created')).toBeUndefined()
    wrapper.unmount()
  })

  it('RPC 异常：errorText = 异常消息（表单保持可重试，clientUuid 槽不换键）', async () => {
    createTaskMock.mockRejectedValue(new Error('create rpc failed'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await mountSheet()

    bodyEl('new-task-manual-switch')!.click()
    await flushPromises()
    await fillAndSubmit('/w', '消息', wrapper)

    expect(bodyEl('new-task-error')!.textContent).toContain('create rpc failed')
    err.mockRestore()
    wrapper.unmount()
  })
})

describe('NewTaskSheet 降级链（§6.12 主路径终点 = 手输兜底）', () => {
  it('project.load 失败：直接手输模式（chips 不渲染，Input 在场）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchProjectsMock.mockRejectedValue(new Error('project.load failed'))
    const wrapper = await mountSheet()

    expect(bodyEl('new-task-chips')).toBeNull()
    expect(bodyEl('new-task-cwd')).not.toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    wrapper.unmount()
  })

  it('项目清单与聚合双空：手输模式（无 chip 可选）', async () => {
    // 聚合源 sessions 也清空（无会话无分组 → chips 双空 → 手输兜底）
    sessionStore.applySnapshot({ groups: [] })
    fetchProjectsMock.mockResolvedValue({ projects: [], activeProjectId: '' })
    const wrapper = await mountSheet()

    expect(bodyEl('new-task-chips')).toBeNull()
    expect(bodyEl('new-task-cwd')).not.toBeNull()
    wrapper.unmount()
  })
})
