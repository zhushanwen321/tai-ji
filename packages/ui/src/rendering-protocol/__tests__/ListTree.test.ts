/**
 * ListTree 组件测试（W3 · v6 视觉改造 + 容器扩展点统一 §6.4 行点击动作）。
 * v6：缩进 16px、icon size-3 中性、status 7px 圆点（bg-success/accent/danger）右对齐。
 * §6.4：action 行渲染为原生 button（键盘可达，PB-4 构造性承载），点击经
 * dispatchTreeInteraction 分派（commandId 优先命令链 / hostAction 容器导航执行器）。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/ListTree.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ListTree from '../primitives/ListTree.vue'
import type { TreeItem, HostContainerAction } from '@zhushanwen/extension-protocol'
import { ACTION_EXECUTOR_KEY, type ActionExecutor, type ActionArgs } from '../action-executor-key'
import {
  CONTAINER_NAVIGATION_KEY,
  VIEW_SCOPE_SESSION_KEY,
  type ContainerNavigationExecutor,
  type NavigateOptions,
} from '../container-navigation-key'

type ExecuteFn = (id: string, args?: ActionArgs) => void

type NavigateFn = (action: HostContainerAction, options?: NavigateOptions) => void

const makeCommandExecutor = (): { execute: ReturnType<typeof vi.fn<ExecuteFn>> } & ActionExecutor => ({
  execute: vi.fn<ExecuteFn>(),
})

const makeNavigationExecutor = (): { navigate: ReturnType<typeof vi.fn<NavigateFn>> } & ContainerNavigationExecutor => ({
  navigate: vi.fn<NavigateFn>(),
})

// console.warn spy 跨用例复位（vi.spyOn 对同方法复用底层 mock，不 restore 会累积调用计数）
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ListTree', () => {
  it('递归渲染：parent 含嵌套 children + status 圆点', () => {
    const items: TreeItem[] = [
      {
        label: 'parent',
        icon: 'arrow',
        children: [
          { label: 'child1', status: 'done' },
          { label: 'child2', status: 'running' },
        ],
      },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('parent')
    expect(wrapper.text()).toContain('child1')
    expect(wrapper.text()).toContain('child2')
    // v6: status 是圆点（bg-*），done→bg-success，running→bg-accent
    const statuses = wrapper.findAll('[data-testid="list-tree-status"]')
    expect(statuses).toHaveLength(2)
    expect(statuses[0].classes()).toContain('bg-success')
    expect(statuses[1].classes()).toContain('bg-accent')
  })

  it('failed status 圆点 bg-danger', () => {
    const items: TreeItem[] = [
      { label: 'failed-item', status: 'failed' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    expect(wrapper.find('[data-testid="list-tree-status"]').classes()).toContain('bg-danger')
  })

  it('v6: depth 缩进 16px/层，depth=2 时 padding-left=32px', () => {
    const items: TreeItem[] = [
      { label: 'deep' },
    ]
    const wrapper = mount(ListTree, { props: { items, depth: 2 } })
    const item = wrapper.find('.list-tree__item')
    expect(item.attributes('style')).toContain('padding-left: 32px')
  })

  it('递归 children 自动 depth+1 缩进（children padding > parent padding）', () => {
    const items: TreeItem[] = [
      {
        label: 'parent',
        children: [
          { label: 'child' },
        ],
      },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const allItems = wrapper.findAll('.list-tree__item')
    expect(allItems).toHaveLength(2)
    // parent 在 depth=0 → padding-left: 0px
    expect(allItems[0].attributes('style')).toContain('padding-left: 0px')
    // v6: child 在 depth=1 → padding-left: 16px（比 parent 缩进）
    expect(allItems[1].attributes('style')).toContain('padding-left: 16px')
  })

  it('v6: status 改圆点后无文字标签（无进行中/完成/失败文本）', () => {
    const items: TreeItem[] = [
      { label: 'a', status: 'running' },
      { label: 'b', status: 'done' },
      { label: 'c', status: 'failed' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const statuses = wrapper.findAll('[data-testid="list-tree-status"]')
    expect(statuses).toHaveLength(3)
    // 圆点无文字内容
    for (const s of statuses) {
      expect(s.text()).toBe('')
    }
    // 整体文本不含旧 STATUS_LABEL 中文
    expect(wrapper.text()).not.toContain('进行中')
    expect(wrapper.text()).not.toContain('完成')
    expect(wrapper.text()).not.toContain('失败')
  })

  it('v6: status 圆点右对齐 + 7px 尺寸 + rounded-full', () => {
    const items: TreeItem[] = [
      { label: 'a', status: 'done' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const dot = wrapper.find('[data-testid="list-tree-status"]')
    expect(dot.classes()).toContain('ml-auto')
    expect(dot.classes()).toContain('size-[7px]')
    expect(dot.classes()).toContain('rounded-full')
    expect(dot.classes()).toContain('bg-success')
  })

  it('v6: icon size-3(12px) 且中性（无 status text-* 着色）', () => {
    const items: TreeItem[] = [
      { label: 'checked', icon: 'check', status: 'done' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const icon = wrapper.find('.list-tree__icon svg')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('size-3')
    // v6: icon 不再着 status 色（中性，继承 label）
    expect(icon.classes()).not.toContain('text-success')
    expect(icon.classes()).not.toContain('text-accent')
    expect(icon.classes()).not.toContain('text-danger')
  })

  it('icon=check 渲染对应图标', () => {
    const items: TreeItem[] = [
      { label: 'checked', icon: 'check' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    // check icon 用 lucide Check 组件（svg）
    expect(wrapper.find('.list-tree__icon svg').exists()).toBe(true)
  })

  it('空 items 不崩', () => {
    const wrapper = mount(ListTree, { props: { items: [] } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
  })

  it('label 单行截断（min-w-0 + truncate）：todo/criteria/scheduler 长行不撑破托盘浮层', () => {
    const items: TreeItem[] = [
      { label: '把会话归属写入 sidecar 后补一组等价性测试，覆盖 fork 与 restore 两条路径' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const label = wrapper.findAll('span').find((s) => s.text().includes('sidecar'))!
    expect(label.classes()).toContain('min-w-0')
    expect(label.classes()).toContain('flex-1')
    expect(label.classes()).toContain('truncate')
  })
})

describe('ListTree 行点击动作（§6.4 导航原语，U5 验收③④）', () => {
  const drawerHostAction: HostContainerAction = { kind: 'drawer', tabId: 'doc', params: { commandName: 'commit' } }

  const mountWithExecutors = (items: TreeItem[]) => {
    const cmd = makeCommandExecutor()
    const nav = makeNavigationExecutor()
    const wrapper = mount(ListTree, {
      props: { items },
      global: {
        provide: {
          [ACTION_EXECUTOR_KEY as symbol]: cmd,
          [CONTAINER_NAVIGATION_KEY as symbol]: nav,
          [VIEW_SCOPE_SESSION_KEY as symbol]: 'view-sid',
        },
      },
    })
    return { cmd, nav, wrapper }
  }

  it('action 行渲染为原生 button（键盘可达探针 PB-4 的 DOM 层：Tab 可聚焦 + Enter/Space 触发 click）', () => {
    const { wrapper } = mountWithExecutors([
      { label: '可点行', action: { hostAction: drawerHostAction } },
      { label: '纯展示行' },
    ])
    const actionRow = wrapper.find('[data-testid="gui-list-tree-action-0"]')
    expect(actionRow.exists()).toBe(true)
    expect(actionRow.element.tagName).toBe('BUTTON')
    expect(actionRow.attributes('type')).toBe('button')
    expect(actionRow.attributes('disabled')).toBeUndefined()
    // 纯展示行维持 div（旧行为），无 action testid
    expect(wrapper.findAll('.list-tree__item')[1]!.element.tagName).toBe('DIV')
  })

  it('点击 hostAction 行 → 导航执行器收到 (action, { viewSessionId })，命令执行器不被调用', async () => {
    const { cmd, nav, wrapper } = mountWithExecutors([
      { label: '打开文档', action: { hostAction: drawerHostAction } },
    ])
    await wrapper.find('[data-testid="gui-list-tree-action-0"]').trigger('click')
    expect(nav.navigate).toHaveBeenCalledTimes(1)
    expect(nav.navigate).toHaveBeenCalledWith(drawerHostAction, { viewSessionId: 'view-sid' })
    expect(cmd.execute).not.toHaveBeenCalled()
  })

  it('点击 commandId 行 → 走既有命令链（并存 hostAction 时 commandId 优先，与 Actionbar 同源）', async () => {
    const { cmd, nav, wrapper } = mountWithExecutors([
      { label: '重试', action: { commandId: 'sched.retry', hostAction: drawerHostAction } },
    ])
    await wrapper.find('[data-testid="gui-list-tree-action-0"]').trigger('click')
    expect(cmd.execute).toHaveBeenCalledTimes(1)
    expect(cmd.execute).toHaveBeenCalledWith('sched.retry', undefined)
    expect(nav.navigate).not.toHaveBeenCalled()
  })

  it('递归 children 内的 action 行同样可点（inject 沿组件链取到同一执行器）', async () => {
    const { nav, wrapper } = mountWithExecutors([
      {
        label: 'parent',
        children: [{ label: 'child', action: { hostAction: drawerHostAction } }],
      },
    ])
    const childRow = wrapper.find('[data-testid="gui-list-tree-action-0"]')
    await childRow.trigger('click')
    expect(nav.navigate).toHaveBeenCalledTimes(1)
    expect(nav.navigate).toHaveBeenCalledWith(drawerHostAction, { viewSessionId: 'view-sid' })
  })

  it('纯展示行点击不触发任何执行器（旧行为零变化）', async () => {
    const { cmd, nav, wrapper } = mountWithExecutors([{ label: '纯展示行' }])
    await wrapper.findAll('.list-tree__item')[0]!.trigger('click')
    expect(cmd.execute).not.toHaveBeenCalled()
    expect(nav.navigate).not.toHaveBeenCalled()
  })

  it('action 空对象（两字段缺省）按纯展示行处理：无 action testid、不渲染 button', () => {
    const { wrapper } = mountWithExecutors([{ label: '空动作', action: {} }])
    expect(wrapper.find('[data-testid="gui-list-tree-action-0"]').exists()).toBe(false)
    expect(wrapper.findAll('.list-tree__item')[0]!.element.tagName).toBe('DIV')
  })
})
