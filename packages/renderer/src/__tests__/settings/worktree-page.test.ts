/**
 * WorktreePage 测试（RD-4#6 保存失败透传 runtime 文案 + RD-4#7 前端范围/非空校验）。
 *
 * 覆盖：
 *  - 加载：getWorktreeTimeout 等 5 个 getter 拉取 → timeout input 显示加载值。
 *  - #7 timeout 越界（>3600 / <=0）：blur → inline error + 不发 RPC + 回滚加载值。
 *  - #7 timeout 合法：blur → setWorktreeTimeout 被调。
 *  - #7 defaultBaseBranch 空串：blur → inline error + 不发 RPC + 回滚。
 *  - #6 保存失败透传：setWorktreeRootDir reject → toastError 含 runtime 精确文案（reason）。
 *
 * mock 策略：vi.mock('@taiji/core/transport/api/domains/settings') 替换 10 个 worktree API；
 *  i18n 经 vitest-i18n-setup 全局解析 zh-CN。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/worktree-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useToast } from '@/composables/useToast'

const settingsMock = vi.hoisted(() => ({
  getWorktreeRootDir: vi.fn(() => Promise.resolve({ dir: '/repo' })),
  setWorktreeRootDir: vi.fn(() => Promise.resolve({ dir: '/repo' })),
  getSetupScript: vi.fn(() => Promise.resolve({ script: '' })),
  setSetupScript: vi.fn(() => Promise.resolve({ script: '' })),
  getBareSetupScript: vi.fn(() => Promise.resolve({ script: '' })),
  setBareSetupScript: vi.fn(() => Promise.resolve({ script: '' })),
  getWorktreeTimeout: vi.fn(() => Promise.resolve({ timeout: 60 })),
  setWorktreeTimeout: vi.fn(() => Promise.resolve({ timeout: 60 })),
  getDefaultBaseBranch: vi.fn(() => Promise.resolve({ baseBranch: 'origin/main' })),
  setDefaultBaseBranch: vi.fn(() => Promise.resolve({ baseBranch: 'origin/main' })),
}))

vi.mock('@taiji/core/transport/api/domains/settings', () => settingsMock)

import WorktreePage from '@/components/settings/worktree/WorktreePage.vue'

let wrapper: ReturnType<typeof mount> | null = null

function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  expect(node).toBeTruthy()
  return new DOMWrapper(node!)
}

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().toasts.value = []
  vi.clearAllMocks()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('WorktreePage 加载', () => {
  it('mount 后拉取 5 个 getter，timeout input 显示加载值 60', async () => {
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    expect(settingsMock.getWorktreeTimeout).toHaveBeenCalledTimes(1)
    expect(($('[data-testid="worktree-timeout-input"]').element as HTMLInputElement).value).toBe('60')
  })
})

describe('WorktreePage RD-4#7 前端校验（命中 inline error 不发 RPC）', () => {
  it('timeout > 3600 → inline error + 不发 RPC + 回滚加载值', async () => {
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    const input = $('[data-testid="worktree-timeout-input"]')
    ;(input.element as HTMLInputElement).value = '5000'
    await input.trigger('input')
    await input.trigger('blur')
    await flushPromises()

    // inline error 显形 + 不发 RPC + input 回滚到加载值 60
    expect($('[data-testid="worktree-timeout-error"]').text()).toContain('超时时间')
    expect(settingsMock.setWorktreeTimeout).not.toHaveBeenCalled()
    expect((input.element as HTMLInputElement).value).toBe('60')
  })

  it('timeout = 0 → inline error + 不发 RPC', async () => {
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    const input = $('[data-testid="worktree-timeout-input"]')
    ;(input.element as HTMLInputElement).value = '0'
    await input.trigger('input')
    await input.trigger('blur')
    await flushPromises()

    expect($('[data-testid="worktree-timeout-error"]').exists()).toBe(true)
    expect(settingsMock.setWorktreeTimeout).not.toHaveBeenCalled()
  })

  it('timeout 合法（120）→ setWorktreeTimeout 被调 + 无 inline error', async () => {
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    const input = $('[data-testid="worktree-timeout-input"]')
    ;(input.element as HTMLInputElement).value = '120'
    await input.trigger('input')
    await input.trigger('blur')
    await flushPromises()

    expect(settingsMock.setWorktreeTimeout).toHaveBeenCalledWith(120)
    expect(wrapper!.find('[data-testid="worktree-timeout-error"]').exists()).toBe(false)
  })

  it('defaultBaseBranch 空串 → inline error + 不发 RPC + 回滚', async () => {
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    const input = $('[data-testid="worktree-base-branch-input"]')
    ;(input.element as HTMLInputElement).value = '   '
    await input.trigger('input')
    await input.trigger('blur')
    await flushPromises()

    expect($('[data-testid="worktree-base-branch-error"]').text()).toContain('基分支')
    expect(settingsMock.setDefaultBaseBranch).not.toHaveBeenCalled()
    // 回滚到加载值 origin/main
    expect((input.element as HTMLInputElement).value).toBe('origin/main')
  })

  it('defaultBaseBranch 非空 → setDefaultBaseBranch 被调', async () => {
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    const input = $('[data-testid="worktree-base-branch-input"]')
    ;(input.element as HTMLInputElement).value = 'origin/dev'
    await input.trigger('input')
    await input.trigger('blur')
    await flushPromises()

    expect(settingsMock.setDefaultBaseBranch).toHaveBeenCalledWith('origin/dev')
  })
})

describe('WorktreePage RD-4#6 保存失败透传 runtime 文案', () => {
  it('setWorktreeRootDir reject → toastError 含 runtime 精确文案（reason，不再丢成「保存失败」）', async () => {
    settingsMock.setWorktreeRootDir.mockRejectedValueOnce(
      new Error('worktreeRootDir path cannot contain ..'),
    )
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    const input = $('[data-testid="worktree-root-dir-input"]')
    ;(input.element as HTMLInputElement).value = '/repo/../evil'
    await input.trigger('input')
    await input.trigger('blur')
    await flushPromises()

    // 保存失败 toast 把 runtime 精确文案透传进 {reason}（此前只弹「保存失败」丢失原因）
    expect(settingsMock.setWorktreeRootDir).toHaveBeenCalledWith('/repo/../evil')
    const { toasts } = useToast()
    expect(
      toasts.value.some(
        (t) => t.type === 'error' && t.message.includes('保存失败') && t.message.includes('cannot contain ..'),
      ),
    ).toBe(true)
  })
})
