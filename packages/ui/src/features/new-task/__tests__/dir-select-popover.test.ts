/**
 * DirSelectPopover 首屏冒烟（C-NT-5，w4 new-task-search UI 迁移）。
 *
 * 首屏冒烟：mount DirSelectPopover + provide NewTaskDepsKey（mock deps，
 * recentWorkspaces=ref 2 条），断言 [data-testid=dir-select-popover] +
 * [data-testid=workspace-item] DOM 存在（列表渲染）；records=[] 时空态存在。
 * 断言 DOM 结构（data-testid），不断言文案（vitest.setup mock vue-i18n）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/new-task
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import DirSelectPopover from '../DirSelectPopover.vue'
import { NewTaskDepsKey, type NewTaskDeps } from '../new-task-deps'
import type { RecentWorkspaceRecord } from '@taiji/shared'

/** 构造 mock NewTaskDeps（每测试独立实例；flow 用空鸭子对象，DirSelectPopover 不消费 flow） */
function makeDeps(overrides?: Partial<NewTaskDeps>): NewTaskDeps {
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
    const deps = makeDeps({ recentWorkspaces: ref(sampleWorkspaces()) })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    expect(wrapper.find('[data-testid="dir-select-popover"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-item"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="workspace-item"]').length).toBe(2)
  })

  it('空态：records=[] 时 empty-state DOM 存在', () => {
    const deps = makeDeps({ recentWorkspaces: ref([]) })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    expect(wrapper.find('[data-testid="dir-select-popover"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-item"]').exists()).toBe(false)
  })

  it('搜索过滤：输入命中列表子串，过滤后只显匹配项', async () => {
    const deps = makeDeps({ recentWorkspaces: ref(sampleWorkspaces()) })
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
    const deps = makeDeps({
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
    const deps = makeDeps({
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
    const full = makeDeps({
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
    const deps = makeDeps({ defaultSessionDir: ref('/data/defaultSession') })
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    expect(wrapper.find('[data-testid="action-default-session"]').exists()).toBe(true)
    await wrapper.find('[data-testid="action-default-session"]').trigger('click')
    expect(wrapper.emitted('select-default')).toHaveLength(1)

    const hidden = mount(DirSelectPopover, {
      props: { currentCwd: null },
      global: { provide: { [NewTaskDepsKey]: makeDeps({ defaultSessionDir: ref('') }) } },
    })
    expect(hidden.find('[data-testid="action-default-session"]').exists()).toBe(false)
  })
})
