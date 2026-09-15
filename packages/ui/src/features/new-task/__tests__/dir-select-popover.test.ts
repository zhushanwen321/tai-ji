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
