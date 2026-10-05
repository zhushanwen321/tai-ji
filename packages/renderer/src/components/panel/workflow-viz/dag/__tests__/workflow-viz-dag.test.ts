/**
 * WorkflowVizDag 画布组件测试（workflow-visualization U4；三视角）。
 *
 * - 使用者黑盒：phase 分区 / 节点 / 边的用户可见渲染、点击上抛语义、当前 phase
 *   高亮、零节点居中摘要提示——每条用例至少一个用户可见 DOM 断言；
 * - 构建者白盒：布局几何归 layout 纯函数单测（workflow-viz-dag-layout.test.ts），
 *   此处只测画布装配（props → DOM 形态映射）；
 * - 观察者形态：data-state 六态点亮、data-stop-tone 停止叠加、节点级渲染边界
 *   （单节点占位错误态不挂整画布）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/dag/__tests__/workflow-viz-dag.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { WorkflowDag, WorkflowDagNode } from '@taiji/shared'
import WorkflowVizDag from '../WorkflowVizDag.vue'
import type { WorkflowVizDagNodeStatus } from '../../dag/types'

function node(partial: Partial<WorkflowDagNode> & { id: string }): WorkflowDagNode {
  return {
    kind: 'agent',
    templateName: partial.id,
    matchPattern: '',
    phase: 'gate',
    line: 1,
    ...partial,
  }
}

function sampleDag(): WorkflowDag {
  return {
    phases: [
      { name: 'gate', order: 0 },
      { name: 'review', order: 1 },
    ],
    nodes: [
      node({ id: 'n-gate', templateName: 'preflight', kind: 'script-step', phase: 'gate' }),
      node({ id: 'n-biz', templateName: 'reviewer-biz', phase: 'review' }),
      node({ id: 'n-sec', templateName: 'reviewer-sec', phase: 'review' }),
    ],
    edges: [
      { id: 'e-seq', from: 'n-gate', to: 'n-biz', kind: 'sequence' },
      { id: 'e-cond', from: 'n-biz', to: 'n-sec', kind: 'conditional', predicate: 'fixMode === apply' },
      { id: 'e-loop', from: 'n-sec', to: 'n-biz', kind: 'loop-back' },
    ],
    parallelGroups: [],
    loops: [],
  }
}

function mountDag(dagInput: WorkflowDag | null = sampleDag(), props: Record<string, unknown> = {}) {
  return mount(WorkflowVizDag, {
    props: { dag: dagInput, ...props },
  })
}

describe('WorkflowVizDag 画布（黑盒 DOM）', () => {
  it('渲染 phase 分区列与全部节点卡片（用户可见：分区标题与节点名）', () => {
    const wrapper = mountDag()
    expect(wrapper.find('[data-testid="wfvz-dag-root"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-review"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').exists()).toBe(true)
    // 节点名可见（截断前缀）
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').text()).toContain('preflight')
    // 三条边（顺序/条件/回边）渲染
    expect(wrapper.find('[data-testid="wfvz-dag-edge-e-seq"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-edge-e-cond"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-edge-e-loop"]').exists()).toBe(true)
  })

  it('六态点亮：nodeStates 映射到节点 data-state（观察者形态）', () => {
    const nodeStates: Record<string, WorkflowVizDagNodeStatus> = {
      'n-gate': 'done',
      'n-biz': 'running',
      'n-sec': 'retrying',
    }
    const wrapper = mountDag(sampleDag(), { nodeStates })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').attributes('data-state')).toBe('done')
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-state')).toBe('running')
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-sec"]').attributes('data-state')).toBe('retrying')
  })

  it('缺失映射的节点按 pending 兜底（run 运行中零实例节点一律 pending）', () => {
    const wrapper = mountDag(sampleDag(), { nodeStates: { 'n-gate': 'done' } })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').attributes('data-state')).toBe('done')
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-state')).toBe('pending')
  })

  it('当前 phase 分区高亮：activePhase 命中分区 data-active（观察者形态）', () => {
    const wrapper = mountDag(sampleDag(), { activePhase: 'review' })
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-review"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').attributes('data-active')).toBeUndefined()
  })

  it('agent 节点点击 → select agent 语义（携带调用点身份）', async () => {
    const wrapper = mountDag(sampleDag(), { nodeStates: { 'n-biz': 'done' } })
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerup')
    const events = wrapper.emitted('select')
    expect(events).toHaveLength(1)
    expect(events?.[0]?.[0]).toEqual({
      semantic: 'agent',
      nodeId: 'n-biz',
      templateName: 'reviewer-biz',
      phase: 'review',
    })
  })

  it('pending 节点点击 = phase 语义（零实例、无对话可看）', async () => {
    const wrapper = mountDag(sampleDag())
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerup')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({ semantic: 'phase', phase: 'review' })
  })

  it('run 终局后 skipped 节点点击 = phase 语义（与 pending 同路由，非静默 no-op）', async () => {
    const wrapper = mountDag(sampleDag(), { nodeStates: { 'n-biz': 'skipped' } })
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerup')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({ semantic: 'phase', phase: 'review' })
  })

  it('phase 分区点击 → select phase 语义', async () => {
    const wrapper = mountDag(sampleDag())
    await wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').trigger('pointerup')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({ semantic: 'phase', phase: 'gate' })
  })

  it('条件边谓词标注可见（用户可见：predicate 截断文本）', () => {
    const wrapper = mountDag(sampleDag())
    const labels = wrapper.findAll('text').filter((t) => t.text().includes('fixMode'))
    expect(labels.length).toBeGreaterThan(0)
  })
})

describe('WorkflowVizDag 停止叠加（D9 着色映射）', () => {
  it('run 运行中：无停止叠加（在途节点正常蓝脉冲）', () => {
    const wrapper = mountDag(sampleDag(), { runStatus: 'running' })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBeUndefined()
  })

  it('interrupted 暂停态：在途节点叠加中性暗（stopTone=neutral）', () => {
    const wrapper = mountDag(sampleDag(), { runStatus: 'interrupted' })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBe('neutral')
  })

  it('done + failed/time_limited 终局：叠加失败色系（stopTone=failed）', () => {
    const failed = mountDag(sampleDag(), { runStatus: 'done', runOutcome: 'failed' })
    expect(failed.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBe('failed')
    const limited = mountDag(sampleDag(), { runStatus: 'done', runOutcome: 'time_limited' })
    expect(limited.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBe('failed')
  })

  it('done + cancelled 终局：取消色中性暗（stopTone=neutral，tray-tone 同语义同色先例）', () => {
    const wrapper = mountDag(sampleDag(), { runStatus: 'done', runOutcome: 'cancelled' })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBe('neutral')
  })
})

describe('WorkflowVizDag 节点级渲染边界与零节点形态', () => {
  it('单节点 SVG 生成失败 = 节点占位错误态，其余节点不受影响', async () => {
    const bad = sampleDag()
    // 模拟渲染违约节点：id 空串触发节点组件 fail-fast 守卫（布局产物正常不可达；
    // 防御路径 = WorkflowVizDagNodeGuard 捕获后渲染占位错误态）
    bad.nodes = [...bad.nodes, node({ id: '' })]
    const wrapper = mountDag(bad)
    // 占位错误态出现（failed 置位 → 重渲染在下一 tick）
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="wfvz-dag-node-error"]').exists()).toBe(true)
    // 其余节点正常挂载（故障隔离粒度 = 单节点）
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').exists()).toBe(true)
  })

  it('零节点 run（纯门禁脚本）：居中摘要提示「本脚本无 agent 调用点」', () => {
    const empty: WorkflowDag = { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] }
    const wrapper = mountDag(empty)
    expect(wrapper.find('[data-testid="wfvz-dag-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-empty"]').text()).toContain('本脚本无 agent 调用点')
  })

  it('切换 run（dag 引用变化）后画布可用（单例切内容的画布面）', async () => {
    const wrapper = mountDag(sampleDag())
    const next: WorkflowDag = {
      phases: [{ name: 'solo', order: 0 }],
      nodes: [node({ id: 'solo', phase: 'solo' })],
      edges: [],
      parallelGroups: [],
      loops: [],
    }
    await wrapper.setProps({ dag: next })
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-solo"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-node-solo"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').exists()).toBe(false)
  })
})

describe('WorkflowVizDag 视口水平居中（workflow-overlay-refine D1 / V1-wf③ 上区内容水平对中）', () => {
  it('无布局环境（jsdom clientWidth 缺失）初始 tx 贴 0，渲染不破坏', () => {
    const wrapper = mountDag()
    expect(wrapper.find('[data-testid="wfvz-dag-viewport"]').attributes('transform')).toBe('translate(0,0) scale(1)')
  })

  it('run 切换重置：tx = (容器宽−画布宽)/2（k 恒 1 无 fit，画布宽 180 = 节点 156 + 分区左右内边距 24）', async () => {
    const wrapper = mountDag()
    const svg = wrapper.find('[data-testid="wfvz-dag-svg"]').element
    Object.defineProperty(svg, 'clientWidth', { value: 1000 })
    const solo: WorkflowDag = {
      phases: [{ name: 'solo', order: 0 }],
      nodes: [node({ id: 'solo', phase: 'solo' })],
      edges: [],
      parallelGroups: [],
      loops: [],
    }
    await wrapper.setProps({ dag: solo })
    // 单分区画布宽 180 → tx = (1000−180)/2 = 410；此前用户 pan 过也在重置中回到居中
    expect(wrapper.find('[data-testid="wfvz-dag-viewport"]').attributes('transform')).toBe('translate(410,0) scale(1)')
  })

  it('画布宽于容器时 tx 贴 0（不产生负偏移把内容推出左缘）', async () => {
    const wrapper = mountDag()
    const svg = wrapper.find('[data-testid="wfvz-dag-svg"]').element
    Object.defineProperty(svg, 'clientWidth', { value: 100 })
    const next: WorkflowDag = {
      phases: [{ name: 'wide', order: 0 }, { name: 'tail', order: 1 }],
      nodes: [node({ id: 'w0', phase: 'wide' }), node({ id: 't0', phase: 'tail' })],
      edges: [],
      parallelGroups: [],
      loops: [],
    }
    await wrapper.setProps({ dag: next })
    // 两分区画布宽 392 > 容器 100 → tx = max(0, (100−392)/2) = 0
    expect(wrapper.find('[data-testid="wfvz-dag-viewport"]').attributes('transform')).toBe('translate(0,0) scale(1)')
  })
})

describe('WorkflowVizDag 画布视觉（workflow-overlay-refine D3）', () => {
  it('V1-wf③ 标签/节点分层：分区标签 2xs/font-medium/0.03em 字距、节点名 3xs（字号档 class 断言）', () => {
    const wrapper = mountDag()
    const label = wrapper.find('[data-testid="wfvz-dag-cluster-gate"] text')
    expect(label.classes()).toContain('text-[length:var(--text-2xs)]')
    expect(label.classes()).toContain('font-medium')
    expect(label.classes()).toContain('tracking-[0.03em]')
    // 节点名与分区标签拉开半档（节点名恒 3xs——分层的另一侧基准）
    const nodeName = wrapper.find('[data-testid="wfvz-dag-node-n-gate"] text')
    expect(nodeName.classes()).toContain('text-[length:var(--text-3xs)]')
  })

  it('分区虚线描边升 border-strong 级 + dasharray 保留（弱化「面板感」、强化「分组感」）', () => {
    const wrapper = mountDag()
    const rect = wrapper.find('[data-testid="wfvz-dag-cluster-gate"] rect')
    expect(rect.classes()).toContain('stroke-border-strong')
    expect(rect.classes()).toContain('[stroke-dasharray:5_4]')
    // 描边升档不回退既有 hairline
    expect(rect.classes()).not.toContain('stroke-border-hairline')
  })
})
