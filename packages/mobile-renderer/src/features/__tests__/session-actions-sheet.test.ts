// SessionActionsSheet 组件级单测（remote-use-mobile-v2 §7.1 会话长按动作 Sheet）。
//
// 锁定动作集与降级策略（M-1 迁移 + F14）：
// - 重新打开（仅 dead 在场）→ restoreSession 成功 closeSheet / 失败保持在场可重试（console 留痕）；
// - 重命名（Sheet 内二级态）→ 空值不提交 / 成功 closeSheet / 失败表单保持；
// - 删除（二次确认态，A9/A10 确认前不删除）→ deleteSessionWithCascade / 失败回动作列表。
//
// mock 策略（对齐 model-sheet.test 先例）：app-runtime 的 restoreSession/renameSession 与
// sessions-runtime 的 deleteSessionWithCascade 模块级 mock；sheet-manager 用真实单例
// （closeSheet 出口断言 activeSheet 归零，测试复位走 resetSheetManagerForTesting）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import type { SessionSummary } from '@taiji/shared'
import SessionActionsSheet from '../SessionActionsSheet.vue'
import { i18n } from '../../i18n'
import { resetSheetManagerForTesting, activeSheet } from '../../shell/sheet-manager'

const { restoreSessionMock, renameSessionMock, deleteCascadeMock } = vi.hoisted(() => ({
  restoreSessionMock: vi.fn<() => Promise<void>>(),
  renameSessionMock: vi.fn<() => Promise<void>>(),
  deleteCascadeMock: vi.fn<() => Promise<void>>(),
}))

vi.mock('../../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/app-runtime')>()
  return { ...actual, restoreSession: restoreSessionMock, renameSession: renameSessionMock }
})

vi.mock('../../shell/sessions-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/sessions-runtime')>()
  return { ...actual, deleteSessionWithCascade: deleteCascadeMock }
})

function session(status: SessionSummary['status']): SessionSummary {
  return { id: 's-actions', label: '目标会话', cwd: '/w', status, lastActiveAt: 1 }
}

function bodyEl(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

async function mountSheet(target: SessionSummary): Promise<VueWrapper> {
  const wrapper = mount(SessionActionsSheet, {
    props: { session: target },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  restoreSessionMock.mockReset().mockResolvedValue(undefined)
  renameSessionMock.mockReset().mockResolvedValue(undefined)
  deleteCascadeMock.mockReset().mockResolvedValue(undefined)
  resetSheetManagerForTesting()
  activeSheet.value = 'sessionActions'
})

afterEach(() => {
  document.body.innerHTML = ''
  resetSheetManagerForTesting()
})

describe('SessionActionsSheet 动作列表态（§7.1）', () => {
  it('dead 会话：重新打开钮在场；idle 会话：结构性不在场（仅 dead 语义）', async () => {
    const wrapper = await mountSheet(session('dead'))
    expect(bodyEl('session-action-restore')).not.toBeNull()
    wrapper.unmount()

    document.body.innerHTML = ''
    const wrapper2 = await mountSheet(session('idle'))
    expect(bodyEl('session-action-restore')).toBeNull()
    expect(bodyEl('session-action-rename')).not.toBeNull()
    expect(bodyEl('session-action-delete')).not.toBeNull()
    wrapper2.unmount()
  })
})

describe('SessionActionsSheet 重新打开（F14，仅 dead）', () => {
  it('restoreSession 透传 + 成功 closeSheet（activeSheet 归零）', async () => {
    const wrapper = await mountSheet(session('dead'))

    bodyEl('session-action-restore')!.click()
    await flushPromises()

    expect(restoreSessionMock).toHaveBeenCalledWith('s-actions')
    expect(activeSheet.value).toBeNull()
    wrapper.unmount()
  })

  it('restore 失败：Sheet 保持在场可重试（不关槽位，console 留痕）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    restoreSessionMock.mockRejectedValue(new Error('attach failed'))
    const wrapper = await mountSheet(session('dead'))

    bodyEl('session-action-restore')!.click()
    await flushPromises()

    expect(activeSheet.value).toBe('sessionActions')
    expect(err).toHaveBeenCalled()
    err.mockRestore()
    wrapper.unmount()
  })
})

describe('SessionActionsSheet 重命名（Sheet 内二级态）', () => {
  it('进入重命名态：原 label 预填 → 提交 renameSession + closeSheet', async () => {
    const wrapper = await mountSheet(session('idle'))

    bodyEl('session-action-rename')!.click()
    await flushPromises()

    const input = bodyEl('session-rename-input') as HTMLInputElement
    expect(input.value).toBe('目标会话')
    input.value = '新名字'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    bodyEl('session-rename-confirm')!.click()
    await flushPromises()

    expect(renameSessionMock).toHaveBeenCalledWith('s-actions', '新名字')
    expect(activeSheet.value).toBeNull()
    wrapper.unmount()
  })

  it('空值提交：不调 RPC（必填守卫），表单保持', async () => {
    const wrapper = await mountSheet(session('idle'))

    bodyEl('session-action-rename')!.click()
    await flushPromises()
    const input = bodyEl('session-rename-input') as HTMLInputElement
    input.value = '   '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    bodyEl('session-rename-confirm')!.click()
    await flushPromises()

    expect(renameSessionMock).not.toHaveBeenCalled()
    expect(activeSheet.value).toBe('sessionActions')
    wrapper.unmount()
  })

  it('rename 失败：表单保持打开可重试（乐观更新只在 RPC 成功后）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    renameSessionMock.mockRejectedValue(new Error('rpc failed'))
    const wrapper = await mountSheet(session('idle'))

    bodyEl('session-action-rename')!.click()
    await flushPromises()
    const input = bodyEl('session-rename-input') as HTMLInputElement
    input.value = '新名字'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    bodyEl('session-rename-confirm')!.click()
    await flushPromises()

    expect(activeSheet.value).toBe('sessionActions')
    expect(bodyEl('session-rename-form')).not.toBeNull()
    err.mockRestore()
    wrapper.unmount()
  })
})

describe('SessionActionsSheet 删除（A9/A10 二次确认态）', () => {
  it('确认前不删除：点删除只进确认态（文案含目标 label），deleteCascade 未被调', async () => {
    const wrapper = await mountSheet(session('idle'))

    bodyEl('session-action-delete')!.click()
    await flushPromises()

    const confirm = bodyEl('session-delete-confirm')
    expect(confirm).not.toBeNull()
    expect(bodyEl('session-delete-confirm-target')!.textContent).toContain('目标会话')
    expect(deleteCascadeMock).not.toHaveBeenCalled()

    // 取消回动作列表
    bodyEl('session-delete-cancel')!.click()
    await flushPromises()
    expect(bodyEl('session-actions-list')).not.toBeNull()
    wrapper.unmount()
  })

  it('确认删除：deleteSessionWithCascade 透传（closeSheet 由级联编排收尾，本组件不重复调）', async () => {
    const wrapper = await mountSheet(session('idle'))

    bodyEl('session-action-delete')!.click()
    await flushPromises()
    bodyEl('session-delete-confirm-button')!.click()
    await flushPromises()

    expect(deleteCascadeMock).toHaveBeenCalledWith('s-actions')
    wrapper.unmount()
  })

  it('删除失败：回动作列表可重试（不产生本地半删态）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    deleteCascadeMock.mockRejectedValue(new Error('remove failed'))
    const wrapper = await mountSheet(session('idle'))

    bodyEl('session-action-delete')!.click()
    await flushPromises()
    bodyEl('session-delete-confirm-button')!.click()
    await flushPromises()

    expect(bodyEl('session-actions-list')).not.toBeNull()
    err.mockRestore()
    wrapper.unmount()
  })
})
