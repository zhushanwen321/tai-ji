/**
 * WorkflowVizOverlay 壳 + D10 Guard 测试（workflow-visualization U4；三视角）。
 *
 * - 使用者黑盒：三通道关闭（ESC / 右上关闭按钮 / 点遮罩统一走 close）、header
 *   状态 pill 文案（running / interrupted / 终局 outcome + errorCode）、DAG 不可得
 *   降级形态（原因码 + parse_failed 重试入口 + 按 phase 分组列表）——每条用例至少
 *   一个用户可见 DOM 断言；
 * - 构建者白盒：Guard 捕获路径（errorCaptured 测试形态——注入抛错子组件，断言
 *   fallback 事件 + slot 卸载 + 全局 errorHandler 零调用）；
 * - 观察者形态：role="dialog" / aria-modal / data-status 形态断言。
 *
 * 回落 drawer 的 openDrawerTab + openWorkflowInDrawer 接线归 U6（D10 动作序列在
 * 接线方）——本测试只断言壳/边界的事件契约。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/overlay/__tests__/workflow-viz-overlay.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import type { WorkflowDag, WorkflowRunRecord } from '@taiji/shared'
import WorkflowVizOverlay from '../WorkflowVizOverlay.vue'
import WorkflowVizOverlayGuard from '../WorkflowVizOverlayGuard.vue'
import type { WorkflowUnmatchedInstance } from '../../blueprint-match'
import type { WorkflowVizDagLoadError } from '../../overlay/types'

function run(partial: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'pr-lifecycle',
    slug: 'pr-lifecycle-7f3a',
    status: 'running',
    startedAt: '2026-10-02T00:00:00Z',
    agentCalls: [],
    stateFilePath: '',
    ...partial,
  }
}

const SAMPLE_DAG: WorkflowDag = {
  phases: [{ name: 'gate', order: 0 }],
  nodes: [{
    id: 'n1',
    kind: 'agent',
    templateName: 'preflight',
    matchPattern: '',
    phase: 'gate',
    line: 3,
  }],
  edges: [],
  parallelGroups: [],
  loops: [],
}

function mountOverlay(props: Record<string, unknown> = {}, errorHandler?: (err: unknown) => void): VueWrapper {
  return mount(WorkflowVizOverlay, {
    props: {
      open: true,
      run: run(),
      dag: null,
      dagError: null,
      ...props,
    },
    ...(errorHandler ? { global: { config: { errorHandler } } } : {}),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkflowVizOverlay 壳（黑盒 DOM）', () => {
  it('open=false 不渲染；open=true 渲染 dialog 形态（role/aria-modal 观察者形态）', () => {
    const closed = mountOverlay({ open: false })
    expect(closed.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    const opened = mountOverlay()
    const panel = opened.find('[data-testid="wfvz-overlay-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
  })

  it('header 可见：脚本名 + slug + 状态 pill + args 摘要 + 关闭按钮', () => {
    const wrapper = mountOverlay({ run: run({ argsSummary: 'base=main reviewers=4' }) })
    expect(wrapper.find('[data-testid="wfvz-overlay-header"]').text()).toContain('pr-lifecycle')
    expect(wrapper.find('[data-testid="wfvz-overlay-slug"]').text()).toBe('pr-lifecycle-7f3a')
    expect(wrapper.find('[data-testid="wfvz-overlay-args"]').text()).toContain('base=main')
    expect(wrapper.find('[data-testid="wfvz-overlay-close"]').exists()).toBe(true)
  })

  it('状态 pill：running → 「运行中」（data-status 形态）', () => {
    const wrapper = mountOverlay()
    const pill = wrapper.find('[data-testid="wfvz-overlay-run-pill"]')
    expect(pill.attributes('data-status')).toBe('running')
    expect(pill.text()).toContain('运行中')
  })

  it('状态 pill：interrupted → 「已中断（可续跑）」（tray 词源复用）', () => {
    const wrapper = mountOverlay({ run: run({ status: 'interrupted' }) })
    expect(wrapper.find('[data-testid="wfvz-overlay-run-pill"]').text()).toContain('已中断（可续跑）')
  })

  it('终局 pill：done+failed → shared 词表「失败」+ errorCode 摘要可见（D9 失败终态）', () => {
    const wrapper = mountOverlay({
      run: run({ status: 'done', outcome: 'failed', errorCode: 'schema_deterministic' }),
    })
    const pill = wrapper.find('[data-testid="wfvz-overlay-run-pill"]')
    expect(pill.text()).toContain('失败')
    expect(wrapper.find('[data-testid="wfvz-overlay-error-code"]').text()).toBe('schema_deterministic')
  })

  it('elapsedMs 提供时渲染已用时长槽（已派生输入透传）；缺省不渲染', () => {
    const withElapsed = mountOverlay({ elapsedMs: 65_000 })
    expect(withElapsed.find('[data-testid="wfvz-overlay-elapsed"]').text()).toContain('1m')
    const without = mountOverlay()
    expect(without.find('[data-testid="wfvz-overlay-elapsed"]').exists()).toBe(false)
  })

  it('三通道①：ESC 关闭（window keydown）', async () => {
    const wrapper = mountOverlay()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('三通道①守卫：IME 组合态 ESC 不关闭', async () => {
    const wrapper = mountOverlay()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('三通道②：右上关闭按钮点击 → close', async () => {
    const wrapper = mountOverlay()
    await wrapper.find('[data-testid="wfvz-overlay-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('三通道③：点遮罩（面板外区域）→ close；面板内点击不关', async () => {
    const wrapper = mountOverlay()
    await wrapper.find('[data-testid="wfvz-overlay"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    // 面板内点击被 @click.stop 吸收（冒泡被阻断且自身不触发遮罩 close）
    const second = mountOverlay()
    await second.find('[data-testid="wfvz-overlay-panel"]').trigger('click')
    expect(second.emitted('close')).toBeUndefined()
  })

  it('DAG 就绪：画布渲染；画布点击 select 透传（壳转发）', async () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG, nodeStates: { n1: 'done' } })
    expect(wrapper.find('[data-testid="wfvz-dag-svg"]').exists()).toBe(true)
    // agent 节点点击 → 壳转发 select
    await wrapper.find('[data-testid="wfvz-dag-node-n1"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-node-n1"]').trigger('pointerup')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({
      semantic: 'agent',
      nodeId: 'n1',
      templateName: 'preflight',
      phase: 'gate',
    })
  })

  it('右栏实况面板 slot 透传（U5 面板填充位）', () => {
    const wrapper = mount(WorkflowVizOverlay, {
      props: { open: true, run: run(), dag: null, dagError: null },
      slots: { default: h('div', { 'data-testid': 'wfvz-test-slot-probe' }, 'panel') },
    })
    expect(wrapper.find('[data-testid="wfvz-test-slot-probe"]').exists()).toBe(true)
  })
})

describe('WorkflowVizOverlay 未匹配实例分组（D2⑥ 展示面，黑盒 DOM）', () => {
  const unmatched: WorkflowUnmatchedInstance[] = [
    { call: { id: 0, agent: 'orphan-agent', phase: 'gate', status: 'done' }, hitCount: 0, ambiguous: false },
    { call: { id: 1, agent: 'reviewer-x', phase: 'review', status: 'running' }, hitCount: 2, ambiguous: true },
  ]

  it('DAG 就绪 + 未匹配非空：分组可见——phase 组标题 + agent 名 + 歧义/零命中标注随行', () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG, unmatched })
    expect(wrapper.find('[data-testid="wfvz-overlay-unmatched"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-unmatched-group-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-unmatched-group-review"]').exists()).toBe(true)
    const items = wrapper.findAll('[data-testid="wfvz-overlay-unmatched-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].attributes('data-ambiguous')).toBe('false')
    expect(items[0].text()).toContain('orphan-agent')
    expect(items[0].text()).toContain('未命中任何调用点')
    expect(items[1].attributes('data-ambiguous')).toBe('true')
    expect(items[1].attributes('data-hit-count')).toBe('2')
    expect(items[1].text()).toContain('reviewer-x')
    expect(items[1].text()).toContain('歧义（命中 2 个调用点）')
  })

  it('未匹配空/缺省：分组零渲染 + 三态互斥（画布就绪时解析中占位不渲染）', () => {
    const empty = mountOverlay({ dag: SAMPLE_DAG, unmatched: [] })
    expect(empty.find('[data-testid="wfvz-overlay-unmatched"]').exists()).toBe(false)
    const absent = mountOverlay({ dag: SAMPLE_DAG })
    expect(absent.find('[data-testid="wfvz-overlay-unmatched"]').exists()).toBe(false)
    // U7 回归断言：dag 就绪 + 无未匹配实例时，左栏不得同时渲染「解析中」占位
    expect(empty.find('[data-testid="wfvz-overlay-dag-loading"]').exists()).toBe(false)
    expect(absent.find('[data-testid="wfvz-overlay-dag-loading"]').exists()).toBe(false)
  })

  it('phase 缺失实例归「未归属 phase」组（不猜缺省分区名）', () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG, unmatched: [
      { call: { id: 2, agent: 'no-phase-agent', status: 'pending' }, hitCount: 0, ambiguous: false },
    ] })
    const group = wrapper.find('[data-testid="wfvz-overlay-unmatched-group-unknown"]')
    expect(group.exists()).toBe(true)
    expect(group.text()).toContain('未归属 phase')
    expect(group.text()).toContain('no-phase-agent')
  })

  it('DAG 不可得时不渲染未匹配分组（分组属 DAG 就绪分支的展示面）', () => {
    const wrapper = mountOverlay({ dagError: { code: 'parse_failed', message: 'bad' }, unmatched })
    expect(wrapper.find('[data-testid="wfvz-overlay-unmatched"]').exists()).toBe(false)
  })
})

describe('WorkflowVizOverlay DAG 不可得降级（黑盒 DOM）', () => {
  it('record_not_found：静态指引文案 + 原因码可见、无重试按钮（重试恒同）', () => {
    const dagError: WorkflowVizDagLoadError = { code: 'record_not_found', message: 'no record' }
    const wrapper = mountOverlay({ dagError })
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-fallback"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-error"]').text()).toContain('无运行记录')
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-error-code"]').text()).toBe('record_not_found')
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-retry"]').exists()).toBe(false)
  })

  it('parse_failed：降级列表 + 「重试解析」入口（点击上抛 retry-dag）', async () => {
    const dagError: WorkflowVizDagLoadError = { code: 'parse_failed', message: 'unsupported syntax' }
    const wrapper = mountOverlay({ dagError, run: run({ agentCalls: [
      { id: 0, agent: 'reviewer-biz', phase: 'review', status: 'done' },
      { id: 1, agent: 'preflight', status: 'done' },
    ] }) })
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-error"]').text()).toContain('DAG 解析失败')
    // 降级列表按 phase 分组渲染（有显式 phase 显示分组 header）
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-fallback-group-review"]').exists()).toBe(true)
    const calls = wrapper.findAll('[data-testid="wfvz-overlay-dag-fallback-call"]')
    expect(calls).toHaveLength(2)
    // 重试入口
    const retry = wrapper.find('[data-testid="wfvz-overlay-dag-retry"]')
    expect(retry.exists()).toBe(true)
    await retry.trigger('click')
    expect(wrapper.emitted('retry-dag')).toHaveLength(1)
  })

  it('channel（RPC 通道错误归一形态）：通用获取失败文案', () => {
    const wrapper = mountOverlay({ dagError: { code: 'channel', message: 'rpc failed' } })
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-error"]').text()).toContain('获取 workflow 结构失败')
  })
})

describe('WorkflowVizOverlayGuard（D10 捕获路径，构建者白盒）', () => {
  const ThrowingChild = defineComponent({
    name: 'ThrowingChild',
    setup() {
      throw new Error('overlay mount boom')
    },
    render() {
      return h('div')
    },
  })

  /**
   * 端到端捕获形态：Guard 包住「壳 + 抛错子组件」——实况面板 slot 内子页抛错
   * （设计 §3.1 失败路径「overlay 装载异常 → 回落 drawer」的真实来源形态之一）
   * 由 Guard 捕获，壳自身未设 errorCaptured 不拦截。
   */
  function mountGuardWithOverlay(errorHandler?: (err: unknown) => void): VueWrapper {
    return mount(WorkflowVizOverlayGuard, {
      slots: {
        default: () => [
          h(WorkflowVizOverlay, { open: true, run: run(), dag: null, dagError: null }),
          h(ThrowingChild),
        ],
      },
      ...(errorHandler ? { global: { config: { errorHandler } } } : {}),
    })
  }

  function mountGuardOnly(errorHandler?: (err: unknown) => void): VueWrapper {
    return mount(WorkflowVizOverlayGuard, {
      slots: { default: h(ThrowingChild) },
      ...(errorHandler ? { global: { config: { errorHandler } } } : {}),
    })
  }

  it('overlay 树内子组件抛错 → fallback 事件发出（回落动作序列由接线方承接）', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mountGuardWithOverlay()
    expect(wrapper.emitted('fallback')).toHaveLength(1)
  })

  it('failed 后 overlay 树卸载（回落 drawer 时 overlay 随之消失，无占位 UI）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mountGuardWithOverlay()
    // failed 置位 → 重渲染在下一 tick
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
  })

  it('错误被边界拦截：全局 errorHandler 零调用（return false 阻断，不升级全局故障）', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const globalErrors: unknown[] = []
    mountGuardOnly((err) => globalErrors.push(err))
    expect(globalErrors).toHaveLength(0)
  })
})
