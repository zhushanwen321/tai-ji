/**
 * DAG 状态图例 + tone 同源测试（workflow-overlay-refine D4 / impl-plan u-wf-dag-visual；
 * 三视角）。图例挂载段在壳（WorkflowVizOverlay）内 DAG 区，故本文件挂整壳断言图例。
 *
 * - 使用者黑盒：图例六态词可见（现值词族 + skipped 新词）、停止叠加两档说明在容器
 *   title——每条用例至少一个用户可见 DOM 断言；
 * - 构建者白盒：V3-wf① 同源性断言——图例 dot 与 DAG 节点 dot 的 fill 类逐一相同
 *   （dotTone 单一事实源的构造性保证），图例 dot 不带脉冲类；
 * - 观察者形态：V3-wf⑤ 图例绝对定位层 pointer-events-none（不拦截节点点击与缩放
 *   手势——图例在场时节点点击上抛与 wheel 缩放照常生效）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/dag/__tests__/workflow-viz-dag-legend.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { WorkflowDag, WorkflowDagNode, WorkflowRunRecord } from '@taiji/shared'
import WorkflowVizOverlay from '../../overlay/WorkflowVizOverlay.vue'
import type { WorkflowVizDagNodeStatus } from '../types'

/** 六态词表序（图例条目序；tone 同源断言逐一覆盖）。 */
const STATES: WorkflowVizDagNodeStatus[] = ['pending', 'running', 'done', 'failed', 'retrying', 'skipped']

function stateNode(state: WorkflowVizDagNodeStatus, line: number): WorkflowDagNode {
  return { id: `n-${state}`, kind: 'agent', templateName: state, matchPattern: '', phase: 'p', line }
}

function stateDag(): WorkflowDag {
  return {
    phases: [{ name: 'p', order: 0 }],
    nodes: STATES.map((state, i) => stateNode(state, i + 1)),
    edges: [],
    parallelGroups: [],
    loops: [],
  }
}

function run(): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'pr-lifecycle',
    slug: 'pr-lifecycle-7f3a',
    status: 'running',
    startedAt: '2026-10-02T00:00:00Z',
    agentCalls: [],
    stateFilePath: '',
  }
}

function mountLegend(props: Record<string, unknown> = {}) {
  return mount(WorkflowVizOverlay, {
    props: {
      open: true,
      run: run(),
      dag: stateDag(),
      nodeStates: Object.fromEntries(STATES.map((state) => [`n-${state}`, state])),
      dagError: null,
      ...props,
    },
  })
}

describe('WorkflowVizDag 图例（workflow-overlay-refine D4）', () => {
  it('V3-wf① tone 同源：图例六态 dot 与 DAG 节点 dot 的 fill 类逐一相同，且图例 dot 无脉冲类', () => {
    const wrapper = mountLegend()
    for (const state of STATES) {
      const nodeDot = wrapper.find(`[data-testid="wfvz-dag-node-n-${state}"] circle`)
      const legendDot = wrapper.find(`[data-testid="wfvz-dag-legend-dot-${state}"]`)
      expect(legendDot.exists()).toBe(true)
      // 节点 dot 的全部 fill 类（静态基础类 + tone 类）都必须出现在图例 dot 上
      // ——「图例 = DAG 的图例」由类名同源构造性保证（dag/tone.ts dotTone 单源）
      const nodeFills = nodeDot.classes().filter((cls) => cls.startsWith('fill-['))
      expect(nodeFills.length).toBeGreaterThan(0)
      for (const cls of nodeFills) {
        expect(legendDot.classes()).toContain(cls)
      }
      // 脉冲是节点态、不是图例态：图例 dot 恒静态色
      expect(legendDot.classes().some((cls) => cls.includes('wfvz-node-pulse'))).toBe(false)
    }
  })

  it('V3-wf① 图例六态词可见（现值词族 + skipped 新词「已跳过」）', () => {
    const wrapper = mountLegend()
    const text = wrapper.find('[data-testid="wfvz-dag-legend"]').text()
    expect(text).toContain('等待中')
    expect(text).toContain('运行中')
    expect(text).toContain('完成')
    expect(text).toContain('失败')
    expect(text).toContain('重试中')
    expect(text).toContain('已跳过')
  })

  it('V3-wf② 停止叠加两档说明由图例容器 title 承载（neutral / failed 档位不入常驻图例）', () => {
    const wrapper = mountLegend()
    const title = wrapper.find('[data-testid="wfvz-dag-legend"]').attributes('title') ?? ''
    expect(title).toContain('已中断')
    expect(title).toContain('超时')
    // 两档说明在 title，不作为图例条目渲染（图例只含六态 dot）
    expect(wrapper.find('[data-testid="wfvz-dag-legend"]').findAll('circle')).toHaveLength(6)
  })

  it('V3-wf⑤ 图例绝对定位层不拦截交互：pointer-events-none + 节点点击上抛照常 + wheel 缩放照常', async () => {
    const wrapper = mountLegend()
    const legend = wrapper.find('[data-testid="wfvz-dag-legend"]')
    expect(legend.classes()).toContain('pointer-events-none')
    expect(legend.classes()).toContain('absolute')
    // 图例在场时节点点击照常上抛（agent 语义）
    const agentNode = wrapper.find('[data-testid="wfvz-dag-node-n-done"]')
    await agentNode.trigger('pointerdown')
    await agentNode.trigger('pointerup')
    const events = wrapper.emitted('select')
    expect(events).toHaveLength(1)
    expect(events?.[0]?.[0]).toEqual({ semantic: 'agent', nodeId: 'n-done', templateName: 'done', phase: 'p' })
    // 图例在场时 wheel 缩放照常生效（视口 transform 偏离初始 1:1）
    const viewport = wrapper.find('[data-testid="wfvz-dag-viewport"]')
    expect(viewport.attributes('transform')).toContain('scale(1)')
    await wrapper.find('[data-testid="wfvz-dag-svg"]').trigger('wheel', { deltaY: -240 })
    expect(viewport.attributes('transform')).not.toContain('scale(1)')
  })

  it('图例仅随 DAG 画布在场：DAG 不可得降级形态（dagError）无图例', () => {
    const wrapper = mountLegend({ dag: null, dagError: { code: 'record_not_found', message: 'no record' } })
    expect(wrapper.find('[data-testid="wfvz-dag-legend"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-fallback"]').exists()).toBe(true)
  })
})
