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
    listBranches: vi.fn(async () => ({ local: [], remote: ['origin/main', 'origin/dev'], defaultBranch: 'main', defaultBaseRef: 'origin/main' })),
    createWorktree: vi.fn(async () => ({ cwd: '/Code/ws/feat-a', branch: 'feat-a' })),
    detectWorkspace: vi.fn(async () => ({
      mode: 'bare-workspace' as const, wsRoot: '/Code/ws', barePath: '/Code/ws/.bare',
      repoRoot: '/Code/ws/main', defaultBranch: 'main', defaultBaseRef: 'origin/main',
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

  it('分支名为空时 submit 不触发创建（检查与按钮 disabled 一致）', async () => {
    const deps = makeDeps()
    const wrapper = await mountModal(deps)
    expect(bySel('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
    await bySel('form').trigger('submit')
    await flushPromises()
    expect(deps.createWorktree).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('CreateWorktreeModal 仓库检测失败态（≠ not-repo）', () => {
  it('detectWorkspace 抛错 → 显示检测失败态而非「不在仓库」，console.warn 留痕，依赖仓库的控件禁用', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const deps = makeDeps({
        detectWorkspace: vi.fn(async () => {
          throw new Error('detect boom')
        }),
      })
      const wrapper = await mountModal(deps)
      // 第三态：失败块渲染，not-repo 块不渲染（两态可区分，不误导用户换目录）
      expect(document.querySelector('[data-testid="repo-detect-failed"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="repo-not-repo"]')).toBeNull()
      // 检测失败留痕（warn），非静默
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('detectWorkspace failed'),
        expect.any(Error),
      )
      // 依赖仓库语义的控件禁用（分支输入框），创建按钮因 baseBranch 空保持禁用
      expect(bySel('[data-testid="worktree-branch-input"]').attributes('disabled')).toBeDefined()
      expect(bySel('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
      wrapper.unmount()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('CreateWorktreeModal 默认基线推导（defaultBaseRef，不自拼 origin/ 前缀）', () => {
  it('onMounted：listBranches 失败 → warn 留痕，base 保留 detect 推导的 defaultBaseRef（不阻断表单）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const deps = makeDeps({
        detectWorkspace: vi.fn(async () => ({
          mode: 'bare-workspace' as const, wsRoot: '/Code/ws', barePath: '/Code/ws/.bare',
          repoRoot: '/Code/ws/main', defaultBranch: 'main', defaultBaseRef: 'github/main',
        })),
        listBranches: vi.fn(async () => {
          throw new Error('branches boom')
        }),
      })
      const wrapper = await mountModal(deps)
      // 用户可见：base trigger 显示 detect 推导值（分支加载失败不阻断，也不回落 origin/ 拼接）
      expect(bySel('[data-testid="worktree-base-trigger"]').text()).toContain('github/main')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('listBranches failed, keeping detect-derived base'),
        expect.any(Error),
      )
      wrapper.unmount()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('plain-repo 换仓库 → base 重推导为新仓库的 defaultBaseRef（detect 与 listBranches 两级实况推导）', async () => {
    const deps = makeDeps({
      detectWorkspace: vi.fn()
        // 初始挂载：plain-repo（repo-change-btn 只在此态渲染）
        .mockResolvedValueOnce({
          mode: 'plain-repo' as const, wsRoot: '', barePath: '', repoRoot: '/Code/myrepo',
          defaultBranch: 'main', defaultBaseRef: 'origin/main',
        })
        // 换仓库后的 detect：新仓库远端名非 origin，defaultBaseRef = github/main
        .mockResolvedValueOnce({
          mode: 'plain-repo' as const, wsRoot: '', barePath: '', repoRoot: '/Code/other',
          defaultBranch: 'main', defaultBaseRef: 'github/main',
        }),
      pickDirectory: vi.fn(async () => ({ canceled: false, path: '/Code/other' })),
      // listBranches 按调用次序区分：初始挂载（/Code/myrepo）与换仓库后（/Code/other）；
      // 换仓库后返回与 detect 不同值，证明第二级赋值同样走 defaultBaseRef 分支
      listBranches: vi.fn()
        .mockResolvedValueOnce({ local: [], remote: ['origin/main'], defaultBranch: 'main', defaultBaseRef: 'origin/main' })
        .mockResolvedValueOnce({ local: [], remote: ['github/main', 'github/dev'], defaultBranch: 'main', defaultBaseRef: 'github/dev' }),
    })
    const wrapper = await mountModal(deps)
    expect(bySel('[data-testid="worktree-base-trigger"]').text()).toContain('origin/main')
    await bySel('[data-testid="repo-change-btn"]').trigger('click')
    await flushPromises()
    // detect 以新选路径重检
    expect(deps.detectWorkspace).toHaveBeenLastCalledWith('/Code/other')
    // 用户可见：base 换到新仓库实况推导的基线（listBranches 级 defaultBaseRef 生效，
    // 语义 = 无 origin/ 自拼——远端名 github 的仓库 base 不再落在幽灵 origin/* 上）
    expect(bySel('[data-testid="worktree-base-trigger"]').text()).toContain('github/dev')
    wrapper.unmount()
  })
})

describe('CreateWorktreeModal success 时序契约（切换与创建成功同刻，不依赖定时器）', () => {
  // [HISTORICAL] 旧链路 success emit 挂在 2s 展示定时器上且卸载即取消：用户在窗口内关
  // modal（Esc/点外/切 session）→ 切换静默丢失。现契约：success 同步 emit，定时器只负责 close。
  it('创建成功后 success 立即 emit（不等 2s），成功屏同步出现', async () => {
    vi.useFakeTimers()
    try {
      const deps = makeDeps()
      const wrapper = await mountModal(deps)
      await bySel('[data-testid="worktree-branch-input"]').setValue('feat-a')
      await bySel('form').trigger('submit')
      await flushPromises()
      // 未推进定时器：success 已同步送达（父层回灌 pendingCwd 的依据），成功屏已渲染
      expect(wrapper.emitted('success')).toEqual([[{ cwd: '/Code/ws/feat-a' }]])
      expect(wrapper.emitted('close')).toBeUndefined()
      expect(document.querySelector('[data-testid="worktree-success"]')).not.toBeNull()
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('成功屏展示窗（2s）后 emit close 恰一次，不重复 emit success', async () => {
    vi.useFakeTimers()
    try {
      const deps = makeDeps()
      const wrapper = await mountModal(deps)
      await bySel('[data-testid="worktree-branch-input"]').setValue('feat-a')
      await bySel('form').trigger('submit')
      await flushPromises()
      vi.advanceTimersByTime(1999)
      expect(wrapper.emitted('close')).toBeUndefined()
      vi.advanceTimersByTime(1)
      expect(wrapper.emitted('close')).toHaveLength(1)
      expect(wrapper.emitted('success')).toHaveLength(1)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('窗口内卸载（提前关）安全：success 已先期送达，卸载不补发不重复', async () => {
    vi.useFakeTimers()
    try {
      const deps = makeDeps()
      const wrapper = await mountModal(deps)
      await bySel('[data-testid="worktree-branch-input"]').setValue('feat-a')
      await bySel('form').trigger('submit')
      await flushPromises()
      expect(wrapper.emitted('success')).toHaveLength(1) // 切换已同步送达
      // 卸载（模拟用户提前关 modal）：清掉的只是延迟 close 定时器；success 已在
      // 创建成功同刻发出，不存在「卸载吞切换」面（切换不依赖后续任何事件）。
      wrapper.unmount()
      vi.advanceTimersByTime(5000) // 若定时器未清也不会有观察者——仅验证不抛错
    } finally {
      vi.useRealTimers()
    }
  })
})
