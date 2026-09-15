/**
 * CreateWorktreeModal Enter 提交链路测试。
 *
 * form 态用 <form @submit.prevent="submitCreate"> 包裹 + 创建按钮 type="submit"：
 * 浏览器内分支名输入框按 Enter 走原生隐式提交（happy-dom 不实现 keydown→submit 隐式提交，
 * 故测试分两段验证链路：① form submit 事件 → createWorktree RPC 调用；② 创建按钮
 * type="submit" 且在 form 内 —— 该组合在浏览器保证 Enter 生效，disabled 时隐式提交被抑制）。
 *
 * Dialog 内容经 reka DialogPortal teleport 到 body，VTU wrapper.find 不可见——
 * 断言与事件触发一律经 document.querySelector + DOMWrapper。
 *
 * 运行：cd packages/ui && npx vitest run src/features/new-task
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import CreateWorktreeModal from '../CreateWorktreeModal.vue'
import { NewTaskDepsKey, type NewTaskDeps } from '../new-task-deps'

/** 构造 mock NewTaskDeps（bare workspace 态：baseBranch 兜底为 origin/main，canSubmit 可满足） */
function makeDeps(overrides?: Partial<NewTaskDeps>): NewTaskDeps {
  const base: NewTaskDeps = {
    // 组件只消费 currentCwd / gitInfo.branch，测试桩经 cast 省略其余字段
    flow: {
      currentCwd: ref('/Code/ws'),
      gitInfo: ref({ branch: 'main' }),
    } as unknown as NewTaskDeps['flow'],
    recentWorkspaces: ref([]),
    listBranches: vi.fn(async () => ({ local: [], remote: ['origin/main', 'origin/dev'], defaultBranch: 'main' })),
    createWorktree: vi.fn(async () => ({ cwd: '/Code/ws/feat-a', branch: 'feat-a' })),
    detectWorkspace: vi.fn(async () => ({
      mode: 'bare-workspace' as const, wsRoot: '/Code/ws', barePath: '/Code/ws/.bare',
      repoRoot: '/Code/ws/main', defaultBranch: 'main',
    })),
    pickDirectory: vi.fn(async () => ({ canceled: true })),
    presets: ref([]),
    defaultPresetId: ref(''),
    presetOpenRequest: ref(0),
    loadPresets: vi.fn(async () => {}),
    setDefaultPreset: vi.fn(async () => {}),
    toast: { error: vi.fn() },
  }
  return overrides ? { ...base, ...overrides } : base
}

/** 挂载到 body 并等 onMounted 的 detectWorkspace/listBranches 异步链路落定 */
async function mountModal(deps: NewTaskDeps) {
  const wrapper = mount(CreateWorktreeModal, {
    global: { provide: { [NewTaskDepsKey]: deps } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

/** body 内按选择器取 DOMWrapper（teleport 内容不在 VTU 组件树内） */
function bySel(sel: string): DOMWrapper<Element> {
  const el = document.querySelector(sel)
  if (!el) throw new Error(`probe: ${sel} not found in document.body`)
  return new DOMWrapper(el)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('CreateWorktreeModal Enter 提交', () => {
  it('创建按钮 type="submit" 且在 form 内（浏览器 Enter 隐式提交的接线前提）', async () => {
    const wrapper = await mountModal(makeDeps())
    const btn = bySel('[data-testid="worktree-create-btn"]')
    expect(btn.attributes('type')).toBe('submit')
    // 按钮 submit 的最近 form 祖先即 modal form（Enter 目标链路）
    expect(btn.element.closest('form')).not.toBeNull()
    wrapper.unmount()
  })

  it('填分支名后 form submit（Enter 等价链路）→ createWorktree 调用 + 进入 progress 态', async () => {
    const deps = makeDeps()
    const wrapper = await mountModal(deps)
    // 填分支名 → canSubmit 满足（baseBranch 已由 detectWorkspace 兜底 origin/main）
    await bySel('[data-testid="worktree-branch-input"]').setValue('feat-a')
    expect(bySel('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeUndefined()
    // Enter 的浏览器等价：form submit 事件
    await bySel('form').trigger('submit')
    await flushPromises()
    expect(deps.createWorktree).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'feat-a',
      baseBranch: 'origin/main',
      locationMode: 'workspace',
    }))
    // 用户可见：mock 立即 resolve，已从 progress 转入 success 态（成功提示出现）
    expect(document.querySelector('[data-testid="worktree-success"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('分支名为空时 submit 不触发创建（守卫与按钮 disabled 一致）', async () => {
    const deps = makeDeps()
    const wrapper = await mountModal(deps)
    expect(bySel('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
    await bySel('form').trigger('submit')
    await flushPromises()
    expect(deps.createWorktree).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
