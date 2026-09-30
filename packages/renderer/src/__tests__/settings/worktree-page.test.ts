/**
 * WorktreePage 测试（RD-4#6 保存失败透传 runtime 文案 + RD-4#7 前端范围/非空校验 + RD-4#8 加载失败语义）。
 *
 * 覆盖：
 *  - 加载：getWorktreeTimeout 等 5 个 getter 拉取 → timeout input 显示加载值。
 *  - #8 加载失败（有意行为修正：一次性 toast → 常驻禁用 + 重试）：任一 getter reject →
 *    常驻 loadError 块显形 + 控件禁用 + 无一次性 toast；retry 成功 → 提示消失 + 控件恢复。
 *  - #7 timeout 越界（>3600 / <=0）：blur → inline error + 不发 RPC + 回滚加载值。
 *  - #7 timeout 合法：blur → setWorktreeTimeout 被调。
 *  - #7 defaultBaseBranch 空串：blur → inline error + 不发 RPC + 回滚。
 *  - #6 保存失败透传：setWorktreeRootDir reject → toastError 含 runtime 精确文案（reason）。
 *
 * mock 策略：SettingsTransport seam 桩（makeSettingsTransportStub + provideSettingsTransport，
 *  [C3] 测试打 seam 不 mock 路由链）替换 10 个 worktree API；
 *  i18n 经 vitest-i18n-setup 全局解析 zh-CN。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/worktree-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
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

// [C3] 10 个 worktree API 经 SettingsTransport seam 桩注入（替换原 domains/settings 模块 mock）

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
  provideSettingsTransport(makeSettingsTransportStub(settingsMock))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** 以 getWorktreeTimeout reject('ws down') 挂载并断言常驻 loadError 显形（RD-4#8 两用例共用） */
async function mountWithLoadError(): Promise<void> {
  settingsMock.getWorktreeTimeout.mockRejectedValueOnce(new Error('ws down'))
  wrapper = mount(WorktreePage, { attachTo: document.body })
  await flushPromises()
  expect($('[data-testid="worktree-load-error"]').exists()).toBe(true)
}

describe('WorktreePage 加载', () => {
  it('mount 后拉取 5 个 getter，timeout input 显示加载值 60', async () => {
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    expect(settingsMock.getWorktreeTimeout).toHaveBeenCalledTimes(1)
    expect(($('[data-testid="worktree-timeout-input"]').element as HTMLInputElement).value).toBe('60')
  })
})

describe('WorktreePage RD-4#8 加载失败（有意行为修正：一次性 toast → 常驻禁用 + 重试）', () => {
  it('getWorktreeTimeout reject → 常驻 loadError 块显形 + 控件禁用（默认值不再冒充已存值可保存）', async () => {
    await mountWithLoadError()

    // 常驻错误块 + 重试入口（对照 System sections 的 RD-4#8 形态）
    expect($('[data-testid="worktree-load-retry"]').exists()).toBe(true)
    // 全部输入控件禁用（含加载成功字段的控件——组级归并）
    expect($('[data-testid="worktree-timeout-input"]').attributes('disabled')).toBeDefined()
    expect($('[data-testid="worktree-root-dir-input"]').attributes('disabled')).toBeDefined()
    expect($('[data-testid="worktree-base-branch-input"]').attributes('disabled')).toBeDefined()
    // 有意行为修正的核心断言：不再一次性 toast（RD-4#8：误显的默认值会随用户操作直接落盘）
    const { toasts } = useToast()
    expect(toasts.value.some((toast) => toast.type === 'error')).toBe(false)
  })

  it('retry → getter 重拉成功 → loadError 消失 + 控件恢复可用 + 显示加载值', async () => {
    await mountWithLoadError()

    await $('[data-testid="worktree-load-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="worktree-load-error"]').exists()).toBe(false)
    const input = $('[data-testid="worktree-timeout-input"]')
    expect(input.attributes('disabled')).toBeUndefined()
    expect((input.element as HTMLInputElement).value).toBe('60')
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

describe('WorktreePage 初始化脚本持久化（setting-field 编排，blur 保存）', () => {
  it('setup script 改值 + blur → setSetupScript 被调', async () => {
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    // 两脚本输入无 testid，以 locale placeholder 锚定（「如 …」为 worktree 区脚本、无前缀为 bare 区）
    const input = $('input[placeholder="如 custom-hooks/setup-worktree.sh"]')
    ;(input.element as HTMLInputElement).value = 'custom-hooks/a.sh'
    await input.trigger('input')
    await input.trigger('blur')
    await flushPromises()

    expect(settingsMock.setSetupScript).toHaveBeenCalledTimes(1)
    expect(settingsMock.setSetupScript).toHaveBeenCalledWith('custom-hooks/a.sh')
    expect(settingsMock.setBareSetupScript).not.toHaveBeenCalled()
  })

  it('bare setup script 改值 + blur → setBareSetupScript 被调', async () => {
    wrapper = mount(WorktreePage, { attachTo: document.body })
    await flushPromises()

    const input = $('input[placeholder="custom-hooks/setup-worktree.sh"]')
    ;(input.element as HTMLInputElement).value = 'custom-hooks/bare.sh'
    await input.trigger('input')
    await input.trigger('blur')
    await flushPromises()

    expect(settingsMock.setBareSetupScript).toHaveBeenCalledTimes(1)
    expect(settingsMock.setBareSetupScript).toHaveBeenCalledWith('custom-hooks/bare.sh')
    expect(settingsMock.setSetupScript).not.toHaveBeenCalled()
  })
})
