/**
 * Actionbar 组件测试（AP-3：GuiComponent 协议首个交互原语，设计 §3.3 D2/D8）。
 *
 * 覆盖：喂树渲染 N 按钮（用户可见 DOM 断言）；点击经 ACTION_EXECUTOR_KEY 注入的
 * 执行器收到 (commandId, args)；disabled 禁点；commandId 缺省 = 纯展示（不可点、
 * 弱化样式）；kind:'danger' 危险样式档；执行器缺位退化纯展示 + warn（TabBar 降级
 * 出声范式）。喂树用例经 GuiComponentRenderer 挂载（= 应用路径：白名单透传 →
 * BUILTIN_MAP 路由 → 本组件）。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/Actionbar.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { GuiComponent, GuiComponentProps } from '@zhushanwen/extension-protocol'
import Actionbar from '../primitives/Actionbar.vue'
import GuiComponentRenderer from '../GuiComponentRenderer.vue'
import { ACTION_EXECUTOR_KEY, type ActionExecutor, type ActionArgs } from '../action-executor-key'

type Items = GuiComponentProps['action-bar']['items']

type ExecuteFn = (id: string, args?: ActionArgs) => void

const makeExecutor = (): { execute: ReturnType<typeof vi.fn<ExecuteFn>> } & ActionExecutor => ({
  execute: vi.fn<ExecuteFn>(),
})

// console.warn spy 跨用例复位（vi.spyOn 对同方法复用底层 mock，不 restore 会累积调用计数）
afterEach(() => {
  vi.restoreAllMocks()
})

/** 应用路径喂树：GuiComponentRenderer 挂载（壳层 provide 执行器，同 renderer 组合形态） */
const mountViaRenderer = (items: Items, executor: ActionExecutor) =>
  mount(GuiComponentRenderer, {
    props: {
      component: { type: 'action-bar', props: { items } } satisfies GuiComponent<'action-bar'>,
    },
    global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
  })

describe('Actionbar 渲染', () => {
  it('喂树渲染 N 按钮：容器 + 逐项 testid + label 文本可见（用户可见 DOM 断言）', () => {
    const executor = makeExecutor()
    const wrapper = mountViaRenderer(
      [
        { id: 'pause-1', label: '暂停', commandId: 'sched.toggle', args: { id: 'job-9' } },
        { id: 'run-1', label: '立即执行', commandId: 'sched.run', args: { id: 'job-9' } },
        { id: 'stat-1', label: '共 2 项' },
      ],
      executor,
    )
    expect(wrapper.find('[data-testid="gui-action-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-action-bar-item-pause-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-action-bar-item-run-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-action-bar-item-stat-1"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('暂停')
    expect(wrapper.text()).toContain('立即执行')
    expect(wrapper.text()).toContain('共 2 项')
  })

  it('空 items 渲染容器不崩', () => {
    const wrapper = mount(Actionbar, { props: { items: [] } })
    expect(wrapper.find('[data-testid="gui-action-bar"]').exists()).toBe(true)
    expect(wrapper.findAll('.action-bar__item')).toHaveLength(0)
  })

  it('danger 项走危险样式档（text-danger），普通项无 danger 色', () => {
    // danger 色只在 actionable 态生效（需执行器可用），故 provide 执行器挂载
    const executor = makeExecutor()
    const wrapper = mount(Actionbar, {
      props: {
        items: [
          { id: 'rm-1', label: '删除', kind: 'danger', commandId: 'sched.rm' },
          { id: 'pause-1', label: '暂停', commandId: 'sched.toggle' },
        ],
      },
      global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
    })
    const dangerBtn = wrapper.find('[data-testid="gui-action-bar-item-rm-1"]')
    const normalBtn = wrapper.find('[data-testid="gui-action-bar-item-pause-1"]')
    expect(dangerBtn.classes()).toContain('text-danger')
    expect(normalBtn.classes()).not.toContain('text-danger')
  })
})

describe('Actionbar 点击 → 执行器（D2 命令链契约）', () => {
  const items: Items = [
    { id: 'pause-1', label: '暂停', commandId: 'sched.toggle', args: { id: 'job-9' } },
    { id: 'run-1', label: '立即执行', commandId: 'sched.run' },
    { id: 'rm-1', label: '删除', kind: 'danger', disabled: true, commandId: 'sched.rm', args: { id: 'job-9' } },
    { id: 'stat-1', label: '共 2 项' },
  ]

  const mountWithExecutor = () => {
    const executor = makeExecutor()
    const wrapper = mount(Actionbar, {
      props: { items },
      global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
    })
    return { executor, wrapper }
  }

  it('点击可点项 → 执行器收到 (commandId, args)', async () => {
    const { executor, wrapper } = mountWithExecutor()
    await wrapper.find('[data-testid="gui-action-bar-item-pause-1"]').trigger('click')
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledWith('sched.toggle', { id: 'job-9' })
  })

  it('args 缺省 → 执行器收到 (commandId, undefined)', async () => {
    const { executor, wrapper } = mountWithExecutor()
    await wrapper.find('[data-testid="gui-action-bar-item-run-1"]').trigger('click')
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledWith('sched.run', undefined)
  })

  it('disabled 项禁点：disabled 属性 + 禁用样式 + 点击不触发执行器', async () => {
    const { executor, wrapper } = mountWithExecutor()
    const btn = wrapper.find('[data-testid="gui-action-bar-item-rm-1"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.classes()).toContain('disabled:pointer-events-none')
    expect(btn.classes()).toContain('disabled:opacity-50')
    await btn.trigger('click')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('commandId 缺省 = 纯展示：span 非按钮语义 + 弱化样式，点击不触发', async () => {
    const { executor, wrapper } = mountWithExecutor()
    const node = wrapper.find('[data-testid="gui-action-bar-item-stat-1"]')
    expect(node.element.tagName).toBe('SPAN')
    expect(node.classes()).toContain('text-neutral-dim')
    await node.trigger('click')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('可点项 ghost 档可点样式（hover 反馈），disabled 属性不设置', () => {
    const { wrapper } = mountWithExecutor()
    const btn = wrapper.find('[data-testid="gui-action-bar-item-pause-1"]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.classes()).toContain('hover:bg-surface-hover')
    expect(btn.classes()).not.toContain('text-danger')
  })

  it('danger + disabled 并存时 disabled 优先（禁点优先于样式档）', () => {
    const { wrapper } = mountWithExecutor()
    const btn = wrapper.find('[data-testid="gui-action-bar-item-rm-1"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.classes()).toContain('text-danger')
  })
})

describe('Actionbar 执行器缺位降级（对齐 TabBar 降级出声范式）', () => {
  it('无执行器上下文：带 commandId 项禁用（不可点）+ warn 一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(Actionbar, {
      props: {
        items: [
          { id: 'pause-1', label: '暂停', commandId: 'sched.toggle', args: { id: 'job-9' } },
          { id: 'stat-1', label: '共 2 项' },
        ],
      },
    })
    const btn = wrapper.find('[data-testid="gui-action-bar-item-pause-1"]')
    expect(btn.attributes('disabled')).toBeDefined()
    // 纯展示项本就不需要执行器 → 只因可执行项缺执行器出声一次
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('ACTION_EXECUTOR_KEY')

    // 禁用态点击不产生任何执行（无执行器可调，组件内 guard 拦截）
    await btn.trigger('click')
    // 重复推送同形态不重复出声
    await wrapper.setProps({ items: [{ id: 'pause-1', label: '暂停', commandId: 'sched.toggle' }] })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('纯展示 items（无 commandId）在无执行器上下文不出声', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(Actionbar, { props: { items: [{ id: 'stat-1', label: '共 2 项' }] } })
    expect(warn).not.toHaveBeenCalled()
  })
})
