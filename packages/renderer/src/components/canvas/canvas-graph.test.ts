/**
 * CanvasGraph 首帧自适应全景测试（problem-solve-canvas §3.1(3) U7）。
 *
 * 三视角：使用者黑盒——断言用户可见 DOM（canvas-plane 的 transform 字符串）。
 *
 * 覆盖语义（用户诉求「默认自适应全景，后续用户自行调整」的切换点）：
 * 1. 挂载即适配（DOM 就绪首帧 fit，视口离开初始档位）
 * 2. 用户未接管前，布局 bbox 变化（数据生长）持续跟随重适配
 * 3. 用户滚轮缩放接管后，后续布局变化不再自动重置视口
 * 4. 手动 fit 按钮（右下 ⤢）执行适配并接管视口
 *
 * 运行：cd packages/renderer && npx vitest run src/components/canvas/canvas-graph.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { CanvasState } from '@zhushanwen/extension-protocol'
import CanvasGraph from './CanvasGraph.vue'

/** 最小画布：根 → 子问题 → 两候选（happy-dom clientWidth=0 → fit 落 K_MIN=0.28 钳位）。 */
function makeState(overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    canvasId: 'cvs-1',
    name: '画布规划',
    root: { nodeId: 'root', statement: '根问题', criterias: ['判据一'], scopeExclusions: [] },
    direction: null,
    nodes: [
      { id: 'root', type: 'question', content: '根问题怎么解', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'q2', type: 'question', content: '子问题拆解', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'o1', type: 'option', content: '方案一', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'o2', type: 'option', content: '方案二', lifecycle: 'draft', createdAt: 'T0' },
    ],
    edges: [
      { id: 'ed-1', type: 'decompose', from: 'root', to: 'q2' },
      { id: 'er-1', type: 'resolve', from: 'q2', to: 'o1' },
      { id: 'er-2', type: 'resolve', from: 'q2', to: 'o2' },
    ],
    comments: [],
    dirtyPaths: [],
    review: null,
    converged: false,
    createdAt: 'T0',
    updatedAt: 'T0',
    ...overrides,
  }
}

/** 加宽画布的生长态（bbox 变化——fit 若跟随重算，translate 必变）。 */
const grownState = makeState({
  nodes: [
    ...makeState().nodes,
    { id: 'o3', type: 'option', content: '方案三', lifecycle: 'draft', createdAt: 'T1' },
  ],
  edges: [...makeState().edges, { id: 'er-3', type: 'resolve', from: 'q2', to: 'o3' }],
  updatedAt: 'T1',
})

function planeTransform(wrapper: ReturnType<typeof mount>): string {
  const el = wrapper.find('[data-testid="canvas-plane"]')
  return el.attributes('style') ?? ''
}

describe('CanvasGraph 首帧自适应全景', () => {
  it('挂载即适配：视口离开初始档位（fit 首帧执行）', async () => {
    const wrapper = mount(CanvasGraph, { props: { state: makeState(), selectedId: null } })
    // onMounted 内 fit 改 ref，DOM 更新在下一个微任务 flush
    await nextTick()
    const style = planeTransform(wrapper)
    // 初始档位 scale(0.9) 被 fit 覆盖（容器 0 尺寸 → K_MIN 钳位 0.28）
    expect(style).not.toContain('scale(0.9)')
    expect(style).toContain('scale(0.28)')
  })

  it('布局变化跟随重适配：数据生长后 bbox 变化，视口重新 fit', async () => {
    const wrapper = mount(CanvasGraph, { props: { state: makeState(), selectedId: null } })
    const before = planeTransform(wrapper)
    await wrapper.setProps({ state: grownState })
    await nextTick()
    expect(planeTransform(wrapper)).not.toBe(before)
  })

  it('用户滚轮缩放接管后，后续布局变化不再自动重置视口', async () => {
    const wrapper = mount(CanvasGraph, { props: { state: makeState(), selectedId: null } })
    await wrapper.find('[data-testid="canvas-viewport"]').trigger('wheel', { deltaY: -100 })
    await nextTick()
    const afterWheel = planeTransform(wrapper)
    expect(afterWheel).not.toContain('scale(0.28)')

    await wrapper.setProps({ state: grownState })
    await nextTick()
    expect(planeTransform(wrapper)).toBe(afterWheel)
  })

  it('手动 fit 按钮执行适配并接管：后续数据生长不再重置视口', async () => {
    const wrapper = mount(CanvasGraph, { props: { state: makeState(), selectedId: null } })
    // 先滚轮打乱视口（k≠fit 值），再点手动 fit 验证「接管 + 重新适配」双语义
    await wrapper.find('[data-testid="canvas-viewport"]').trigger('wheel', { deltaY: -100 })
    await nextTick()
    await wrapper.find('[data-testid="canvas-fit-view"]').trigger('click')
    await nextTick()
    const afterManualFit = planeTransform(wrapper)
    expect(afterManualFit).toContain('scale(0.28)')

    await wrapper.setProps({ state: grownState })
    await nextTick()
    expect(planeTransform(wrapper)).toBe(afterManualFit)
  })
})
