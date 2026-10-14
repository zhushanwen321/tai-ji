/**
 * RunningBlockIcon 单测——运行中专属动效图标（每类活动一种动效）。
 *
 * jsdom 下 CSS 动画不可观测，断言锚定结构性事实：kind → data-running-icon 值、
 * 字形/动效元素的存在性、颜色 token 引用（style 静态检查级别）。
 * 视觉动效本身由 demo（demo1-thinking-vs-working.html）与真机验收承担。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RunningBlockIcon from '../RunningBlockIcon.vue'

describe('RunningBlockIcon', () => {
  it('kind 直通 data-running-icon 属性（测试/视觉回归锚点）', () => {
    for (const kind of ['thinking', 'tool-read', 'tool-bash', 'tool-edit', 'tool-grep', 'subagent', 'workflow', 'tool-other'] as const) {
      const wrapper = mount(RunningBlockIcon, { props: { kind } })
      expect(wrapper.find('[data-running-icon]').attributes('data-running-icon')).toBe(kind)
    }
  })

  it('thinking = 轨道点（无字形，核 + 双卫星）', () => {
    const wrapper = mount(RunningBlockIcon, { props: { kind: 'thinking' } })
    // 唯一无字形档：思考无实体动作，动效本体 = 轨道点
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.find('.rbi-orbit-core').exists()).toBe(true)
    expect(wrapper.findAll('.rbi-orbit-sat')).toHaveLength(2)
  })

  it('tool-read = 字形 + 扫描线（字形保留，动效 = accent 元素）', () => {
    const wrapper = mount(RunningBlockIcon, { props: { kind: 'tool-read' } })
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.find('.rbi-scan').exists()).toBe(true)
  })

  it('tool-bash = 字形内光标闪烁元素', () => {
    const wrapper = mount(RunningBlockIcon, { props: { kind: 'tool-bash' } })
    expect(wrapper.find('.rbi-blink').exists()).toBe(true)
  })

  it('tool-edit = 字形 + 描线', () => {
    const wrapper = mount(RunningBlockIcon, { props: { kind: 'tool-edit' } })
    expect(wrapper.find('.rbi-draw').exists()).toBe(true)
  })

  it('tool-grep = 字形 + 透镜扫掠', () => {
    const wrapper = mount(RunningBlockIcon, { props: { kind: 'tool-grep' } })
    expect(wrapper.find('.rbi-lens-sweep').exists()).toBe(true)
  })

  it('subagent = 字形 + 在线脉冲', () => {
    const wrapper = mount(RunningBlockIcon, { props: { kind: 'subagent' } })
    expect(wrapper.find('.rbi-presence').exists()).toBe(true)
  })

  it('workflow = 双节点字形 + 连线行进点（composer Workflow 字形同源）', () => {
    const wrapper = mount(RunningBlockIcon, { props: { kind: 'workflow' } })
    expect(wrapper.find('.rbi-wf-travel').exists()).toBe(true)
    expect(wrapper.findAll('.rbi-node')).toHaveLength(2)
    // 两 rect 节点 + 一条连线 = workflow 图标三件套（非 list-checks）
    expect(wrapper.findAll('rect')).toHaveLength(2)
  })

  it('tool-other = 字形呼吸兜底档', () => {
    const wrapper = mount(RunningBlockIcon, { props: { kind: 'tool-other' } })
    expect(wrapper.find('.rbi-breathe').exists()).toBe(true)
    expect(wrapper.find('svg').exists()).toBe(true)
  })
})
