/**
 * CanvasNodeCard 组件测试（problem-solve-canvas §3.1(3) U7 节点卡通道验证）。
 *
 * 三视角：使用者黑盒为主——断言用户可见 DOM（类型徽标 / 生命周期视觉通道 /
 * 否决折叠 chip / 论据条 / 派发徽标与按钮）；交互断言 emitted 事件。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/canvas/canvas-node-card.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { CanvasNode } from '@zhushanwen/extension-protocol'
import CanvasNodeCard from './CanvasNodeCard.vue'
import CanvasArgStrip from './CanvasArgStrip.vue'
import type { HostArgs, LayoutPos } from './canvas-display'

const pos: LayoutPos = { x: 10, y: 20, w: 200, h: 60 }

function makeNode(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'o1',
    type: 'option',
    content: '混合形态方案',
    lifecycle: 'passed',
    createdAt: 'T0',
    ...overrides,
  }
}

const emptyArgs: HostArgs = { support: [], object: [] }

function argNode(id: string, polarity: 'support' | 'object'): CanvasNode {
  return { id, type: 'argument', content: `论据 ${id}`, lifecycle: 'draft', polarity, createdAt: 'T0' }
}

function mountCard(node: CanvasNode, extra: Record<string, unknown> = {}) {
  return mount(CanvasNodeCard, {
    props: {
      node,
      pos,
      args: emptyArgs,
      canDispatch: false,
      dirty: false,
      commentCount: 0,
      pendingComments: 0,
      focused: false,
      rebuttedIds: new Set<string>(),
      rejectedKids: 0,
      collapsed: false,
      ...extra,
    },
  })
}

describe('CanvasNodeCard 类型与生命周期视觉通道', () => {
  it('question 卡 Q 徽标 + 类型词条；option 卡 O 徽标', () => {
    const q = mountCard(makeNode({ id: 'q1', type: 'question', content: '根问题' }))
    expect(q.find('[data-node-id="q1"]').exists()).toBe(true)
    expect(q.get('[data-testid="canvas-node-title"]').text()).toContain('根问题')
    expect(q.get('b').text()).toBe('Q')

    const o = mountCard(makeNode())
    expect(o.get('b').text()).toBe('O')
  })

  it.each(['draft', 'under-review', 'passed', 'rejected', 'shelved'] as const)('生命周期 %s → 边框/透明度通道 + data-lifecycle', (lifecycle) => {
    const wrapper = mountCard(makeNode({ lifecycle }))
    const root = wrapper.get('[data-node-id="o1"]')
    expect(root.attributes('data-lifecycle')).toBe(lifecycle)
    const cls = root.classes().join(' ')
    if (lifecycle === 'draft') expect(cls).toContain('border-dashed')
    if (lifecycle === 'under-review') expect(cls).toContain('border-warn')
    if (lifecycle === 'passed') expect(cls).not.toContain('border-warn')
    if (lifecycle === 'rejected') expect(cls).toContain('opacity-55')
    if (lifecycle === 'shelved') expect(cls).toContain('opacity-70')
  })

  it('rejected 卡标题删除线 + 状态点 title 随生命周期', () => {
    const wrapper = mountCard(makeNode({ lifecycle: 'rejected' }))
    expect(wrapper.get('[data-testid="canvas-node-title"]').classes().join(' ')).toContain('line-through')
    expect(wrapper.get('[data-testid="canvas-node-status-dot"]').attributes('title')).toBeTruthy()
  })

  it('待重审角标（dirty）与评论气泡（含待响应醒目）按 props 出现', () => {
    const plain = mountCard(makeNode())
    expect(plain.find('[data-testid="canvas-node-recheck-badge"]').exists()).toBe(false)
    expect(plain.find('[data-testid="canvas-node-comments-badge"]').exists()).toBe(false)

    const marked = mountCard(makeNode(), { dirty: true, commentCount: 2, pendingComments: 1 })
    expect(marked.get('[data-testid="canvas-node-recheck-badge"]').exists()).toBe(true)
    expect(marked.get('[data-testid="canvas-node-comments-badge"]').text()).toBe('2')
  })
})

describe('CanvasNodeCard 否决折叠 chip', () => {
  it('rejectedKids > 0 渲染 chip；点击上抛 toggle-collapse；collapsed 切换箭头', async () => {
    const expanded = mountCard(makeNode({ lifecycle: 'rejected' }), { rejectedKids: 3, collapsed: false })
    const chip = expanded.get('[data-testid="canvas-node-rejected-chip"]')
    expect(chip.text()).toContain('▾')
    await chip.trigger('click')
    expect(expanded.emitted('toggle-collapse')).toHaveLength(1)

    const collapsed = mountCard(makeNode({ lifecycle: 'rejected' }), { rejectedKids: 3, collapsed: true })
    expect(collapsed.get('[data-testid="canvas-node-rejected-chip"]').text()).toContain('▸')
  })

  it('rejectedKids = 0 无 chip（否决折叠只在有否决子节点时出现）', () => {
    const wrapper = mountCard(makeNode())
    expect(wrapper.find('[data-testid="canvas-node-rejected-chip"]').exists()).toBe(false)
  })
})

describe('CanvasNodeCard 论据条', () => {
  it('support / object 论据分组各自渲染；条目选中上抛 select', async () => {
    const wrapper = mountCard(makeNode(), {
      args: { support: [argNode('a1', 'support')], object: [argNode('a2', 'object')] },
    })
    const strips = wrapper.findAllComponents(CanvasArgStrip)
    expect(strips).toHaveLength(2)

    await strips[0].vm.$emit('select', 'a1')
    await strips[1].vm.$emit('select', 'a2')
    const ids = wrapper.emitted('select')?.map((args) => args[0])
    expect(ids).toEqual(['a1', 'a2'])
  })

  it('无论据时无论据条', () => {
    const wrapper = mountCard(makeNode())
    expect(wrapper.findAllComponents(CanvasArgStrip)).toHaveLength(0)
  })
})

describe('CanvasNodeCard 派发通道（不变量 7 的 UI 预判）', () => {
  it('已派发 → 徽标（带指针 title），无派发按钮', () => {
    const wrapper = mountCard(makeNode({ dispatch: { pointer: 'docs/design/x.md', dispatchedAt: 'T1' } }), { canDispatch: true })
    expect(wrapper.get('[data-testid="canvas-node-dispatched-badge"]').attributes('title')).toBe('docs/design/x.md')
    expect(wrapper.find('[data-testid="canvas-node-dispatch-button"]').exists()).toBe(false)
  })

  it('执行叶子 + passed + 未派发 + canDispatch → 派发按钮；点击上抛 dispatch(nodeId)', async () => {
    const wrapper = mountCard(makeNode(), { canDispatch: true })
    await wrapper.get('[data-testid="canvas-node-dispatch-button"]').trigger('click')
    expect(wrapper.emitted('dispatch')?.[0]).toEqual(['o1'])
  })

  it('canDispatch = false → 无派发按钮（权限前置由父层判定，卡不越权展示）', () => {
    const wrapper = mountCard(makeNode())
    expect(wrapper.find('[data-testid="canvas-node-dispatch-button"]').exists()).toBe(false)
  })
})
