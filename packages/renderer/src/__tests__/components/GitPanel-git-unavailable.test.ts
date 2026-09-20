/**
 * GitPanel git 不可用降级分支单测（code-harden RT-8#5 渲染侧）。
 *
 * 背景：runtime getStatus 把「git 探测失败（未装 git / 超时 / 未知异常）」与「真非仓库」
 * 区分开——前者携带 gitUnavailableReason，后者不设。此前两者都塌缩成 isRepo:false，
 * 未装 git 的用户被显示成「非 git 仓库」，按错方向自救。
 *
 * 覆盖：
 * 1. gitUnavailableReason 存在 → 渲染 git-unavailable 降级区（标题 + 真因 + 重试按钮），
 *    不再走 isRepo=false 的「整块不渲染」空态路径；
 * 2. 点重试 → 调注入实例的 refresh（用户可行动的恢复入口）；
 * 3. 真非仓库（isRepo=false 且无 reason）→ 不渲染降级区（空态归 SideDrawer，无退化）。
 *
 * i18n 经 vitest-i18n-setup 全局 mock，t() 取 zh-CN 文案。
 *
 * 运行：cd packages/renderer &&
 *   npx vitest run src/__tests__/components/GitPanel-git-unavailable.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import GitPanel from '@/components/panel/GitPanel.vue'
import { GIT_STATUS_KEY, type UseGitStatusReturn } from '@/composables/features/file-tree/useGitStatus'
import type { GitStatusResult } from '@taiji/shared'

/** 最小 GitStatusResult（降级分支只读 isRepo / gitUnavailableReason 两字段）。 */
function statusResult(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    sessionId: 's-git',
    isRepo: false,
    stagedCount: 0,
    unstagedCount: 0,
    hasConflict: false,
    files: [],
    stats: { add: 0, del: 0 },
    ...overrides,
  } as GitStatusResult
}

/** 构造注入用 git status 实例桩（只实现 GitPanel 渲染/重试路径用到的成员）。 */
function stubGitStatus(result: GitStatusResult): { stub: UseGitStatusReturn; refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(async () => {})
  const stub = {
    result: ref(result),
    state: ref('clean'),
    indicator: ref({ hasRepo: false, hasChanges: false, dirty: false, conflict: false }),
    pending: ref(false),
    error: ref(''),
    commitMsg: ref(''),
    canCommit: ref(false),
    refresh,
    stageAll: vi.fn(async () => {}),
    unstageAll: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
  } as unknown as UseGitStatusReturn
  return { stub, refresh }
}

function mountPanel(result: GitStatusResult) {
  const { stub, refresh } = stubGitStatus(result)
  const wrapper = mount(GitPanel, {
    global: {
      provide: { [GIT_STATUS_KEY as symbol]: stub },
    },
  })
  return { wrapper, refresh }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('GitPanel git 不可用降级（RT-8#5）', () => {
  it('gitUnavailableReason 存在 → 渲染降级区（标题 + 真因），不停在「非仓库」空态', () => {
    const { wrapper } = mountPanel(
      statusResult({ gitUnavailableReason: 'git_unavailable: git binary not found' }),
    )

    const section = wrapper.find('[data-testid="git-unavailable"]')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('Git 不可用')
    // 真因原样回显（用户据此判断是装 git 还是修环境，而非误判「不是仓库」）
    expect(section.text()).toContain('git_unavailable: git binary not found')
    // 有可行动的重试入口
    expect(section.find('button').exists()).toBe(true)
  })

  it('点重试 → 调注入实例的 refresh（恢复入口可行动）', async () => {
    const { wrapper, refresh } = mountPanel(
      statusResult({ gitUnavailableReason: 'timeout: 执行超时' }),
    )

    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('真非仓库（isRepo=false 且无 reason）→ 不渲染降级区（空态归 SideDrawer）', () => {
    const { wrapper } = mountPanel(statusResult())

    expect(wrapper.find('[data-testid="git-unavailable"]').exists()).toBe(false)
  })

  it('正常仓库（isRepo=true）→ 走主渲染分支，不出现降级区', () => {
    const { wrapper } = mountPanel(
      statusResult({ isRepo: true, branch: 'main', gitUnavailableReason: undefined }),
    )

    expect(wrapper.find('[data-testid="git-unavailable"]').exists()).toBe(false)
  })
})
