import type { Project } from '@taiji/shared';
import type { RecentWorkspaceRecord } from '@taiji/shared';
import { Popover } from '../../../primitives/popover';
import CreateWorktreeModal from '../CreateWorktreeModal.vue';
import DirSelectPopover from '../DirSelectPopover.vue';
import PresetSelectChip from '../PresetSelectChip.vue';
import ProjectSelectChip from '../ProjectSelectChip.vue';
import { NewTaskDepsKey, type NewTaskDeps } from '../new-task-deps';
import { resolveLaunchConfig } from '@taiji/core';
import { BUILTIN_PRESET_IDS, DEFAULT_PRESETS, type PiLaunchPreset } from '@taiji/shared';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← create-worktree-modal.test.ts
// ======================================================================

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
    setPinned: vi.fn(async () => true),
    defaultSessionDir: ref(''),
    projects: ref([]),
    activeProjectId: ref('proj-default'),
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

// ======================================================================
// ← dir-select-popover.test.ts
// ======================================================================

/** 构造 mock NewTaskDeps（每测试独立实例；flow 用空鸭子对象，DirSelectPopover 不消费 flow） */
function makeDeps_m2(overrides?: Partial<NewTaskDeps>): NewTaskDeps {
  const base: NewTaskDeps = {
    flow: {} as NewTaskDeps['flow'],
    recentWorkspaces: ref<RecentWorkspaceRecord[]>([]),
    listBranches: vi.fn(async () => ({ local: [], remote: [], defaultBranch: 'main' })),
    createWorktree: vi.fn(async () => ({ cwd: '', branch: '' })),
    detectWorkspace: vi.fn(async () => ({
      mode: 'not-repo' as const, wsRoot: '', barePath: '', repoRoot: '', defaultBranch: '',
    })),
    pickDirectory: vi.fn(async () => ({ canceled: true })),
    presets: ref([]),
    defaultPresetId: ref(''),
    presetOpenRequest: ref(0),
    loadPresets: vi.fn(async () => {}),
    setDefaultPreset: vi.fn(async () => {}),
    setPinned: vi.fn(async () => true),
    defaultSessionDir: ref(''),
    projects: ref([]),
    activeProjectId: ref('proj-default'),
    toast: { error: vi.fn() },
  }
  return overrides ? { ...base, ...overrides } : base
}

function sampleWorkspaces(): RecentWorkspaceRecord[] {
  const ts = 1_700_000_000_000
  return [
    { cwd: '/Code/chat_project', lastUsedAt: ts, label: 'chat_project' },
    { cwd: '/Stock/portfolio', lastUsedAt: ts - 1, label: 'portfolio' },
  ]
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('DirSelectPopover 首屏冒烟', () => {
  it('列表渲染：dir-select-popover + workspace-item DOM 存在（2 条最近工作区）', () => {
    const deps = makeDeps_m2({ recentWorkspaces: ref(sampleWorkspaces()) })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    expect(wrapper.find('[data-testid="dir-select-popover"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-item"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="workspace-item"]').length).toBe(2)
  })

  it('空态：records=[] 时 empty-state DOM 存在', () => {
    const deps = makeDeps_m2({ recentWorkspaces: ref([]) })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    expect(wrapper.find('[data-testid="dir-select-popover"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-item"]').exists()).toBe(false)
  })

  it('搜索过滤：输入命中列表子串，过滤后只显匹配项', async () => {
    const deps = makeDeps_m2({ recentWorkspaces: ref(sampleWorkspaces()) })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    const input = wrapper.find('[data-testid="dir-select-popover"] input')
    expect(input.exists()).toBe(true)
    await input.setValue('portfolio')
    expect(wrapper.findAll('[data-testid="workspace-item"]').length).toBe(1)
    expect(wrapper.text()).toContain('portfolio')
  })
})

describe('DirSelectPopover pin / 默认会话（2026-10-22）', () => {
  it('已固定区置顶渲染（pinnedGroup 头 + pinned 条目在前），pin 按钮悬停挂载', () => {
    const ts = 1_700_000_000_000
    const deps = makeDeps_m2({
      recentWorkspaces: ref([
        { cwd: '/Code/pinned-one', lastUsedAt: ts - 10, label: 'pinned-one', pinned: true },
        { cwd: '/Code/recent-one', lastUsedAt: ts, label: 'recent-one' },
      ]),
    })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    expect(wrapper.find('[data-testid="dir-select-popover"]').text()).toContain('pinnedGroup')
    const items = wrapper.findAll('[data-testid="workspace-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('pinned-one') // pinned 置前
    expect(wrapper.find('[data-testid="workspace-pin-off"]').exists()).toBe(true) // pinned 行的取消固定钮
    expect(wrapper.find('[data-testid="workspace-pin-on"]').exists()).toBe(true) // recent 行同显固定钮（统一渲染：所有行均可 pin）
  })

  it('点击未 pinned 行的 pin 钮 → 调 setPinned(cwd, true)；超上限（已 5 个）→ toast 不调用 setPinned', async () => {
    const ts = 1_700_000_000_000
    const setPinned = vi.fn(async () => true)
    const toastError = vi.fn()
    const deps = makeDeps_m2({
      recentWorkspaces: ref([{ cwd: '/Code/a', lastUsedAt: ts, label: 'a' }]),
      setPinned,
      toast: { error: toastError },
    })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await wrapper.find('[data-testid="workspace-pin-on"]').trigger('click')
    expect(setPinned).toHaveBeenCalledWith('/Code/a', true)

    // 上限镜像：组件内 PIN_LIMIT=5，5 个已 pin 时点击 → toast + 不调 setPinned
    const full = makeDeps_m2({
      recentWorkspaces: ref([
        ...Array.from({ length: 5 }, (_, i) => ({ cwd: `/p${i}`, lastUsedAt: ts - i, label: `p${i}`, pinned: true })),
        { cwd: '/Code/a', lastUsedAt: ts, label: 'a' },
      ]),
      setPinned,
      toast: { error: toastError },
    })
    const w2 = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: full } },
    })
    await w2.find('[data-testid="workspace-pin-on"]').trigger('click')
    expect(toastError).toHaveBeenCalled()
  })

  it('defaultSessionDir 非空 → 默认会话动作行渲染，点击 emit select-default；空串 → 隐藏', async () => {
    const deps = makeDeps_m2({ defaultSessionDir: ref('/data/defaultSession') })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    expect(wrapper.find('[data-testid="action-default-session"]').exists()).toBe(true)
    await wrapper.find('[data-testid="action-default-session"]').trigger('click')
    expect(wrapper.emitted('select-default')).toHaveLength(1)

    const hidden = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: makeDeps_m2({ defaultSessionDir: ref('') }) } },
    })
    expect(hidden.find('[data-testid="action-default-session"]').exists()).toBe(false)
  })

  it('setPinned 返回 false（store 层超上限被拒）→ toast 上限提示（调用后拒绝链路）', async () => {
    const ts = 1_700_000_000_000
    const setPinned = vi.fn(async () => false)
    const toastError = vi.fn()
    const deps = makeDeps_m2({
      recentWorkspaces: ref([{ cwd: '/Code/a', lastUsedAt: ts, label: 'a' }]),
      setPinned,
      toast: { error: toastError },
    })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await wrapper.find('[data-testid="workspace-pin-on"]').trigger('click')
    await flushPromises()
    expect(setPinned).toHaveBeenCalledWith('/Code/a', true)
    expect(toastError).toHaveBeenCalled()
  })
})

// ── 键盘导航与交互链（useFlatListNav 契约 + 行动作，2026-10-22）──────────────

describe('DirSelectPopover 键盘导航 / 行交互', () => {
  const ts = 1_700_000_000_000

  function mountWith(overrides?: Partial<NewTaskDeps>) {
    const deps = makeDeps_m2({
      recentWorkspaces: ref([
        { cwd: '/Code/pinned-one', lastUsedAt: ts - 10, label: 'pinned-one', pinned: true },
        { cwd: '/Code/recent-one', lastUsedAt: ts, label: 'recent-one' },
      ]),
      defaultSessionDir: ref('/data/defaultSession'),
      ...overrides,
    })
    return mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
  }

  it('↑↓/Enter 扁平序激活：pinned 项 → recent 项 → 默认会话 → 打开文件夹（四分支各 emit）', async () => {
    const wrapper = mountWith()
    const root = wrapper.find('[data-testid="dir-select-popover"]')
    await root.trigger('keydown', { key: 'Enter' }) // idx0 = pinned 项
    await root.trigger('keydown', { key: 'ArrowDown' })
    await root.trigger('keydown', { key: 'Enter' }) // idx1 = recent 项
    await root.trigger('keydown', { key: 'ArrowDown' })
    await root.trigger('keydown', { key: 'Enter' }) // idx2 = 默认会话动作项
    await root.trigger('keydown', { key: 'ArrowDown' })
    await root.trigger('keydown', { key: 'Enter' }) // idx3 = 打开文件夹
    expect(wrapper.emitted('select')).toEqual([[{ cwd: '/Code/pinned-one' }], [{ cwd: '/Code/recent-one' }]])
    expect(wrapper.emitted('select-default')).toHaveLength(1)
    expect(wrapper.emitted('open-dir-dialog')).toHaveLength(1)
  })

  it('点击列表项 → emit select({cwd})；悬停行 → activeIndex 跟随（焦点高亮 bg-surface-hover）', async () => {
    const wrapper = mountWith()
    const items = wrapper.findAll('[data-testid="workspace-item"]')
    await items[1]!.trigger('mouseenter')
    expect(items[1]!.classes()).toContain('bg-surface-hover')
    await items[1]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([[{ cwd: '/Code/recent-one' }]])
  })

  it('悬停默认会话动作行 → activeIndex 移到该行（defaultSessionIdx 扁平索引）', async () => {
    const wrapper = mountWith()
    await wrapper.find('[data-testid="action-default-session"]').trigger('mouseenter')
    expect(wrapper.find('[data-testid="action-default-session"]').classes()).toContain('bg-surface-hover')
  })
})

// ======================================================================
// ← preset-select-chip.test.ts
// ======================================================================

/** 构造 mock NewTaskDeps（flow 只需 pendingPreset 只读视图——重入同步 watch 的观察源） */
function makeDeps_m3(overrides?: Partial<NewTaskDeps>): NewTaskDeps {
  const base: NewTaskDeps = {
    flow: { pendingPreset: ref<string | null>(null) } as NewTaskDeps['flow'],
    recentWorkspaces: ref([]),
    listBranches: vi.fn(async () => ({ local: [], remote: [], defaultBranch: 'main' })),
    createWorktree: vi.fn(async () => ({ cwd: '', branch: '' })),
    detectWorkspace: vi.fn(async () => ({
      mode: 'not-repo' as const, wsRoot: '', barePath: '', repoRoot: '', defaultBranch: '',
    })),
    pickDirectory: vi.fn(async () => ({ canceled: true })),
    presets: ref<PiLaunchPreset[]>([]),
    defaultPresetId: ref(''),
    presetOpenRequest: ref(0),
    loadPresets: vi.fn(async () => {}),
    setDefaultPreset: vi.fn(async () => {}),
    setPinned: vi.fn(async () => true),
    defaultSessionDir: ref(''),
    projects: ref([]),
    activeProjectId: ref('proj-default'),
    toast: { error: vi.fn() },
  }
  return overrides ? { ...base, ...overrides } : base
}

/**
 * 样例预设：出厂 full 原样（isFactoryFullPreset 全等 → resolve 输出 presetId=undefined，
 * D3 不透传形态）+ 自定义预设（name「只读模式」，非出厂 → 正常透传 id）。
 */
function samplePresets(): PiLaunchPreset[] {
  const factoryFull = DEFAULT_PRESETS.find((p) => p.id === BUILTIN_PRESET_IDS.FULL)
  if (!factoryFull) throw new Error('DEFAULT_PRESETS 缺 builtin:full（shared 常量损坏）')
  return [
    factoryFull,
    {
      id: 'custom:read-only', name: '只读模式', description: '仅阅读', builtin: false, order: 9,
      toolMode: 'denylist', deniedTools: ['*'], extensionMode: 'none',
    },
  ]
}

/** 同源解析：与组件 displayPresetId 相同的输入调 resolveLaunchConfig，取显示语义 id。 */
function resolveDisplayPresetId(input: {
  pendingPreset?: string | null
  presets: PiLaunchPreset[]
  defaultPresetId?: string | null
}): string {
  const resolved = resolveLaunchConfig(input)
  return (
    resolved.presetId ??
    (input.presets.some((p) => p.id === BUILTIN_PRESET_IDS.FULL) ? BUILTIN_PRESET_IDS.FULL : '')
  )
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('PresetSelectChip 首屏冒烟', () => {
  it('landing 态：chip-preset DOM 存在（loadPresets 拉数据，回显无手动写入）', async () => {
    const deps = makeDeps_m3({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises() // onMounted → loadPresets（回显由 resolve 响应式视图自动完成）
    expect(wrapper.find('[data-testid="chip-preset"]').exists()).toBe(true)
    expect(deps.loadPresets).toHaveBeenCalled()
  })

  it('landing 态 Popover 展开：预设选项 DOM 存在（Teleport 到 body，断言 document.body）', async () => {
    const deps = makeDeps_m3({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: true },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(document.querySelector('[data-testid="preset-option-builtin:full"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="preset-option-custom:read-only"]')).not.toBeNull()
  })
})

describe('PresetSelectChip 回显 = resolve 输出（U2c，D3 默认预设生效化）', () => {
  it('未显式选择：chip 显示默认预设解析档（displayPresetId = resolve 输出）', async () => {
    const presets = samplePresets()
    const deps = makeDeps_m3({
      presets: ref(presets),
      defaultPresetId: ref('custom:read-only'),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    // 同源断言：resolve 输出的 preset 名 ≡ chip 文本（显示 ≡ 生效的结构锁）
    const displayId = resolveDisplayPresetId({ presets, defaultPresetId: 'custom:read-only' })
    const resolvedName = presets.find((p) => p.id === displayId)?.name ?? displayId
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain(resolvedName)
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })

  it('未设默认（defaultPresetId 空）：resolve 默认链兜底 builtin:full，chip 显示「全工具模式」', async () => {
    // D3 行为变化声明：现状（B6 echo）此场景 selectedPresetId 恒空 → 永显「加载中…」；
    // 改线后显示 = resolve 输出（builtin:full 默认档，出厂等价 presetId=undefined 不透传）
    const presets = samplePresets()
    const deps = makeDeps_m3({
      presets: ref(presets),
      defaultPresetId: ref(''),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(resolveDisplayPresetId({ presets, defaultPresetId: '' })).toBe(BUILTIN_PRESET_IDS.FULL)
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
  })

  it('presets 延迟到达：resolve 响应式重算，chip 脱离「加载中…」（P5①）', async () => {
    const presetsRef = ref<PiLaunchPreset[]>([])
    const defaultRef = ref('')
    const deps = makeDeps_m3({ presets: presetsRef, defaultPresetId: defaultRef })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain(
      'newTask.presetSelect.loadingPresets',
    )
    // 数据到达（loadPresets 写 deps 侧 store）：无任何手动回显，chip 自动重算
    presetsRef.value = samplePresets()
    defaultRef.value = 'custom:read-only'
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })

  it('用户点击：emit select { presetId } + 显示切 explicit 档（显式 > 默认，emit 契约不变）', async () => {
    const presets = samplePresets()
    const deps = makeDeps_m3({
      presets: ref(presets),
      defaultPresetId: ref(''), // 默认档解析为 builtin:full
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: true },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
    // 点击自定义项：显式选择（PopoverListItem Teleport 到 body）
    const option = document.querySelector<HTMLElement>('[data-testid="preset-option-custom:read-only"]')!
    option.click()
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([[{ presetId: 'custom:read-only' }]])
    // 显示切 explicit 档 = resolve 输出（pendingPreset=custom:read-only）
    const displayId = resolveDisplayPresetId({
      pendingPreset: 'custom:read-only', presets, defaultPresetId: '',
    })
    expect(displayId).toBe('custom:read-only')
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })
})

describe('PresetSelectChip 重入同步（G1 破口修复：explicitPresetId 跟随 flow.pendingPreset）', () => {
  it('选 custom-1 → flow.pendingPreset 被外部重置（startFlow 重入）→ chip 回落默认链显示', async () => {
    const presets = samplePresets()
    // 真实 flow.pendingPreset 是只读 computed<string | null>；ref 读取形态兼容，可写模拟重入
    const pendingPreset = ref<string | null>(null)
    const deps = makeDeps_m3({
      flow: { pendingPreset } as NewTaskDeps['flow'],
      presets: ref(presets),
      defaultPresetId: ref(''), // 默认档解析为 builtin:full
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: true },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
    // ① 用户显式选择 custom:read-only：emit + Landing 侧 setPendingPreset 回写 pendingPreset
    document.querySelector<HTMLElement>('[data-testid="preset-option-custom:read-only"]')!.click()
    pendingPreset.value = 'custom:read-only' // Landing.vue onSelectPreset → flow.setPendingPreset
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([[{ presetId: 'custom:read-only' }]])
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
    // ② startFlow 重入（多次 ⌘N / initApp 重试）：Landing 不重挂载（isActive 检查），
    //    flow.pendingPreset 无条件重置为 null——修复前 explicitPresetId 残留旧选择，
    //    chip 显示「只读模式」而 submit 按默认预设创建（显示 ≠ 生效）
    pendingPreset.value = null
    await flushPromises()
    // chip 回落默认链显示（builtin:full），不再残留 explicit 旧值
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
    expect(wrapper.find('[data-testid="chip-preset"]').text()).not.toContain('只读模式')
    // ③ 重置后用户显式点击仍正常 emit（显式选择链路不受同步 watch 影响）
    document.querySelector<HTMLElement>('[data-testid="preset-option-custom:read-only"]')!.click()
    await flushPromises()
    expect(wrapper.emitted('select')).toHaveLength(2)
    expect(wrapper.emitted('select')?.[1]).toEqual([{ presetId: 'custom:read-only' }])
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })

  it('挂载时 pendingPreset 已有显式值（immediate）：chip 显示显式预设，非默认链回落', async () => {
    // 挂载时序变体（immediate:true 的靶场景）：chip 实例在 flow.pendingPreset 已非 null 时
    // 新挂载（如 landing 已有显式选择后新增分屏 pane）。新实例 explicitPresetId 初值 null，
    // watch 无 immediate 时错过首帧真值 → chip 显示默认链（builtin:full）而 submit 消费
    // 显式档——显示 ≠ 生效。immediate 使 watch 挂载即跟随当前真值。
    const presets = samplePresets()
    const pendingPreset = ref<string | null>('custom:read-only')
    const deps = makeDeps_m3({
      flow: { pendingPreset } as NewTaskDeps['flow'],
      presets: ref(presets),
      defaultPresetId: ref(''), // 默认档解析为 builtin:full（回落显示锚点）
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    // 挂载首帧即显示显式档（explicit > 默认链）
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
    expect(wrapper.find('[data-testid="chip-preset"]').text()).not.toContain('全工具模式')
    // immediate 不破坏重置回落路径：外部重置 pendingPreset（startFlow 重入）→ 回落默认链
    pendingPreset.value = null
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
    expect(wrapper.find('[data-testid="chip-preset"]').text()).not.toContain('只读模式')
  })
})

describe('PresetSelectChip 三档退化 + 信任标记跨档不丢（u4a）', () => {
  // 可见文案全部由 renderer 侧经 props 传入（ui 包不耦合 i18n）；此处用固定串模拟 renderer 文案。
  const MODE_NAME = '调度模式'
  const SHORT_NAME = '调度'
  const REPLACE_HINT = '含替换提示词'

  /** 挂载 chip：默认文案 props 齐备；extra 覆盖 density / 信任标记判据等档位开关 */
  function mountChip(extra: Record<string, unknown> = {}) {
    const deps = makeDeps_m3({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    return mount(PresetSelectChip, {
      props: {
        sessionId: null,
        launchPresetId: undefined,
        presetOpen: false,
        modeName: MODE_NAME,
        shortName: SHORT_NAME,
        ...extra,
      },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
  }

  it('① 文本档（full）：显示模式全名 + chip 内替换提示文案，无角标', async () => {
    const wrapper = mountChip({ density: 'full', hasReplacePrompt: true, replaceHint: REPLACE_HINT })
    await flushPromises()
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.text()).toContain(MODE_NAME)
    expect(chip.text()).toContain(REPLACE_HINT)
    // 文本档用内嵌后缀，不出现角标（两档形态互斥）
    expect(chip.find('[data-testid="preset-chip-replace-badge"]').exists()).toBe(false)
  })

  it('①b 短名档（short）：显示短名 + 信任标记仍在（内嵌后缀）', async () => {
    const wrapper = mountChip({ density: 'short', hasReplacePrompt: true, replaceHint: REPLACE_HINT })
    await flushPromises()
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.text()).toContain(SHORT_NAME)
    expect(chip.text()).not.toContain(MODE_NAME)
    expect(chip.text()).toContain(REPLACE_HINT)
  })

  it('② 窄档（icon）：纯图标无可见文本，但信任标记仍以右上角警示色角标存在（+ tooltip）', async () => {
    const wrapper = mountChip({ density: 'icon', accent: true, hasReplacePrompt: true, replaceHint: REPLACE_HINT })
    await flushPromises()
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.text()).not.toContain(MODE_NAME)
    expect(chip.text()).not.toContain(REPLACE_HINT)
    // accent 底跨档保留（非默认模式档，颜色 = 状态）；角标独立于 accent 通道（用 warn 色）
    expect(chip.classes().join(' ')).toContain('bg-accent-soft')
    const badge = chip.find('[data-testid="preset-chip-replace-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('title')).toBe(REPLACE_HINT)
  })

  it('③ 无替换文案：三档均不渲染信任标记（缺省 false / 文案空）', async () => {
    for (const density of ['full', 'short', 'icon'] as const) {
      const wrapper = mountChip({ density })
      await flushPromises()
      const chip = wrapper.find('[data-testid="chip-preset"]')
      expect(chip.find('[data-testid="preset-chip-replace-badge"]').exists()).toBe(false)
      expect(chip.text()).not.toContain(REPLACE_HINT)
    }
    // 判据含「文案非空」：布尔为 true 但文案为空白 → 不渲染空后缀 / 空 tooltip
    const emptyText = mountChip({ density: 'icon', hasReplacePrompt: true, replaceHint: '  ' })
    await flushPromises()
    expect(emptyText.find('[data-testid="preset-chip-replace-badge"]').exists()).toBe(false)
  })

  it('④ 窄档 aria-label / title 保留全名（aria-label 追加信任标记文案；不依赖可见文本）', async () => {
    const wrapper = mountChip({ density: 'icon', hasReplacePrompt: true, replaceHint: REPLACE_HINT })
    await flushPromises()
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.attributes('aria-label')).toContain(MODE_NAME)
    expect(chip.attributes('aria-label')).toContain(REPLACE_HINT)
    expect(chip.attributes('title')).toBe(MODE_NAME)
  })
})

/**
 * 实测自适应 RO 回调链（u4a）：无显式 density 时 onMounted 经 ResizeObserver 观察 chip 自身
 * 宽度落三档（applyMeasuredWidth：≤52 icon / ≤116 short / >116 full）。jsdom 无 RO，既有
 * 用例全走显式 density 分支——本组 stub global.ResizeObserver 驱动真实回调链：
 * RO 建立（observe 目标 = chip 根 button）→ 回调落档（含 52/116/117 边界值）→
 * unmount disconnect，及显式 density 时跳过 RO 建立的短路分支。
 */
describe('PresetSelectChip 实测自适应（RO 回调链：建立 → 三档落档 → disconnect）', () => {
  const MODE_NAME = '调度模式'
  const SHORT_NAME = '调度'

  /** 捕获型 RO stub：收集实例本体（回调 + observed 元素 + disconnect 计数）供断言 */
  interface MockROInstance {  // oe-exempt:20261027:test:
    callback: ResizeObserverCallback
    observed: Element[]
    disconnectCalls: number
  }
  function stubResizeObserver(): MockROInstance[] {
    const instances: MockROInstance[] = []
    class MockResizeObserver implements MockROInstance {
      observed: Element[] = []
      disconnectCalls = 0
      callback: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.callback = cb
        instances.push(this) // 收集实例本体：disconnect 计数须落在组件实际调用的同一对象上
      }
      observe(el: Element): void {
        this.observed.push(el)
      }
      unobserve(): void {}
      disconnect(): void {
        this.disconnectCalls++
      }
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    return instances
  }

  /** 触发捕获的 RO 回调（组件取 entries[0].contentRect.width 落档） */
  function emitWidth(instances: MockROInstance[], width: number) {
    const entry = { contentRect: { width } } as ResizeObserverEntry
    instances[instances.length - 1]!.callback([entry], {} as ResizeObserver)
  }

  function mountAuto() {
    const deps = makeDeps_m3({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    return mount(PresetSelectChip, {
      props: {
        sessionId: null,
        launchPresetId: undefined,
        presetOpen: false,
        modeName: MODE_NAME,
        shortName: SHORT_NAME,
        // 不传 density：走 RO 实测自适应分支
      },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('① 无显式 density：挂载建立 RO（observe chip 根 button）', async () => {
    const instances = stubResizeObserver()
    const wrapper = mountAuto()
    await flushPromises()
    expect(instances).toHaveLength(1)
    // observe 目标 = chip 根 button（Button ref → $el）
    const chipEl = wrapper.find('[data-testid="chip-preset"]').element
    expect(instances[0]!.observed).toContain(chipEl)
  })

  it('② 回调落档三档边界：52→icon、116→short、117→full（阈值含边界语义）', async () => {
    const instances = stubResizeObserver()
    const wrapper = mountAuto()
    await flushPromises()
    const chip = () => wrapper.find('[data-testid="chip-preset"]')

    // ≤52 → icon：纯图标（无文本 span），title = 全名
    emitWidth(instances, 52)
    await flushPromises()
    expect(chip().find('span.font-mono').exists()).toBe(false)
    expect(chip().attributes('title')).toBe(MODE_NAME)

    // 53..116 → short：显示短名，title 已非 icon 档（清空）
    emitWidth(instances, 116)
    await flushPromises()
    expect(chip().find('span.font-mono').text()).toBe(SHORT_NAME)
    expect(chip().attributes('title')).toBeUndefined()

    // >116（117 边界外一格）→ full：显示全名
    emitWidth(instances, 117)
    await flushPromises()
    expect(chip().find('span.font-mono').text()).toBe(MODE_NAME)
  })

  it('③ unmount 断开观察（disconnect 恰一次）', async () => {
    const instances = stubResizeObserver()
    const wrapper = mountAuto()
    await flushPromises()
    expect(instances[0]!.disconnectCalls).toBe(0)
    wrapper.unmount()
    expect(instances[0]!.disconnectCalls).toBe(1)
  })

  it('④ 显式 density 时短路：不建立 RO（jsdom 外显式档也跳过实测）', async () => {
    const instances = stubResizeObserver()
    const deps = makeDeps_m3({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    mount(PresetSelectChip, {
      props: {
        sessionId: null,
        launchPresetId: undefined,
        presetOpen: false,
        density: 'full',
      },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(instances).toHaveLength(0)
  })
})

/**
 * 模式 chip 底色（方案 B：默认模式中性底 / 非默认模式 accent 底）。
 *
 * 设计 §5.1「颜色即状态」：accent 底只在**非默认模式**档出现，颜色才携带信息（恒亮 = 无色差
 * = 用户读不出状态）。判据由 renderer 侧算好经 `accent` prop 传入（本包只按 prop 出样式），
 * 故断言分两向：缺省/false → 无 accent 底 + 中性文字档；true → accent 底原样（非默认模式零变化）。
 * ① 是反向断言（防将来又退回「无条件 accent 底」）；② 守住 accent 档的既有形态不被顺手改掉。
 */
describe('PresetSelectChip 模式 chip 底色（accent prop：默认中性 / 非默认 accent）', () => {
  function mountTone(accent?: boolean) {
    const deps = makeDeps_m3({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    return mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false, accent },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
  }

  it('① 默认模式（accent 缺省 false）：无 accent 底，文字走中性档 + 邻位 chip 同款 hover 反馈', async () => {
    const wrapper = mountTone()
    await flushPromises()
    const cls = wrapper.find('[data-testid="chip-preset"]').classes().join(' ')
    // 反向断言：默认档不得有 accent 底/强调文字（否则「颜色即状态」恒亮失效）
    expect(cls).not.toContain('bg-accent-soft')
    expect(cls).not.toContain('text-accent')
    // 中性档 = 与 landing 首行邻位 chip（chip-directory / chip-branch）同一套反馈
    expect(cls).toContain('text-neutral-mid')
    expect(cls).toContain('hover:bg-surface-hover')
    expect(cls).toContain('hover:text-neutral-fg')
  })

  it('①b 显式 accent=false：与缺省同档（默认模式中性底，非默认模式外观零变化）', async () => {
    const wrapper = mountTone(false)
    await flushPromises()
    const cls = wrapper.find('[data-testid="chip-preset"]').classes().join(' ')
    expect(cls).not.toContain('bg-accent-soft')
    expect(cls).toContain('text-neutral-mid')
  })

  it('② 非默认模式（accent=true）：保留 accent 底 + 强调文字 + accent hover（逐字原样）', async () => {
    const wrapper = mountTone(true)
    await flushPromises()
    const cls = wrapper.find('[data-testid="chip-preset"]').classes().join(' ')
    expect(cls).toContain('bg-accent-soft')
    expect(cls).toContain('text-accent')
    expect(cls).toContain('hover:bg-accent-soft')
    expect(cls).not.toContain('text-neutral-mid')
  })
})

// ======================================================================
// ← project-select-chip.test.ts
// ======================================================================

const sampleProjects: Project[] = [
  { id: 'proj-a', name: 'Project A', lastUsedAt: 2 },
  { id: 'proj-b', name: 'Project B', lastUsedAt: 1 },
  { id: 'proj-default', name: '', lastUsedAt: 0 },
]

function makeDeps_m4(overrides?: Partial<NewTaskDeps>): NewTaskDeps {
  const base: NewTaskDeps = {
    flow: {
      pendingProjectId: ref(null),
    } as NewTaskDeps['flow'],
    recentWorkspaces: ref([]),
    setPinned: vi.fn(async () => true),
    defaultSessionDir: ref(''),
    listBranches: vi.fn(async () => ({ local: [], remote: [], defaultBranch: 'main' })),
    createWorktree: vi.fn(async () => ({ cwd: '', branch: '' })),
    detectWorkspace: vi.fn(async () => ({
      mode: 'not-repo' as const, wsRoot: '', barePath: '', repoRoot: '', defaultBranch: '',
    })),
    pickDirectory: vi.fn(async () => ({ canceled: true })),
    presets: ref([]),
    defaultPresetId: ref(''),
    presetOpenRequest: ref(0),
    loadPresets: vi.fn(async () => {}),
    setDefaultPreset: vi.fn(async () => {}),
    projects: ref(sampleProjects),
    activeProjectId: ref('proj-a'),
    toast: { error: vi.fn() },
  }
  return overrides ? { ...base, ...overrides } : base
}

function mountChip(
  deps: NewTaskDeps,
  props: { sessionId: string | null; projectId?: string },
  /** 展开态挂载（受控 open；PopoverContent lazy 渲染，closed 态下列表项不在 DOM） */
  projectOpen = false,
) {
  return mount(ProjectSelectChip, {
    props: { ...props, projectOpen },
    global: { provide: { [NewTaskDepsKey]: deps } },
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('ProjectSelectChip', () => {
  it('landing 态渲染 chip-project，回显 activeProjectId 锚定档（pendingProjectId=null）', () => {
    const wrapper = mountChip(makeDeps_m4(), { sessionId: null })
    expect(wrapper.find('[data-testid="chip-project"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chip-project"]').text()).toContain('Project A')
  })

  it('显式选择档优先：flow.pendingProjectId 非空时回显它', () => {
    const deps = makeDeps_m4()
    ;(deps.flow.pendingProjectId as ReturnType<typeof ref>).value = 'proj-b'
    const wrapper = mountChip(deps, { sessionId: null })
    expect(wrapper.find('[data-testid="chip-project"]').text()).toContain('Project B')
  })

  it('默认项目 name 空串 → 回显默认项目文案档（projects 里 name 空的条目不裸显空名）', () => {
    const deps = makeDeps_m4({ activeProjectId: ref('proj-default') })
    const wrapper = mountChip(deps, { sessionId: null })
    const text = wrapper.find('[data-testid="chip-project"]').text()
    expect(text).not.toBe('')
  })

  it('点击项目项 → emit select({projectId})', async () => {
    const wrapper = mountChip(makeDeps_m4(), { sessionId: null }, true)
    await flushPromises() // PopoverContent Teleport 到 body（PresetSelectChip 测试同款手法：flush 后 document.querySelector + 原生 click）
    const option = document.querySelector<HTMLElement>('[data-testid="project-option-proj-b"]')
    expect(option).not.toBeNull()
    option!.click()
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([[{ projectId: 'proj-b' }]])
  })

  it('已创建态（projectId 有值）→ 锁定 chip-project-locked，无 popover', () => {
    const wrapper = mountChip(makeDeps_m4(), { sessionId: 's1', projectId: 'proj-a' })
    expect(wrapper.find('[data-testid="chip-project-locked"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chip-project"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chip-project-locked"]').text()).toContain('Project A')
  })

  it('历史态（projectId undefined）→ 锁定形态渲染且不崩', () => {
    const wrapper = mountChip(makeDeps_m4(), { sessionId: 's1' })
    expect(wrapper.find('[data-testid="chip-project-locked"]').exists()).toBe(true)
  })

  it('popover open 变化回传 update:projectOpen（v-model:projectOpen 透传，flow 状态机互斥驱动）', async () => {
    const wrapper = mountChip(makeDeps_m4(), { sessionId: null })
    wrapper.findComponent(Popover).vm.$emit('update:open', true)
    await flushPromises()
    expect(wrapper.emitted('update:projectOpen')).toEqual([[true]])
  })

  // 悬停 tooltip 打开（portal 挂 body，vue-test-utils 树外）：reka HoverCardTrigger 监听
  // pointerenter（SystemNotice.test 同款手法），open-delay 200ms 后 vi.waitFor 轮询 document。
  it('锁定态悬停 → HoverCard tooltip 渲染归属提示；历史态加注（未记录归属）', async () => {
    const wrapper = mountChip(makeDeps_m4(), { sessionId: 's1', projectId: 'proj-a' })
    try {
      await wrapper.find('[data-testid="chip-project-locked"]').trigger('pointerenter')
      // reka HoverCardContent 无 role 语义（探针核实）：外层 popper wrapper 是唯一稳定锚点
      const tooltip = await vi.waitFor(
        () => {
          const el = document.querySelector<HTMLElement>('[data-reka-popper-content-wrapper]')
          expect(el).not.toBeNull()
          return el!
        },
        { interval: 1 },
      )
      // vue-i18n mock 回 key + 命名参数追加：锁定提示含归属项目名（显示 ≡ 归属真源）
      expect(tooltip.textContent).toContain('Project A')

      // 历史态（projectId undefined）→ 加注文案拼接（legacy 后缀段进入 tooltip）
      const legacy = mountChip(makeDeps_m4(), { sessionId: 's2' })
      try {
        await legacy.find('[data-testid="chip-project-locked"]').trigger('pointerenter')
        await vi.waitFor(() => {
          const tooltips = document.querySelectorAll<HTMLElement>('[data-reka-popper-content-wrapper]')
          expect(tooltips.length).toBe(2)
          expect(tooltips[1]!.textContent).toContain('newTask.projectSelect.legacySessionTooltip')
        }, { interval: 1 })
      } finally {
        legacy.unmount()
      }
    } finally {
      wrapper.unmount()
      document.body.innerHTML = ''
    }
  })
})
