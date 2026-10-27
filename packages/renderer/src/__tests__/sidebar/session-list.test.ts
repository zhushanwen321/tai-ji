/**
 * SessionList.vue 会话列表域测试（单文件多源合并：7 个源文件同 SUT、同目录、mock 相容）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——单文件让全部用例共享一份 SessionList
 * 全树装载与环境初始化；按行为域拆文件会让每个文件各付一次全树装载（每份秒级 CPU，
 * 7 文件合计约 7s 装载 CPU，合并后只装一份）。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - session-list-project-filter.test.ts（项目锚定分组）
 *  - session-list-archive-entry.test.ts（归档入口）
 *  - sidebar-session-dnd.test.ts（拖拽移动归属）
 *  - session-list-default-head.test.ts（默认项目头行）
 *  - session-list-folder-new-session.test.ts（目录行 + 新建按钮）
 *  - session-list-default-zone.test.ts（默认区事件接线）
 *  - session-list-dual-mode.test.ts（A/C 双模式）
 *
 * 各源文件顶层 beforeEach/afterEach（均为幂等重置：pinia 重建 + localStorage 清理 +
 * body 清理 + useRealTimers 兜底）已合并为文件级公共 hook；唯一非幂等项——
 * folder-new-session 的「预置 groups 模式」localStorage.setItem——下沉到该节各 describe
 * 内（作用域与原文件顶层等价，不泄漏到其他节）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { ProjectCommandReply, SessionGroup, SessionSummary } from '@taiji/shared'
import SessionList from '@/components/sidebar/SessionList.vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import { SESSION_DRAG_MIME } from '@/components/sidebar/session-drag'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import { project as projectApi } from '@/api'
import { flipProjectGroupToggle } from '../helpers/sidebar-mount'

// 命令化（connection-datasync-ssot §6.6）：组头点击切锚定走 setActiveProject 命令——
// mock 门面 project 域，用例按需以受控回执驱动
vi.mock('@/api', () => ({
  project: {
    load: vi.fn(),
    createProject: vi.fn(),
    renameProject: vi.fn(),
    removeProject: vi.fn(),
    setActiveProject: vi.fn(),
  },
}))

const mockSetActive = projectApi.setActiveProject as unknown as ReturnType<typeof vi.fn>

/** 命令回执 helper：以 store 当前视图为基底生成 ProjectCommandReply */
function commandReply(store: ReturnType<typeof useProjectStore>, over: Partial<{ state: { projects: Project[]; activeProjectId: string }; revision: number }> = {}): ProjectCommandReply {
  const base = { state: { projects: store.projects.map((p) => ({ ...p })), activeProjectId: store.activeProjectId }, revision: store.revision + 1 }
  return { ...base, ...over }
}

/** 装载后置 loaded 态（三形态呈现 §6.7：非 loaded 分组区渲染占位/状态条，不渲染分组） */
function markLoaded(store: ReturnType<typeof useProjectStore>): ReturnType<typeof useProjectStore> {
  store.revision = 1
  store.loadState = 'loaded'
  return store
}

/** 装载 loaded 态 + 仅默认项目。供只关心会话行渲染/事件（非项目分组本身）的挂载 helper
 *  使用：会话无 projectId 全部落默认区，与旧「初始态兜底默认组」渲染形态一致——三形态
 *  改造后 idle 态渲染加载占位，这类用例需要显式 loaded 才能看到会话行。 */
function seedDefaultLoaded(): void {
  const store = useProjectStore()
  store.projects = [{ id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }]
  store.activeProjectId = DEFAULT_PROJECT_ID
  markLoaded(store)
}

const SESSION_MODE_KEY = 'taiji:sidebar-session-mode'

// ── 共享 helper（各源文件同构 helper 合并单源；异构 helper 按节重命名，见各节）──

type SessionListWrapper = VueWrapper

function makeSession(id: string, cwd: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    label: `会话 ${id}`,
    cwd,
    status: 'idle',
    lastActiveAt: 1,
    ...over,
  }
}

/** dnd / default-head 两节共用的默认 fixture：/repo 组 sa 归属 proj-a + /free 组 sb 未归类 */
function makeGroups(): SessionGroup[] {
  return [
    { cwd: '/repo', sessions: [makeSession('sa', '/repo', { projectId: 'proj-a' })] },
    { cwd: '/free', sessions: [makeSession('sb', '/free')] },
  ]
}

/** 建默认项目 + 命名项目（names 缺省 = 单 proj-a；project-filter/dnd/default-head 共用形态） */
function setupProjects(activeId: string, names: Array<[string, string]> = [['proj-a', 'Alpha']]) {
  const store = useProjectStore()
  store.projects = [
    { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
    ...names.map(([id, name]) => ({ id, name, lastUsedAt: 0 })),
  ]
  store.activeProjectId = activeId
  return markLoaded(store)
}

/** 定位某项目的分组容器（组体常驻 DOM，text() 断言按组隔离，不受折叠态影响）。
 *  [2026-10-13 方案 A] 默认项目不再渲染 ProjectGroup（无组框）——本 helper 仅适用命名项目。 */
function groupOf(wrapper: SessionListWrapper, projectId: string) {
  return wrapper.find(`[data-testid="project-group"][data-project-id="${projectId}"]`)
}

/** 定位默认项目平铺区（置顶、无组框；用户裁决 2026-10-13：默认项目 = 未归类收件箱） */
function defaultZoneOf(wrapper: SessionListWrapper) {
  return wrapper.find('[data-testid="default-project-flat-zone"]')
}

/** dnd / default-head 共用挂载形态（attachTo：拖拽/portal 交互需真实 document.body 挂载） */
function mountAttachedList(groups: SessionGroup[] = makeGroups()) {
  return mount(SessionList, {
    attachTo: document.body,
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

// 公共 hook（各源文件顶层 hook 的幂等并集；非幂等项见文件头注释）
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:projects')
  localStorage.removeItem(SESSION_MODE_KEY)
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

// ══════════ 来源：session-list-project-filter.test.ts（项目锚定分组） ══════════

/** 同 cwd 组：sa 归属 proj-a，sb 未归类，sc 归属 proj-b（混合归属验证 session 级切分） */
function makeProjectFilterGroups(): SessionGroup[] {
  return [
    {
      cwd: '/repo',
      sessions: [
        makeSession('sa', '/repo', { projectId: 'proj-a' }),
        makeSession('sb', '/repo'), // 未归类
        makeSession('sc', '/repo', { projectId: 'proj-b' }),
      ],
    },
    {
      cwd: '/repo2',
      sessions: [makeSession('sd', '/repo2', { projectId: 'proj-a' })],
    },
  ]
}

function mountProjectFilterList(groups: SessionGroup[] = makeProjectFilterGroups()) {
  return mount(SessionList, {
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

describe('SessionList: 项目锚定分组（全部项目并列，按 projectId 切分）', () => {
  it('默认项目区（平铺置顶）= 未归类 + 孤儿聚合；归属现存命名 project 的 session 落各自组（不重不漏）', () => {
    // proj-b 不存在（sc 的归属是孤儿）；proj-a 存在（sa/sd 正常归属）
    setupProjects(DEFAULT_PROJECT_ID, [['proj-a', 'Alpha']])
    const wrapper = mountProjectFilterList()

    const zone = defaultZoneOf(wrapper)
    expect(zone.exists()).toBe(true)
    expect(zone.text()).toContain('会话 sb') // 未归类
    expect(zone.text()).toContain('会话 sc') // 孤儿（归属已删 proj-b）不丢失可见性
    expect(zone.text()).not.toContain('会话 sa')
    // 默认项目不渲染 ProjectGroup（无组框，用户裁决 2026-10-13）
    expect(groupOf(wrapper, DEFAULT_PROJECT_ID).exists()).toBe(false)

    const projA = groupOf(wrapper, 'proj-a')
    expect(projA.text()).toContain('会话 sa')
    expect(projA.text()).toContain('会话 sd')
    expect(projA.text()).not.toContain('会话 sb')
    expect(projA.text()).not.toContain('会话 sc')
  })

  it('同 cwd 混合归属精确切分：/repo 组的三个 session 分落三处归属（sa→proj-a，sb→默认区，sc→proj-b）', () => {
    setupProjects(DEFAULT_PROJECT_ID, [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountProjectFilterList()

    expect(defaultZoneOf(wrapper).text()).toContain('会话 sb')
    expect(groupOf(wrapper, 'proj-a').text()).toContain('会话 sa')
    expect(groupOf(wrapper, 'proj-b').text()).toContain('会话 sc')
  })

  it('组头计数 = 组内实际会话数（用户可见 DOM：计数与组内行数一致）；默认区无计数 chip、行数 = 归属数', () => {
    setupProjects(DEFAULT_PROJECT_ID, [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountProjectFilterList()

    expect(groupOf(wrapper, 'proj-a').find('[data-testid="project-group-count"]').text()).toBe('2') // sa + sd
    expect(groupOf(wrapper, 'proj-b').find('[data-testid="project-group-count"]').text()).toBe('1') // sc
    // 默认项目区无组头（无计数 chip）；平铺行数 = 归属数（sb）
    expect(defaultZoneOf(wrapper).find('[data-testid="project-group-count"]').exists()).toBe(false)
    expect(defaultZoneOf(wrapper).findAll('.session-item')).toHaveLength(1)
  })

  it('命名项目无任何归属 session → 组内空态（「点组头「+」在此新建任务」）', () => {
    setupProjects(DEFAULT_PROJECT_ID, [['proj-empty', 'Empty']])
    const wrapper = mountProjectFilterList()

    const emptyGroup = groupOf(wrapper, 'proj-empty')
    expect(emptyGroup.text()).not.toContain('会话 sa')
    expect(emptyGroup.find('[data-testid="project-group-empty"]').exists()).toBe(true)
    expect(emptyGroup.find('[data-testid="project-group-empty"]').text()).toContain('暂无会话')
    // 完整文案含「点组头「+」在此新建任务」引导（原 session-list-project-groups 空态用例并入）
    expect(emptyGroup.find('[data-testid="project-group-empty"]').text()).toContain('新建任务')
  })

  it('「当前」chip 只渲染在锚定命名组；默认项目不渲染组（平铺区置顶、无框）', () => {
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountProjectFilterList()

    expect(groupOf(wrapper, 'proj-a').find('[data-testid="project-group-current-chip"]').exists()).toBe(true)
    expect(groupOf(wrapper, 'proj-b').find('[data-testid="project-group-current-chip"]').exists()).toBe(false)
    // 默认项目无组（无 chip 可言）；平铺区在 DOM 序上先于全部命名组（置顶）
    expect(groupOf(wrapper, DEFAULT_PROJECT_ID).exists()).toBe(false)
    const zone = defaultZoneOf(wrapper)
    expect(zone.exists()).toBe(true)
    const firstGroup = wrapper.find('[data-testid="project-group"]')
    const all = Array.from(wrapper.element.querySelectorAll('*'))
    expect(all.indexOf(zone.element)).toBeLessThan(all.indexOf(firstGroup.element))
  })
})

describe('SessionList: 锚定切换（平铺模式 = 多开）', () => {
  it('点其他组头 → 锚定切换并展开目标组；原锚定组保持展开（多开，开合按组独立记忆）；组位置不重排', async () => {
    const store = setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    mockSetActive.mockImplementation(async () => commandReply(store, { state: { projects: store.projects.map((p) => ({ ...p })), activeProjectId: 'proj-b' } }))
    const wrapper = mountProjectFilterList()

    const idsBefore = wrapper.findAll('[data-testid="project-group"]').map((g) => g.attributes('data-project-id'))
    // 初始全展开（flatClosed 空集 = 全开）
    expect(groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')

    await groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]').trigger('click')
    await flushPromises() // 锚定命令化（§6.6）：chip 跟随回执更新

    expect(useProjectStore().activeProjectId).toBe('proj-b')
    expect(groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')
    // 多开：原锚定组不再因锚定切换被收起（展开态与锚定解耦）
    expect(groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')
    // 顺序稳定不置顶（用户裁决 2026-10-11）：锚定切换不重排组位置
    expect(wrapper.findAll('[data-testid="project-group"]').map((g) => g.attributes('data-project-id'))).toEqual(idsBefore)
  })

  it('点当前组头 → 折叠/展开翻转（不切换锚定）', async () => {
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountProjectFilterList()
    const toggle = await flipProjectGroupToggle((id) => groupOf(wrapper, id), 'proj-a')
    expect(useProjectStore().activeProjectId).toBe('proj-a')

    await toggle().trigger('click')
    expect(toggle().attributes('aria-expanded')).toBe('true')
  })
})

describe('SessionList: folder 删除检查随项目分组收紧（review MF-2 防护）', () => {
  // folder 操作是目录模式组头元素，本 describe 断言其渲染检查，预置分组模式
  beforeEach(() => {
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
  })

  it('cwd 的会话散布在多个项目分组（各 1/3）→ 任何分组都不渲染 folder-delete-btn（防误删不可见 session）', () => {
    setupProjects(DEFAULT_PROJECT_ID, [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountProjectFilterList([{
      cwd: '/repo',
      sessions: [
        makeSession('sa', '/repo', { projectId: 'proj-a' }),
        makeSession('sb', '/repo'),
        makeSession('sc', '/repo', { projectId: 'proj-b' }),
      ],
    }])
    // removeByCwd 是 cwd 全量删除（项目无关），任一项目分组的删除都会连带删掉其他分组内
    // 不可见的 session → 按钮在所有分组隐藏
    expect(wrapper.findAll('[data-testid="folder-delete-btn"]')).toHaveLength(0)
    // 非破坏性的「+」不受检查约束，恒渲染
    expect(wrapper.findAll('[data-testid="folder-new-session-btn"]').length).toBe(3)
  })

  it('cwd 全量会话恰落在单个项目分组 → 该分组渲染 folder-delete-btn', () => {
    setupProjects(DEFAULT_PROJECT_ID, [['proj-a', 'Alpha']])
    const wrapper = mountProjectFilterList([{
      cwd: '/repo',
      sessions: [makeSession('sa', '/repo'), makeSession('sb', '/repo')],
    }])
    const btns = wrapper.findAll('[data-testid="folder-delete-btn"]')
    expect(btns.length).toBe(1)
  })
})

// ══════════ 来源：session-list-archive-entry.test.ts（归档入口） ══════════

function mountArchiveEntryList(archiveCount?: number, restoredSessionId?: string) {
  seedDefaultLoaded() // 会话行渲染在默认区（idle 态已改为加载占位，§6.7）
  const groups: SessionGroup[] = [{ cwd: '/alpha', sessions: [makeSession('a1', '/alpha')] }]
  return mount(SessionList, {
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
      ...(archiveCount !== undefined ? { archiveCount } : {}),
      ...(restoredSessionId !== undefined ? { restoredSessionId } : {}),
    },
  })
}

describe('SessionList 归档入口（D10 工具组）', () => {
  it('入口钮存在且恒可点（count 0 不禁用）；缺省 archiveCount prop = 0（角标隐藏默认形态）', async () => {
    const wrapper = mountArchiveEntryList()
    const btn = wrapper.find('[data-testid="sidebar-archive-entry-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.find('svg.lucide-archive').exists()).toBe(true)

    await btn.trigger('click')
    expect(wrapper.emitted('openArchives')).toHaveLength(1)
    wrapper.unmount()
  })

  it('角标 0 隐藏（D10：count 0 隐藏，按钮仍可点）', () => {
    const wrapper = mountArchiveEntryList(0)
    expect(wrapper.find('[data-testid="sidebar-archive-count-badge"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('角标 3 → 显示「3」；title 携带计数', () => {
    const wrapper = mountArchiveEntryList(3)
    const badge = wrapper.find('[data-testid="sidebar-archive-count-badge"]')
    expect(badge.text()).toBe('3')
    expect(wrapper.find('[data-testid="sidebar-archive-entry-btn"]').attributes('title')).toBe('已归档会话（3）')
    wrapper.unmount()
  })

  it('角标 150 → 封顶显示「99+」', () => {
    const wrapper = mountArchiveEntryList(150)
    expect(wrapper.find('[data-testid="sidebar-archive-count-badge"]').text()).toBe('99+')
    wrapper.unmount()
  })
})

describe('SessionList 归档事件透传（D6 悬停归档钮链路）', () => {
  it('SessionItem 两段确认后 emit archive → SessionList 透传 emit archive(sessionId)', async () => {
    const wrapper = mountArchiveEntryList()
    const btn = wrapper.find('[data-testid="session-archive-btn"]')

    await btn.trigger('click')
    await btn.trigger('click')

    expect(wrapper.emitted('archive')).toEqual([['a1']])
    wrapper.unmount()
  })
})

describe('SessionList 恢复高亮（session-archive §5.1「原项目组顶部、accent-soft 高亮渐隐」）', () => {
  it('restoredSessionId 匹配行：accent-soft 底色 + highlight testid；其余行与缺省态无高亮', () => {
    const wrapper = mountArchiveEntryList(undefined, 'a1')
    const row = wrapper.find('[data-testid="session-item-restored-highlight"]')
    expect(row.exists()).toBe(true)
    expect(row.classes()).toContain('bg-accent-soft')
    wrapper.unmount()
  })

  it('restoredSessionId 无匹配（null 或他行）：无高亮 testid、无 accent-soft 底色', () => {
    const wrapper = mountArchiveEntryList(undefined, 'other-id')
    expect(wrapper.find('[data-testid="session-item-restored-highlight"]').exists()).toBe(false)
    expect(wrapper.find('.session-item').classes()).not.toContain('bg-accent-soft')
    wrapper.unmount()
  })
})

// ══════════ 来源：sidebar-session-dnd.test.ts（拖拽移动归属） ══════════

/** jsdom 无 DragEvent/DataTransfer，trigger 的 extra props 合成事件用最小替身 */
class FakeDataTransfer {
  private data = new Map<string, string>()
  types: string[] = []
  dropEffect = 'none'
  effectAllowed = 'none'
  setData(type: string, value: string): void {
    this.data.set(type, value)
    if (!this.types.includes(type)) this.types.push(type)
  }
  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

describe('SessionItem dragstart（拖拽数据写入）', () => {
  it('dragstart 写入 SESSION_DRAG_MIME = sessionId，effectAllowed = move', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountAttachedList()
    const dt = new FakeDataTransfer()
    // 默认区置顶（第一个 .session-item 是未归类的 sb），按 label 定位 proj-a 组内的 sa
    const row = wrapper.findAll('.session-item').find((w) => w.text().includes('会话 sa'))!

    await row.trigger('dragstart', { dataTransfer: dt })

    expect(dt.getData(SESSION_DRAG_MIME)).toBe('sa')
    expect(dt.effectAllowed).toBe('move')
    wrapper.unmount()
  })
})

describe('组头 drop（拖到项目 = 移动归属）', () => {
  it('dragover 高亮（types 命中）→ drop emit setProject 指向该组', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountAttachedList()
    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sb')
    const head = groupOf(wrapper, 'proj-a').find('[data-testid="project-group-head"]')

    await head.trigger('dragover', { dataTransfer: dt })
    expect(head.attributes('data-dragover')).toBe('true')

    await head.trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 'sb', projectId: 'proj-a' }]])
    // drop 后高亮清除
    expect(head.attributes('data-dragover')).toBeUndefined()
    wrapper.unmount()
  })

  it('落折叠组 → 归属移动 + 目标组强制展开（会话不消失在折叠组里）', async () => {
    const store = setupProjects('proj-a', [['proj-a', 'Alpha']])
    const wrapper = mountAttachedList()
    const toggleA = () => groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]')

    // 折叠锚定组 proj-a
    await toggleA().trigger('click')
    expect(toggleA().attributes('aria-expanded')).toBe('false')

    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sb')
    await groupOf(wrapper, 'proj-a').find('[data-testid="project-group-head"]').trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 'sb', projectId: 'proj-a' }]])
    expect(toggleA().attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('同归属 drop no-op（不 emit setProject）', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountAttachedList()
    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sa') // sa 已归属 proj-a

    await groupOf(wrapper, 'proj-a').find('[data-testid="project-group-head"]').trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toBeUndefined()
    wrapper.unmount()
  })

  it('无 session MIME 的拖拽（文件拖入等）：不高亮、不 emit', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountAttachedList()
    const dt = new FakeDataTransfer() // 未 setData 任何 session MIME
    const head = groupOf(wrapper, 'proj-a').find('[data-testid="project-group-head"]')

    await head.trigger('dragover', { dataTransfer: dt })
    expect(head.attributes('data-dragover')).toBeUndefined()

    await head.trigger('drop', { dataTransfer: dt })
    await nextTick()
    expect(wrapper.emitted('setProject')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('默认头行 drop（拖到默认项目 = 归回未归类聚合）', () => {
  it('drop → emit setProject projectId 空串', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountAttachedList()
    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sa') // sa 归属 proj-a

    await wrapper.find('[data-testid="default-project-head"]').trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 'sa', projectId: '' }]])
    wrapper.unmount()
  })

  it('未归类 session drop 到默认行 no-op（projectId undefined 与空串同口径）', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountAttachedList()
    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sb') // sb 无 projectId（未归类）

    await wrapper.find('[data-testid="default-project-head"]').trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toBeUndefined()
    wrapper.unmount()
  })
})

// ══════════ 来源：session-list-default-head.test.ts（默认项目头行） ══════════

describe('DefaultProjectHead：锚定/新建入口（修复锚定切走后新会话进不了默认区）', () => {
  it('平铺模式：默认区有会话 → 头行渲染；锚定命名项目时无「当前」chip', () => {
    setupProjects('proj-a')
    const wrapper = mountAttachedList()

    const head = wrapper.find('[data-testid="default-project-head"]')
    expect(head.exists()).toBe(true)
    expect(head.text()).toContain('默认项目')
    expect(wrapper.find('[data-testid="default-project-current-chip"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点行主体 → 锚定切回默认项目，「当前」chip 出现', async () => {
    const store = setupProjects('proj-a')
    mockSetActive.mockImplementation(async () => commandReply(store, { state: { projects: store.projects.map((p) => ({ ...p })), activeProjectId: DEFAULT_PROJECT_ID } }))
    const wrapper = mountAttachedList()

    await wrapper.find('[data-testid="default-project-anchor"]').trigger('click')
    await flushPromises() // 锚定命令化（§6.6）：chip 跟随回执更新

    expect(store.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    await nextTick()
    expect(wrapper.find('[data-testid="default-project-current-chip"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('点「+」→ emit 时刻锚定已在默认项目（先锚定回执后建），并 emit newSession', async () => {
    const store = setupProjects('proj-a')
    mockSetActive.mockImplementation(async () => commandReply(store, { state: { projects: store.projects.map((p) => ({ ...p })), activeProjectId: DEFAULT_PROJECT_ID } }))
    let activeAtEmit: string | null = null
    const wrapper = mount(SessionList, {
      attachTo: document.body,
      props: {
        groups: makeGroups(),
        activeId: null,
        statusOf: () => 'done' as never,
        onNewSession: () => {
          activeAtEmit = store.activeProjectId
        },
      },
    })

    await wrapper.find('[data-testid="default-project-new-task"]').trigger('click')
    await flushPromises() // 「先锚定后建」时序在命令化下由回执落定承载（§6.6）

    expect(activeAtEmit).toBe(DEFAULT_PROJECT_ID)
    expect(store.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(wrapper.emitted('newSession')).toBeTruthy()
    wrapper.unmount()
  })

  it('目录模式：头行同样渲染（目录标签序列之前）', () => {
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
    setupProjects('proj-a')
    const wrapper = mountAttachedList()

    expect(wrapper.find('[data-testid="default-project-head"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('默认区无会话 → 头行不渲染（空区不渲染一致）', () => {
    setupProjects('proj-a')
    const wrapper = mountAttachedList([{ cwd: '/repo', sessions: [makeSession('sa', '/repo', { projectId: 'proj-a' })] }])

    expect(wrapper.find('[data-testid="default-project-head"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('平铺模式多开细节（开合按组独立记忆）', () => {
  it('点锚定组头折叠只收本组，其余组保持展开；再点恢复', async () => {
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountAttachedList()
    const toggleA = () => groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]')
    const toggleB = () => groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]')

    await toggleA().trigger('click')
    expect(toggleA().attributes('aria-expanded')).toBe('false')
    // 多开：proj-b 开合不受 proj-a 折叠影响
    expect(toggleB().attributes('aria-expanded')).toBe('true')

    await toggleA().trigger('click')
    expect(toggleA().attributes('aria-expanded')).toBe('true')
    expect(toggleB().attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('折叠非锚定组后，点它切锚定仍强制展开', async () => {
    const store = setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    mockSetActive.mockImplementation(async (pid: string) => commandReply(store, { state: { projects: store.projects.map((p) => ({ ...p })), activeProjectId: pid } }))
    const wrapper = mountAttachedList()
    const toggleA = () => groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]')
    const toggleB = () => groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]')

    // 折叠 proj-b：先切锚定到它（首次点击非锚定组 = 切锚定，保持展开）再点一次翻转折叠
    await toggleB().trigger('click')
    await flushPromises() // 锚定命令化（§6.6）：chip 跟随回执更新
    expect(store.activeProjectId).toBe('proj-b')
    expect(toggleB().attributes('aria-expanded')).toBe('true')
    await toggleB().trigger('click')
    expect(toggleB().attributes('aria-expanded')).toBe('false')

    // 锚定切回 proj-a（proj-b 折叠记忆保留），再点折叠的 proj-b（非锚定）→ 切锚定 + 强制展开
    await toggleA().trigger('click')
    await flushPromises()
    expect(store.activeProjectId).toBe('proj-a')
    expect(toggleB().attributes('aria-expanded')).toBe('false')
    await toggleB().trigger('click')
    await flushPromises()
    expect(store.activeProjectId).toBe('proj-b')
    expect(toggleB().attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })
})

// ══════════ 来源：session-list-folder-new-session.test.ts（目录行 + 新建按钮） ══════════
// 原文件顶层 beforeEach 预置 groups 模式（本节语义即 C 分组模式组头行为）——下沉到本节
// 各 describe 内（与组件 localStorage 持久化键一致；不泄漏到其他节）。

function makeFolderGroups(): SessionGroup[] {
  return [
    {
      cwd: '/p',
      sessions: [
        // 最小 session fixture（SessionItem 需 id/label/cwd/status）
        { id: 's1', label: '会话 1', cwd: '/p', status: 'idle', lastActiveAt: 1 },
      ],
    },
  ]
}

function mountFolderList() {
  seedDefaultLoaded() // 会话行渲染在默认区（idle 态已改为加载占位，§6.7）
  return mount(SessionList, {
    props: {
      groups: makeFolderGroups(),
      activeId: 's1',
      statusOf: () => 'done' as never,
    },
  })
}

function findNewSessionButton(wrapper: ReturnType<typeof mountFolderList>) {
  return wrapper.find('[data-testid="folder-new-session-btn"]')
}

describe('SessionList 目录行 + 按钮首屏渲染', () => {
  beforeEach(() => {
    // N8 A/C 双模式改造后目录操作归 C 分组模式组头承载（A 平铺无组头）
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
  })

  it('+ 按钮存在于 DOM，title 为 newSessionInFolder 文案', () => {
    const wrapper = mountFolderList()
    const btn = findNewSessionButton(wrapper)
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('在此目录新建会话')
  })

  it('+ 按钮位于删除按钮左侧（DOM 顺序在前）', () => {
    const wrapper = mountFolderList()
    const plus = findNewSessionButton(wrapper)
    const del = wrapper.find('[data-testid="folder-delete-btn"]')
    expect(del.exists()).toBe(true)
    expect(plus.element.compareDocumentPosition(del.element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})

describe('SessionList 目录行 + 按钮点击交互', () => {
  beforeEach(() => {
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
  })

  it('click + → emit newSessionInFolder(cwd)，不 emit deleteFolder', async () => {
    const wrapper = mountFolderList()
    await findNewSessionButton(wrapper)!.trigger('click')

    const emitted = wrapper.emitted('newSessionInFolder')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['/p'])
    expect(wrapper.emitted('deleteFolder')).toBeFalsy()
  })

  it('删除按钮进确认态后点 + → 确认态复位（window pointerdown 收尾），不 emit deleteFolder', async () => {
    const wrapper = mountFolderList()
    await wrapper.find('[data-testid="folder-delete-btn"]').trigger('click')
    // 确认态：title 变 deleteFolderConfirm 文案
    expect(wrapper.find('[data-testid="folder-delete-btn"]').attributes('title'))
      .toBe('确认删除此文件夹下所有会话？')

    // pointerdown 先于 click 触发（与真实事件顺序一致）；在按钮元素上 dispatch 冒泡到 window
    // （直接在 window 上 dispatch 时 happy-dom 的 e.target=window 无 closest）
    findNewSessionButton(wrapper)!.element.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    )
    await findNewSessionButton(wrapper)!.trigger('click')

    expect(wrapper.emitted('newSessionInFolder')).toBeTruthy()
    expect(wrapper.emitted('deleteFolder')).toBeFalsy()
  })
})

describe('SessionList 目录行 + 按钮 vs 删除按钮检查差异', () => {
  beforeEach(() => {
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
  })

  it('项目过滤隐藏部分 session 时：删除按钮不渲染，+ 按钮仍渲染', async () => {
    // 命名 project p1 激活；同 cwd 组内 s1 归 p1（可见）、s2 归 p2（被过滤隐藏）
    const store = markLoaded(useProjectStore())
    store.projects = [
      { id: 'proj-default', name: '', lastUsedAt: 0 },
      { id: 'p1', name: 'P1', lastUsedAt: 1 },
      { id: 'p2', name: 'P2', lastUsedAt: 1 },
    ]
    store.activeProjectId = 'p1'

    const wrapper = mount(SessionList, {
      props: {
        groups: [
          {
            cwd: '/p',
            sessions: [
              { id: 's1', label: '会话 1', cwd: '/p', status: 'idle', lastActiveAt: 1, projectId: 'p1' },
              { id: 's2', label: '会话 2', cwd: '/p', status: 'idle', lastActiveAt: 1, projectId: 'p2' },
            ],
          },
        ],
        activeId: 's1',
        statusOf: () => 'done' as never,
      },
    })

    // 可见 1 < 全量 2 → 删除按钮隐藏（review MF-2 检查），+ 按钮不受检查
    expect(wrapper.find('[data-testid="folder-delete-btn"]').exists()).toBe(false)
    const plus = findNewSessionButton(wrapper)
    expect(plus.exists()).toBe(true)

    await plus.trigger('click')
    expect(wrapper.emitted('newSessionInFolder')![0]).toEqual(['/p'])
  })
})

// ══════════ 来源：session-list-default-zone.test.ts（默认区事件接线） ══════════

function mountDefaultZoneList(groups: SessionGroup[]) {
  return mount(SessionList, {
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

/** 建默认项目 + 命名项目（proj-a 存在，孤儿判定不误伤；固定两项目形态） */
function setupDefaultZoneProjects(activeId: string): ReturnType<typeof useProjectStore> {
  const store = useProjectStore()
  store.projects = [
    { id: 'proj-default', name: '', lastUsedAt: 0 },
    { id: 'proj-a', name: 'Alpha', lastUsedAt: 0 },
  ]
  store.activeProjectId = activeId
  return markLoaded(store)
}

describe('SessionList: 平铺默认区事件透传', () => {
  it('点默认区会话行 → emit select(会话 id)（真实 click 链路）；行渲染在无组框平铺区', async () => {
    setupDefaultZoneProjects(DEFAULT_PROJECT_ID)
    // sa 归属 proj-a（命名组），sb 未归类（默认区）
    const wrapper = mountDefaultZoneList([
      { cwd: '/repo', sessions: [makeSession('sa', '/repo', { projectId: 'proj-a' }), makeSession('sb', '/repo')] },
    ])

    const zone = defaultZoneOf(wrapper)
    expect(zone.exists()).toBe(true)
    expect(zone.text()).toContain('会话 sb')
    expect(zone.text()).not.toContain('会话 sa')

    // 真实用户点击：会话行（role=button）click → SessionItem emit select → 默认区透传
    await zone.find('.session-item').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['sb']])
  })

  it('默认区 SessionItem 的 rename / archive 事件原样透传（SessionList 接线契约，payload 逐字相等）', async () => {
    setupDefaultZoneProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountDefaultZoneList([
      { cwd: '/repo', sessions: [makeSession('sb', '/repo')] },
    ])

    const item = defaultZoneOf(wrapper).findComponent(SessionItem)
    expect(item.exists()).toBe(true)
    item.vm.$emit('rename', 'sb')
    item.vm.$emit('archive', 'sb')
    await nextTick()

    expect(wrapper.emitted('rename')).toEqual([['sb']])
    expect(wrapper.emitted('archive')).toEqual([['sb']])
  })
})

describe('SessionList: 目录模式默认区（置顶目录标签 + folder 行操作）', () => {
  beforeEach(() => {
    // 目录模式（与组件 localStorage 持久化键一致，同 session-list-folder-delete 范式）
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
  })

  it('默认项目目录标签置顶渲染（DOM 序先于任何命名组，无 ProjectGroup 包裹）；会话行随标签可见', () => {
    setupDefaultZoneProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountDefaultZoneList([
      { cwd: '/repo', sessions: [makeSession('s1', '/repo'), makeSession('s2', '/repo')] },
      { cwd: '/repo2', sessions: [makeSession('s3', '/repo2', { projectId: 'proj-a' })] },
    ])

    // 默认区无 ProjectGroup（方案 A：不展示项目框）
    expect(groupOf(wrapper, DEFAULT_PROJECT_ID).exists()).toBe(false)
    // 会话可见：默认区 s1/s2，命名组 s3
    expect(wrapper.text()).toContain('会话 s1')
    expect(wrapper.text()).toContain('会话 s2')
    expect(groupOf(wrapper, 'proj-a').text()).toContain('会话 s3')
    // 默认区目录标签置顶：首个 folder 操作区在 DOM 序上先于首个命名组
    const firstLabel = wrapper.find('[data-testid="folder-actions"]').element
    const firstGroup = wrapper.find('[data-testid="project-group"]').element
    const all = Array.from(wrapper.element.querySelectorAll('*'))
    expect(all.indexOf(firstLabel)).toBeGreaterThan(-1)
    expect(all.indexOf(firstLabel)).toBeLessThan(all.indexOf(firstGroup))
  })

  it('点默认区目录标签「+」→ emit newSessionInFolder(cwd)（以该目录预选新建）', async () => {
    setupDefaultZoneProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountDefaultZoneList([
      { cwd: '/repo', sessions: [makeSession('s1', '/repo'), makeSession('s2', '/repo')] },
      { cwd: '/repo2', sessions: [makeSession('s3', '/repo2', { projectId: 'proj-a' })] },
    ])

    // 首个「+」即默认区标签行（置顶）；命名组内标签行不受本断言约束
    const plusBtns = wrapper.findAll('[data-testid="folder-new-session-btn"]')
    expect(plusBtns.length).toBe(2) // 默认区 /repo + 命名组 /repo2
    await plusBtns[0]!.trigger('click')
    expect(wrapper.emitted('newSessionInFolder')).toEqual([['/repo']])
  })

  it('默认区 SessionItem 全部事件原样透传（select/rename/archive/setProject/navigateParent/abort/forceQuit/exportJsonl）', async () => {
    setupDefaultZoneProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountDefaultZoneList([
      { cwd: '/repo', sessions: [makeSession('s1', '/repo')] },
    ])

    // 目录模式默认区的会话行（.gi 缩进层内）
    const item = wrapper.find('.gi').findComponent(SessionItem)
    expect(item.exists()).toBe(true)
    expect(wrapper.text()).toContain('会话 s1')

    item.vm.$emit('select', 's1')
    item.vm.$emit('rename', 's1')
    item.vm.$emit('archive', 's1')
    item.vm.$emit('setProject', { sessionId: 's1', projectId: 'proj-a' })
    item.vm.$emit('navigateParent', 'parent-1')
    item.vm.$emit('abort', 's1')
    item.vm.$emit('forceQuit', 's1')
    item.vm.$emit('exportJsonl', { sessionId: 's1' })
    await nextTick()

    expect(wrapper.emitted('select')).toEqual([['s1']])
    expect(wrapper.emitted('rename')).toEqual([['s1']])
    expect(wrapper.emitted('archive')).toEqual([['s1']])
    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 's1', projectId: 'proj-a' }]])
    expect(wrapper.emitted('navigateParent')).toEqual([['parent-1']])
    expect(wrapper.emitted('abort')).toEqual([['s1']])
    expect(wrapper.emitted('forceQuit')).toEqual([['s1']])
    expect(wrapper.emitted('exportJsonl')).toEqual([[{ sessionId: 's1' }]])
  })

  it('默认区批量删除检查放行（cwd 全量会话都在默认区）→ 两段式确认 → emit deleteFolder(cwd)', async () => {
    setupDefaultZoneProjects(DEFAULT_PROJECT_ID)
    // /repo 两条会话全部未归类 → 默认区包含该 cwd 全量 → 删除按钮放行（MF-2 检查）
    const wrapper = mountDefaultZoneList([
      { cwd: '/repo', sessions: [makeSession('s1', '/repo'), makeSession('s2', '/repo')] },
    ])

    const btn = wrapper.find('[data-testid="folder-delete-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('删除')

    // 首击进确认态（用户可见：title 翻转为确认文案），不 emit
    await btn.trigger('click')
    const confirmBtn = wrapper.find('[data-testid="folder-delete-btn"]')
    expect(confirmBtn.attributes('title')).toBe('确认删除此文件夹下所有会话？')
    expect(wrapper.emitted('deleteFolder')).toBeFalsy()

    // 再击确认 → emit deleteFolder(cwd)，确认态复位
    await confirmBtn.trigger('click')
    expect(wrapper.emitted('deleteFolder')).toEqual([['/repo']])
    await nextTick()
    expect(wrapper.find('[data-testid="folder-delete-btn"]').attributes('title')).toBe('删除')
  })
})

// ══════════ 来源：session-list-dual-mode.test.ts（A/C 双模式） ══════════

/** 两组各两条（组间/组内可区分），验证平铺序 = runtime 组序展平（组序恒等，零重排） */
function makeDualModeGroups(): SessionGroup[] {
  return [
    { cwd: '/alpha', sessions: [makeSession('a1', '/alpha'), makeSession('a2', '/alpha')] },
    { cwd: '/beta', sessions: [makeSession('b1', '/beta')] },
  ]
}

function mountDualModeList(groups: SessionGroup[] = makeDualModeGroups(), activeId: string | null = null) {
  seedDefaultLoaded() // 会话行渲染在默认区（idle 态已改为加载占位，§6.7）
  return mount(SessionList, {
    props: {
      groups,
      activeId,
      statusOf: () => 'done' as never,
    },
  })
}

describe('N8 默认平铺（A 模式）', () => {
  it('无持久化值挂载 → 平铺开关选中 + 无组头目录操作按钮', () => {
    const wrapper = mountDualModeList()
    expect(wrapper.find('[data-testid="session-mode-flat"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="session-mode-groups"]').attributes('aria-pressed')).toBe('false')
    // 目录操作（组内新建/目录删除）只由 C 分组模式组头承载，A 平铺不提供
    expect(wrapper.find('[data-testid="folder-new-session-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="folder-delete-btn"]').exists()).toBe(false)
  })

  it('会话行按 runtime 组序展平（fixture 输入序与 cwd 字典序相反：sort / 按 cwd 重排类回归即红）', () => {
    // 组序 zulu → alpha（与 cwd 字典序相反）：若实现按 cwd 排序或任何重排，序列断言即红
    const crossed: SessionGroup[] = [
      { cwd: '/zulu', sessions: [makeSession('z1', '/zulu'), makeSession('z2', '/zulu')] },
      { cwd: '/alpha', sessions: [makeSession('a1', '/alpha')] },
    ]
    const wrapper = mountDualModeList(crossed)
    // flatSessions = groups.flatMap(g => g.sessions)：z1, z2, a1（组序恒等，零重排）
    const texts = wrapper.findAll('.session-item').map((w) => w.text())
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('会话 z1')
    expect(texts[1]).toContain('会话 z2')
    expect(texts[2]).toContain('会话 a1')
  })

  it('区头显示「项目与会话」标题 + 全量会话计数', () => {
    const wrapper = mountDualModeList()
    const header = wrapper.find('[data-testid="session-list-header"]')
    expect(header.exists()).toBe(true)
    expect(header.text()).toContain('项目与会话')
    expect(header.text()).toContain('3')
  })
})

describe('N8 模式切换与持久化', () => {
  it('点击分组开关 → 进入 C 模式（组头 + 目录操作按钮出现）+ localStorage 写入', async () => {
    const wrapper = mountDualModeList()
    await wrapper.find('[data-testid="session-mode-groups"]').trigger('click')

    expect(wrapper.find('[data-testid="session-mode-groups"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="folder-new-session-btn"]').exists()).toBe(true)
    expect(localStorage.getItem(SESSION_MODE_KEY)).toBe('groups')
  })

  it('预置持久化值 groups 挂载 → 直接恢复 C 分组模式（刷新后模式保持）', () => {
    localStorage.setItem(SESSION_MODE_KEY, 'groups')
    const wrapper = mountDualModeList()
    expect(wrapper.find('[data-testid="session-mode-groups"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="folder-new-session-btn"]').exists()).toBe(true)
  })

  it('C 模式再切回平铺 → localStorage 写回 flat，目录操作按钮消失', async () => {
    localStorage.setItem(SESSION_MODE_KEY, 'groups')
    const wrapper = mountDualModeList()
    await wrapper.find('[data-testid="session-mode-flat"]').trigger('click')

    expect(wrapper.find('[data-testid="folder-new-session-btn"]').exists()).toBe(false)
    expect(localStorage.getItem(SESSION_MODE_KEY)).toBe('flat')
  })
})

describe('N8 选中态同步（两模式一致，demo .si.on Tier B：仅文字提亮无选中底）', () => {
  it('A 平铺模式：activeId 对应行无选中底，行文字提亮 text-neutral-fg', () => {
    const wrapper = mountDualModeList(makeDualModeGroups(), 'a2')
    const items = wrapper.findAll('.session-item')
    const activeRow = items.find((w) => w.text().includes('会话 a2'))
    expect(activeRow?.classes()).not.toContain('bg-bg-elevated')
    expect(activeRow?.classes()).toContain('text-neutral-fg')
  })

  it('C 分组模式：同一 activeId 对应行同样仅文字提亮', () => {
    localStorage.setItem(SESSION_MODE_KEY, 'groups')
    const wrapper = mountDualModeList(makeDualModeGroups(), 'b1')
    const activeRow = wrapper.findAll('.session-item').find((w) => w.text().includes('会话 b1'))
    expect(activeRow?.classes()).not.toContain('bg-bg-elevated')
    expect(activeRow?.classes()).toContain('text-neutral-fg')
  })
})

describe('N8 hover 详情卡（demo .sess-pop：行首图标 + 立即开 + 末行时间 meta）', () => {
  function mountItem(over: Partial<SessionSummary> = {}) {
    return mount(SessionItem, {
      attachTo: document.body,
      props: {
        session: makeSession('d1', '/repo/deep/dir', { gitBranch: 'feat/detail-card', ...over }),
        active: false,
        status: 'done' as never,
      },
    })
  }

  it('pointerenter 立即开 → portal 详情卡渲染分支 + 完整目录（行首图标形态）', async () => {
    const wrapper = mountItem()
    // demo @mouseenter=openCard 无延迟定时，pointerenter 后同步渲染
    await wrapper.find('.session-item').trigger('pointerenter')
    await nextTick()

    const card = document.body.querySelector('[data-testid="session-detail-card"]')
    expect(card).not.toBeNull()
    // demo .pr 形态：行首图标（分支/目录各一）+ mono 值，无文字标签
    expect(card?.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
    expect(card?.textContent).toContain('feat/detail-card')
    expect(card?.textContent).toContain('/repo/deep/dir')
    wrapper.unmount()
  })

  it('无 gitBranch 时详情卡只显目录行（缺失字段不渲染空图标行）', async () => {
    const wrapper = mountItem({ gitBranch: undefined })
    await wrapper.find('.session-item').trigger('pointerenter')
    await nextTick()

    const card = document.body.querySelector('[data-testid="session-detail-card"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('/repo/deep/dir')
    expect(card?.querySelectorAll('svg')).toHaveLength(1)
    wrapper.unmount()
  })
})
