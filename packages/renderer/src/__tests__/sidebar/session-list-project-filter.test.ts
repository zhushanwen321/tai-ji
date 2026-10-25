/**
 * SessionList.vue 项目锚定分组测试（R6.2 方案 A，2026-10-11；替代旧「按 activeProject 过滤」形态）。
 *
 * 旧形态（D14 过滤，2026-08-04）按 activeProject 隐藏其他项目的 session；R6.2 锚定分组后
 * 全部项目并列渲染（组体常驻 DOM，非当前组折叠一行），归属语义不变——按 session.projectId
 * 逐条切分（sessionBelongsToProject SSOT），每个 session 恰好落在一个分组：
 * - 默认项目组 = 未归类 + 孤儿（归属已删 project）聚合
 * - 命名项目组 = projectId 精确匹配（同 cwd 组内混合归属时精确切分）
 * - 切分不重不漏（归属总数守恒）
 * - 组头计数 = 组内实际会话数；空组显示组内空态
 * - 锚定切换只移动「谁展开 + 谁 带『当前』chip」，组位置与可见集不变
 * - folder 删除检查（review MF-2）：removeByCwd 是 cwd 全量删除（项目无关），仅当某项目
 *   分组恰好包含该 cwd 全量会话时才渲染删除按钮
 *
 * fixture 语义：sa/sd 归属 proj-a；sc 归属 proj-b；sb 未归类。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-project-filter.test.ts
 */
import { flipProjectGroupToggle } from '../helpers/sidebar-mount'
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import SessionList from '@/components/sidebar/SessionList.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'

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

/** 同 cwd 组：sa 归属 proj-a，sb 未归类，sc 归属 proj-b（混合归属验证 session 级切分） */
function makeGroups(): SessionGroup[] {
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

function mountList(groups: SessionGroup[] = makeGroups()) {
  return mount(SessionList, {
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

/** 建默认项目 + 命名项目（proj-a/proj-b 均存在，孤儿判定不误伤） */
function setupProjects(activeId: string, names: Array<[string, string]>): ReturnType<typeof useProjectStore> {
  const store = useProjectStore()
  store.projects = [
    { id: 'proj-default', name: '', lastUsedAt: 0 },
    ...names.map(([id, name]) => ({ id, name, lastUsedAt: 0 })),
  ]
  store.activeProjectId = activeId
  return store
}

/** 定位某项目的分组容器（组体常驻 DOM，text() 断言按组隔离，不受折叠态影响）。
 *  [2026-10-13 方案 A] 默认项目不再渲染 ProjectGroup（无组框）——本 helper 仅适用命名项目。 */
function groupOf(wrapper: ReturnType<typeof mountList>, projectId: string) {
  return wrapper.find(`[data-testid="project-group"][data-project-id="${projectId}"]`)
}

/** 定位默认项目平铺区（置顶、无组框；用户裁决 2026-10-13：默认项目 = 未归类收件箱） */
function defaultZoneOf(wrapper: ReturnType<typeof mountList>) {
  return wrapper.find('[data-testid="default-project-flat-zone"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:projects')
  localStorage.removeItem('taiji:sidebar-session-mode')
})

describe('SessionList: 项目锚定分组（全部项目并列，按 projectId 切分）', () => {
  it('默认项目区（平铺置顶）= 未归类 + 孤儿聚合；归属现存命名 project 的 session 落各自组（不重不漏）', () => {
    // proj-b 不存在（sc 的归属是孤儿）；proj-a 存在（sa/sd 正常归属）
    setupProjects(DEFAULT_PROJECT_ID, [['proj-a', 'Alpha']])
    const wrapper = mountList()

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
    const wrapper = mountList()

    expect(defaultZoneOf(wrapper).text()).toContain('会话 sb')
    expect(groupOf(wrapper, 'proj-a').text()).toContain('会话 sa')
    expect(groupOf(wrapper, 'proj-b').text()).toContain('会话 sc')
  })

  it('组头计数 = 组内实际会话数（用户可见 DOM：计数与组内行数一致）；默认区无计数 chip、行数 = 归属数', () => {
    setupProjects(DEFAULT_PROJECT_ID, [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()

    expect(groupOf(wrapper, 'proj-a').find('[data-testid="project-group-count"]').text()).toBe('2') // sa + sd
    expect(groupOf(wrapper, 'proj-b').find('[data-testid="project-group-count"]').text()).toBe('1') // sc
    // 默认项目区无组头（无计数 chip）；平铺行数 = 归属数（sb）
    expect(defaultZoneOf(wrapper).find('[data-testid="project-group-count"]').exists()).toBe(false)
    expect(defaultZoneOf(wrapper).findAll('.session-item')).toHaveLength(1)
  })

  it('命名项目无任何归属 session → 组内空态（「点组头「+」在此新建任务」）', () => {
    setupProjects(DEFAULT_PROJECT_ID, [['proj-empty', 'Empty']])
    const wrapper = mountList()

    const emptyGroup = groupOf(wrapper, 'proj-empty')
    expect(emptyGroup.text()).not.toContain('会话 sa')
    expect(emptyGroup.find('[data-testid="project-group-empty"]').exists()).toBe(true)
    expect(emptyGroup.find('[data-testid="project-group-empty"]').text()).toContain('暂无会话')
    // 完整文案含「点组头「+」在此新建任务」引导（原 session-list-project-groups 空态用例并入）
    expect(emptyGroup.find('[data-testid="project-group-empty"]').text()).toContain('新建任务')
  })

  it('「当前」chip 只渲染在锚定命名组；默认项目不渲染组（平铺区置顶、无框）', () => {
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()

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
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()

    const idsBefore = wrapper.findAll('[data-testid="project-group"]').map((g) => g.attributes('data-project-id'))
    // 初始全展开（flatClosed 空集 = 全开）
    expect(groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')

    await groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]').trigger('click')
    await nextTick()

    expect(useProjectStore().activeProjectId).toBe('proj-b')
    expect(groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')
    // 多开：原锚定组不再因锚定切换被收起（展开态与锚定解耦）
    expect(groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')
    // 顺序稳定不置顶（用户裁决 2026-10-11）：锚定切换不重排组位置
    expect(wrapper.findAll('[data-testid="project-group"]').map((g) => g.attributes('data-project-id'))).toEqual(idsBefore)
  })

  it('点当前组头 → 折叠/展开翻转（不切换锚定）', async () => {
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()
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
    const wrapper = mountList([{
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
    const wrapper = mountList([{
      cwd: '/repo',
      sessions: [makeSession('sa', '/repo'), makeSession('sb', '/repo')],
    }])
    const btns = wrapper.findAll('[data-testid="folder-delete-btn"]')
    expect(btns.length).toBe(1)
  })
})
