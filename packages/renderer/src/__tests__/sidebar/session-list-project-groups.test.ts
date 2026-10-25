/**
 * SessionList R6.2 锚定分组交互测试（组头操作 / 新建项目流 / 目录模式浏览态）。
 *
 * 覆盖（demo spec sidebar §3.2/§3.3/§3.7 验收条款，全部带用户可见 DOM 断言）：
 * - 组头「+」：先落点该项目（锚定切换）再 emit newSession，且该组展开
 * - 组头重命名：行内输入替换组头，Enter 提交 → store.renameProject；默认项目无重命名钮
 *   （nameless 身份 = 未归类聚合判据，组件侧双保险）
 * - 组头删除：ConfirmDialog 二次确认（文案写明归回后果）→ store.removeProject；
 *   默认项目无删除钮（review MF-1 双保险）
 * - 新建项目（区头「+」钮，用户裁决 2026-10-11）：点击后列表顶部出现草稿输入行，
 *   Enter 提交 → 新项目锚定并展开空态；Esc / 空名丢弃草稿不创建
 * - 目录模式 = 浏览态：全部项目组默认展开；组头点击只开合自己、不切换锚定（与平铺模式
 *   「组头点击 = 切换锚定」形成可感知的行为差异）
 * - 空组（当前组）：组内空态文案可见（「点组头「+」在此新建任务」）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-project-groups.test.ts
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

function makeGroups(): SessionGroup[] {
  return [
    { cwd: '/repo', sessions: [makeSession('sa', '/repo', { projectId: 'proj-a' })] },
    { cwd: '/free', sessions: [makeSession('sb', '/free')] },
  ]
}

function mountList(groups: SessionGroup[] = makeGroups()) {
  return mount(SessionList, {
    attachTo: document.body,
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

function setupProjects(activeId: string, names: Array<[string, string]> = [['proj-a', 'Alpha']]) {
  const store = useProjectStore()
  store.projects = [
    { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
    ...names.map(([id, name]) => ({ id, name, lastUsedAt: 0 })),
  ]
  store.activeProjectId = activeId
  return store
}

function groupOf(wrapper: ReturnType<typeof mountList>, projectId: string) {
  return wrapper.find(`[data-testid="project-group"][data-project-id="${projectId}"]`)
}

beforeEach(async () => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:projects')
  localStorage.removeItem('taiji:sidebar-session-mode')
  document.body.innerHTML = ''
})

describe('组头操作（hover 动作钮，demo .pgh-acts）', () => {
  it('「+」先落点该项目再 emit newSession；该组展开（先锚定后建，新会话归属正确）', async () => {
    const store = setupProjects(DEFAULT_PROJECT_ID)
    // 在 newSession 事件触发时刻采样落点：终态断言无法区分「先锚定后 emit」与「先 emit 后锚定」
    // ——后者正是新会话落错项目的 bug 形态
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

    await groupOf(wrapper, 'proj-a').find('[data-testid="project-group-new-task"]').trigger('click')

    expect(activeAtEmit).toBe('proj-a') // emit 时刻 activeProjectId 已切换（先锚定后建）
    expect(store.activeProjectId).toBe('proj-a')
    expect(wrapper.emitted('newSession')).toBeTruthy()
    expect(groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')
  })

  it('重命名：行内输入 Enter 提交 → store.renameProject；Esc 取消不改名', async () => {
    const store = setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()

    const renameBtn = groupOf(wrapper, 'proj-a').find('[data-testid="project-group-rename"]')
    expect(renameBtn.exists()).toBe(true)
    await renameBtn.trigger('click')
    await nextTick()

    const input = wrapper.find('[data-testid="project-rename-input-proj-a"]')
    expect(input.exists()).toBe(true)
    await input.setValue('Alpha 改')
    await input.trigger('keydown.enter')
    expect(store.projects.find((p) => p.id === 'proj-a')!.name).toBe('Alpha 改')

    // Esc 取消：再开编辑态输入后 Esc，名字不变
    await groupOf(wrapper, 'proj-a').find('[data-testid="project-group-rename"]').trigger('click')
    const input2 = wrapper.find('[data-testid="project-rename-input-proj-a"]')
    await input2.setValue('不会被保存')
    await input2.trigger('keydown.esc')
    expect(store.projects.find((p) => p.id === 'proj-a')!.name).toBe('Alpha 改')
  })

  it('默认项目不渲染组框（用户裁决 2026-10-13 方案 A：无组头即无重命名/删除/新建钮，会话在置顶平铺区）', () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()

    // 默认项目无 ProjectGroup：nameless 身份的重命名/删除检查不再经由组件渲染范围表达
    expect(wrapper.find(`[data-testid="project-group"][data-project-id="${DEFAULT_PROJECT_ID}"]`).exists()).toBe(false)
    // 会话在置顶平铺区可见（无组框）
    expect(wrapper.find('[data-testid="default-project-flat-zone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="default-project-flat-zone"]').findAll('.session-item').length).toBeGreaterThan(0)
  })

  it('删除：ConfirmDialog 确认（文案写明归回后果）→ removeProject；删当前组锚定回落默认', async () => {
    const store = setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()

    await groupOf(wrapper, 'proj-a').find('[data-testid="project-group-delete"]').trigger('click')
    await nextTick()

    // 确认弹层文案可见：项目名 + 归回后果（spec sidebar §3.7）
    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain('删除项目')
    expect(dialogText).toContain('Alpha')
    expect(dialogText).toContain('归回默认项目')

    // 确认按钮（ConfirmDialog 尾部危险钮）点击 → removeProject 生效
    const confirmBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === '删除')
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await nextTick()

    expect(store.projects.some((p) => p.id === 'proj-a')).toBe(false)
    expect(store.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    wrapper.unmount()
  })
})

describe('新建项目入口（区头「+」→ 列表顶部草稿行）', () => {
  it('Enter 提交 → 新项目创建并锚定展开；空态提示可见', async () => {
    const store = setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()

    await wrapper.find('[data-testid="project-add-btn"]').trigger('click')
    const input = wrapper.find('[data-testid="project-create-input"]')
    expect(input.exists()).toBe(true)
    // 草稿行在列表顶部（用户裁决：点 + 后「列表中顶上」出现输入态行）
    const draftEl = wrapper.find('[data-testid="project-draft-row"]')
    expect(draftEl.exists()).toBe(true)
    const firstGroupEl = wrapper.find('[data-testid="project-group"]').element
    expect(draftEl.element.compareDocumentPosition(firstGroupEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await input.setValue('新项目')
    await input.trigger('keydown.enter')
    await nextTick()

    const created = store.projects.find((p) => p.name === '新项目')
    expect(created).toBeTruthy()
    expect(store.activeProjectId).toBe(created!.id)
    // 锚定切换后新组展开（aria-expanded），空组提示直接可见
    const createdGroup = groupOf(wrapper, created!.id)
    expect(createdGroup.find('[data-testid="project-group-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(createdGroup.find('[data-testid="project-group-empty"]').text()).toContain('暂无会话')
    // 草稿行收起，区头 + 钮回归
    expect(wrapper.find('[data-testid="project-draft-row"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-add-btn"]').exists()).toBe(true)
  })

  it('Esc 取消：不创建项目', async () => {
    const store = setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()

    await wrapper.find('[data-testid="project-add-btn"]').trigger('click')
    const input = wrapper.find('[data-testid="project-create-input"]')
    await input.setValue('不会存在')
    await input.trigger('keydown.esc')

    expect(store.projects.some((p) => p.name === '不会存在')).toBe(false)
    expect(wrapper.find('[data-testid="project-add-btn"]').exists()).toBe(true)
  })
})

describe('目录模式 = 浏览态（方案 A 目录裁决：组头只开合、不切换锚定）', () => {
  beforeEach(() => {
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
  })

  it('全部项目组默认展开（含非当前组）', () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()
    for (const g of wrapper.findAll('[data-testid="project-group-toggle"]')) {
      expect(g.attributes('aria-expanded')).toBe('true')
    }
  })

  it('组头点击只开合自己，activeProjectId 不变（与平铺模式的可感知行为差异）', async () => {
    const store = setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()
    const toggle = await flipProjectGroupToggle((id) => groupOf(wrapper, id), 'proj-a')
    expect(store.activeProjectId).toBe(DEFAULT_PROJECT_ID) // 未切换锚定

    await toggle().trigger('click')
    expect(toggle().attributes('aria-expanded')).toBe('true')
  })
})
