/**
 * GuiComponentRenderer 路由测试（审计项 C / P0+P1）。
 *
 * 验证：
 * - ansi-text 类型 → 渲染 AnsiText（lines join 成 content，ansi_up 着色）
 * - card 类型 → 路由到真实 Card 组件（不再降级 AnsiText JSON）
 * - custom 类型未注册 → 降级 AnsiText，content 为 props 的 JSON 文本
 * - custom 类型已注册（provide 'gui-custom-registry'）→ 路由到注册组件
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/GuiComponentRenderer.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import GuiComponentRenderer from '../GuiComponentRenderer.vue'
import { GUI_CUSTOM_REGISTRY_KEY } from '@taiji/core/rendering-protocol/custom-registry'
import type { GuiComponent } from '@taiji/extension-protocol'

describe('GuiComponentRenderer 路由', () => {
  it('ansi-text 类型 → 渲染 AnsiText，lines join 成 content', () => {
    const component: GuiComponent = {
      type: 'ansi-text',
      props: { lines: ['\x1b[32mhello\x1b[0m', 'world'] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // AnsiText 渲染了 data-testid="ansi-text"
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    // lines 被 join('\n')：ansi_up 把 ANSI 转成 span，"world" 作为纯文本保留
    expect(wrapper.text()).toContain('world')
    // v6：ansi_up use_classes=true 输出 class（绿色 → ansi-green-fg），非 inline color
    expect(wrapper.html()).toContain('ansi-green-fg')
  })

  it('card 类型 → 路由到真实 Card 组件（不再降级 AnsiText JSON）', () => {
    const component: GuiComponent = {
      type: 'card',
      props: { variant: 'elevated', body: [] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // 路由到 Card 组件而非 AnsiText
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('custom 类型未注册 → 降级 AnsiText，content 为 JSON 文本', () => {
    const component: GuiComponent = {
      type: 'custom',
      props: { component: 'my-widget', props: { count: 3 } },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // 降级到 AnsiText
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    // 未注册的 custom：序列化 props（含 component 名与嵌套 props）
    const text = wrapper.text()
    expect(text).toContain('"component": "my-widget"')
    expect(text).toContain('"count": 3')
  })

  it('custom 类型已注册（provide registry）→ 路由到注册组件', () => {
    // 一个桩注册组件，挂 data-testid 便于断言
    const MyWidget = defineComponent({
      name: 'MyWidget',
      props: { count: { type: Number, required: false } },
      setup(props) {
        return () =>
          h('div', { 'data-testid': 'my-widget' }, `count=${props.count ?? '-'}`)
      },
    })

    const component: GuiComponent = {
      type: 'custom',
      props: { component: 'my-widget', props: { count: 3 } },
    }
    const wrapper = mount(GuiComponentRenderer, {
      props: { component },
      global: {
        provide: { [GUI_CUSTOM_REGISTRY_KEY]: { 'my-widget': MyWidget } },
      },
    })

    // 路由到 MyWidget 而非 AnsiText
    expect(wrapper.find('[data-testid="my-widget"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
    // 注意：custom 的 props 形状是 { component, props }，注册组件收到的是整个 props 对象
    // （v-bind 直接展开 resolvedProps = component.props）
    expect(wrapper.text()).toContain('count=')
  })

  it('ansi-text 但 props 非 { lines: string[] } 形状（脏数据）→ 降级 AnsiText 序列化', () => {
    const component: GuiComponent = {
      type: 'ansi-text',
      props: { wrong: 'shape' } as unknown as GuiComponent['props'],
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // 仍渲染 AnsiText（不崩），content 序列化脏数据
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('"wrong": "shape"')
  })

  it('progress-bar → 路由到真实 ProgressBar 组件', () => {
    const component: GuiComponent = {
      type: 'progress-bar',
      props: { current: 3, total: 4 },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('stats-line → 路由到真实 StatsLine 组件', () => {
    const component: GuiComponent = {
      type: 'stats-line',
      props: { items: [{ value: '42' }] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('tab-bar → 路由到真实 TabBar 组件', () => {
    const component: GuiComponent = {
      type: 'tab-bar',
      props: { tabs: [{ label: 'tab1' }] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-tab-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('columns → 路由到真实 Columns 组件', () => {
    const component: GuiComponent = {
      type: 'columns',
      props: { children: [] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-columns"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('list-tree → 路由到真实 ListTree 组件', () => {
    const component: GuiComponent = {
      type: 'list-tree',
      props: { items: [{ label: 'item1' }] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })
})
