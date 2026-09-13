/**
 * ProjectSwitcher 组件测试（3A 2 列卡片网格 + 拖拽/键盘排序，形态权威
 * git 历史 docs/page-design/project-switcher-demo.html 变体 3A，该目录已退役）。
 *
 * 覆盖（三视角：每条含用户可见 DOM 断言）：
 *  - 渲染形态：2 列网格常驻（无折叠展开态），卡片 = 名称 + 会话数徽章，active 卡高亮
 *  - 徽章数字：与 SessionList 过滤同一规则（默认项目聚合未归类 + 孤儿），数字 = 点击后列表实际条数
 *  - 1 步切换：点击卡片直接切 active（无中间展开态）
 *  - 拖拽排序（D8）：dragstart → drop 到目标卡 → reorderProject 提交 userOrder（DOM 顺序变化）
 *  - 键盘排序（D8，u5 验收④）：focus 卡片 + 方向键交换相邻位置，与拖拽走同一 reorderProject 入口
 *  - 新建流：网格尾部 add 卡 → 内联 Input → Enter 创建；Esc 取消
 *  - 删除流（右键 ContextMenu，demo 3A 卡片无删除按钮的保功能方案）：默认项目卡无删除菜单；
 *    命名卡右键 → 删除项 → ConfirmDialog 确认
 *  - title 兜底：tooltip 在 sidebar 滚动容器内裁剪风险 → 卡片 title=全名（待验证检查点 3 决策）
 *
 * 测试框架：vitest + @vue/test-utils（mount）。vue-i18n 由 vitest-i18n-setup.ts 全局 mock。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-switcher.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { Project, SessionGroup, SessionSummary } from '@xyz-agent/shared'
import ProjectSwitcher from '@/components/sidebar/ProjectSwitcher.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import { useSessionStore } from '@/stores/session'

vi.mock('@/api', () => ({
  project: { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
}))

function makeProject(id: string, name: string, lastUsedAt = 0, userOrder?: number): Project {
  return userOrder === undefined ? { id, name, lastUsedAt } : { id, name, lastUsedAt, userOrder }
}

function makeSession(id: string, projectId?: string): SessionSummary {
  return { id, label: id, cwd: '/repo', status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0, projectId }
}

function mountSwitcher(): VueWrapper {
  return mount(ProjectSwitcher, { attachTo: document.body })
}

/** 卡片 testid 按 id 定位（data-project-id 属性） */
function cardById(wrapper: VueWrapper, id: string) {
  return wrapper.find(`[data-testid="project-card"][data-project-id="${id}"]`)
}

/** ConfirmDialog 经 reka DialogPortal teleport 到 body：在 body 内找按钮（既有范式） */
function findDialogButton(text: string): HTMLElement | null {
  return Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) ?? null
}

/** 触发 HTML5 DnD 事件链（dragstart → dragover → drop），dataTransfer 用 stub */
function dropOnto(wrapper: VueWrapper, fromId: string, toId: string) {
  const from = cardById(wrapper, fromId)
  const to = cardById(wrapper, toId)
  const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  from.trigger('dragstart', { dataTransfer: transfer })
  to.trigger('dragover', { dataTransfer: transfer, preventDefault: vi.fn() })
  to.trigger('drop', { dataTransfer: transfer, preventDefault: vi.fn() })
  from.trigger('dragend')
}

let wrapper: VueWrapper | null = null

describe('ProjectSwitcher 3A：2 列网格渲染 + 徽章 + 切换', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('用户可见 DOM：常驻 2 列网格渲染全部项目卡（名称 + 会话数徽章），无折叠展开态', () => {
    const projectStore = useProjectStore()
    projectStore.projects = [
      makeProject(DEFAULT_PROJECT_ID, ''),
      makeProject('a', 'Alpha'),
      makeProject('b', 'Beta'),
    ]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()

    // 网格常驻可见（demo 3A：无手风琴折叠态，1 步切换的前提）
    const grid = wrapper.find('[data-testid="project-grid"]')
    expect(grid.exists()).toBe(true)
    expect(grid.classes()).toContain('grid-cols-2')
    // 卡片渲染：默认项目卡名称走 i18n fallback「默认项目」
    const cards = wrapper.findAll('[data-testid="project-card"]')
    expect(cards).toHaveLength(3)
    expect(cardById(wrapper, 'a').find('[data-testid="project-card-name"]').text()).toBe('Alpha')
    expect(cardById(wrapper, DEFAULT_PROJECT_ID).find('[data-testid="project-card-name"]').text()).toBe('默认项目')
    // active 卡高亮（bg-surface 范式），非 active 卡无
    expect(cardById(wrapper, 'a').classes()).toContain('bg-surface')
    expect(cardById(wrapper, 'b').classes()).not.toContain('bg-surface')
    // 网格尾部有「新建项目」入口
    expect(wrapper.find('[data-testid="project-add-btn"]').exists()).toBe(true)
  })

  it('徽章数字 = 点击该卡后 SessionList 实际显示的会话数（默认项目聚合未归类 + 孤儿）', () => {
    const projectStore = useProjectStore()
    projectStore.projects = [
      makeProject(DEFAULT_PROJECT_ID, ''),
      makeProject('a', 'Alpha'),
      makeProject('b', 'Beta'),
    ]
    projectStore.activeProjectId = 'a'
    // sa/sd→a；sc→b；sb 未归类；s-orphan 归属已删项目 → 全部计入默认项目徽章
    const sessionStore = useSessionStore()
    sessionStore.applySnapshot({
      groups: [
        { cwd: '/repo', sessions: [makeSession('sa', 'a'), makeSession('sb'), makeSession('sc', 'b'), makeSession('s-orphan', 'ghost')] },
        { cwd: '/repo2', sessions: [makeSession('sd', 'a')] },
      ] as SessionGroup[],
    })

    wrapper = mountSwitcher()

    expect(cardById(wrapper, 'a').find('[data-testid="project-card-count"]').text()).toBe('2')
    expect(cardById(wrapper, 'b').find('[data-testid="project-card-count"]').text()).toBe('1')
    expect(cardById(wrapper, DEFAULT_PROJECT_ID).find('[data-testid="project-card-count"]').text()).toBe('2')
  })

  it('1 步切换：点击非 active 卡直接切 active 并高亮（无中间展开态）', async () => {
    const projectStore = useProjectStore()
    projectStore.projects = [makeProject('a', 'Alpha'), makeProject('b', 'Beta')]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()
    await cardById(wrapper, 'b').trigger('click')

    expect(projectStore.activeProjectId).toBe('b')
    expect(cardById(wrapper, 'b').classes()).toContain('bg-surface')
    expect(cardById(wrapper, 'a').classes()).not.toContain('bg-surface')
  })

  it('title 兜底：卡片 title = 全名（sidebar 滚动容器内 CSS tooltip 裁剪的规避决策）', () => {
    const projectStore = useProjectStore()
    projectStore.projects = [makeProject('a', '很长的项目名称会被截断')]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()
    expect(cardById(wrapper, 'a').attributes('title')).toBe('很长的项目名称会被截断')
  })
})

describe('ProjectSwitcher 3A：排序（拖拽 + 键盘同一 reorderProject 入口）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('拖拽：把 B 拖到 A 上（首位）→ DOM 顺序与 userOrder 同步为落点序', async () => {
    const projectStore = useProjectStore()
    projectStore.projects = [
      makeProject('a', 'Alpha', 0, 0),
      makeProject('b', 'Beta', 0, 1),
      makeProject('c', 'Gamma', 0, 2),
    ]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()
    expect(wrapper.findAll('[data-testid="project-card"]').map((c) => c.attributes('data-project-id'))).toEqual(['a', 'b', 'c'])

    dropOnto(wrapper, 'b', 'a')
    await nextTick()

    // 落点序：b 到首位；userOrder 密集 0..n-1（store 层断言见 project-ordering.test.ts）
    expect(wrapper.findAll('[data-testid="project-card"]').map((c) => c.attributes('data-project-id'))).toEqual(['b', 'a', 'c'])
    expect(projectStore.projects.find((p) => p.id === 'b')!.userOrder).toBe(0)
    expect(projectStore.projects.find((p) => p.id === 'a')!.userOrder).toBe(1)
    expect(projectStore.projects.find((p) => p.id === 'c')!.userOrder).toBe(2)
  })

  it('键盘通道（u5 验收④）：focus 卡片按 ArrowDown 与后一位交换，与拖拽同一 reorderProject 入口', async () => {
    const projectStore = useProjectStore()
    projectStore.projects = [
      makeProject('a', 'Alpha', 0, 0),
      makeProject('b', 'Beta', 0, 1),
      makeProject('c', 'Gamma', 0, 2),
    ]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()

    // focus 首卡，ArrowDown → 与 b 交换（reorderProject(a, b)）
    await cardById(wrapper, 'a').trigger('keydown.down')
    expect(wrapper.findAll('[data-testid="project-card"]').map((c) => c.attributes('data-project-id'))).toEqual(['b', 'a', 'c'])
    expect(projectStore.projects.find((p) => p.id === 'a')!.userOrder).toBe(1)

    // ArrowRight 同语义（2 列网格 ←→↑↓ 四方向均可触发相邻交换）
    await cardById(wrapper, 'a').trigger('keydown.right')
    expect(wrapper.findAll('[data-testid="project-card"]').map((c) => c.attributes('data-project-id'))).toEqual(['b', 'c', 'a'])

    // 末位再 ArrowDown：无后一位，no-op
    await cardById(wrapper, 'a').trigger('keydown.down')
    expect(wrapper.findAll('[data-testid="project-card"]').map((c) => c.attributes('data-project-id'))).toEqual(['b', 'c', 'a'])
  })

  it('键盘通道与拖拽等价：同一初始态下 ArrowUp 交换结果 = 拖拽 reorderProject 结果', async () => {
    const projectStore = useProjectStore()
    projectStore.projects = [
      makeProject('a', 'Alpha', 0, 0),
      makeProject('b', 'Beta', 0, 1),
    ]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()
    // 键盘：b 上移到首位
    await cardById(wrapper, 'b').trigger('keydown.up')
    const afterKeyboard = projectStore.projects.map((p) => ({ id: p.id, userOrder: p.userOrder }))

    // 拖拽（新 store 实例、同初始态）：c…… 用 b 拖到 a 复现同一目标序
    wrapper.unmount()
    setActivePinia(createPinia())
    const store2 = useProjectStore()
    store2.projects = [
      makeProject('a', 'Alpha', 0, 0),
      makeProject('b', 'Beta', 0, 1),
    ]
    store2.activeProjectId = 'a'
    wrapper = mountSwitcher()
    dropOnto(wrapper, 'b', 'a')

    // 两条通道产出完全一致的 userOrder 提交（同一 reorderProject 入口的等价性）
    expect(store2.projects.map((p) => ({ id: p.id, userOrder: p.userOrder }))).toEqual(afterKeyboard)
    expect(store2.projects.find((p) => p.id === 'b')!.userOrder).toBe(0)
  })
})

describe('ProjectSwitcher 3A：新建流', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('点「新建项目」出内联 Input，Enter 创建并设为活跃', async () => {
    const projectStore = useProjectStore()
    projectStore.projects = [makeProject('a', 'Alpha')]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()
    await wrapper.find('[data-testid="project-add-btn"]').trigger('click')
    const input = wrapper.find('input[data-testid="project-create-input"]')
    expect(input.exists()).toBe(true)

    await input.setValue('新项目')
    await input.trigger('keydown.enter')

    expect(projectStore.projects.some((p) => p.name === '新项目')).toBe(true)
    expect(projectStore.activeProjectId).toBe(projectStore.projects.find((p) => p.name === '新项目')!.id)
    // 提交后回到 add 卡
    expect(wrapper.find('[data-testid="project-create-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-add-btn"]').exists()).toBe(true)
  })

  it('Esc 取消不创建', async () => {
    const projectStore = useProjectStore()
    projectStore.projects = [makeProject('a', 'Alpha')]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()
    await wrapper.find('[data-testid="project-add-btn"]').trigger('click')
    const input = wrapper.find('input[data-testid="project-create-input"]')
    await input.setValue('不创建')
    await input.trigger('keydown.esc')

    expect(projectStore.projects.some((p) => p.name === '不创建')).toBe(false)
    expect(wrapper.find('[data-testid="project-add-btn"]').exists()).toBe(true)
  })
})

describe('ProjectSwitcher 3A：删除流（右键 ContextMenu）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('默认项目卡右键无删除菜单项（review MF-1 双保险：组件侧不渲染）', async () => {
    const projectStore = useProjectStore()
    projectStore.projects = [makeProject(DEFAULT_PROJECT_ID, ''), makeProject('a', 'Alpha')]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()
    // 右键默认项目卡 → Portal v-if="canDelete(p)" 为 false，菜单整块不渲染
    // （触发写法对齐本文件命名卡正向用例；「Portal 整块不渲染」断言对齐 session-item-force-quit 先例）
    await cardById(wrapper, DEFAULT_PROJECT_ID).trigger('contextmenu')
    await nextTick()
    await nextTick()
    expect(document.body.querySelector('[data-testid="project-delete-item"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="project-context-menu"]')).toBeNull()
  })

  it('命名卡右键 → 删除项 → ConfirmDialog 确认 → removeProject 生效', async () => {
    const projectStore = useProjectStore()
    projectStore.projects = [
      makeProject(DEFAULT_PROJECT_ID, ''),
      makeProject('a', 'Alpha'),
      makeProject('b', 'Beta'),
    ]
    projectStore.activeProjectId = 'a'

    wrapper = mountSwitcher()
    // 右键 Beta 卡 → ContextMenu（teleport 到 body）→ 点删除项
    // （reka 菜单经两次 tick 才挂载完成，同 session-item-force-quit 先例）
    await cardById(wrapper, 'b').trigger('contextmenu')
    await nextTick()
    await nextTick()
    const deleteItem = document.body.querySelector('[data-testid="project-delete-item"]')
    expect(deleteItem).not.toBeNull()
    expect(deleteItem!.textContent).toContain('删除项目')
    // reka ContextMenuItem：原生 click（bubbles）触发 select（同 force-quit 先例）
    deleteItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    // ConfirmDialog（teleport 到 body）确认
    expect(document.body.textContent).toContain('确认删除项目「Beta」')
    findDialogButton('删除')!.dispatchEvent(new MouseEvent('click'))
    await nextTick()

    expect(projectStore.projects.some((p) => p.id === 'b')).toBe(false)
    expect(cardById(wrapper, 'b').exists()).toBe(false)
  })
})
