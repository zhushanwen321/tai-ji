/**
 * WorkflowVizGantt 纯展示组件测试（workflow-visualization U4；三视角）。
 *
 * - 构建者白盒：gantt-view 纯函数（行分组 / 退避间隙推导 / 时间域 / 百分比映射）；
 * - 使用者黑盒：横条 / 色带 / 斜纹 / 失败红段 / 退避琥珀段 / 游标的用户可见渲染
 *   （每条用例至少一个用户可见 DOM 断言）；
 * - 观察者形态：data-state / data-frozen / data-script-only / emptyReplay 不绘制。
 *
 * 分段数据全部由测试 fixture 直接构造（u2 冻结的 WorkflowGanttSegments 形态）——
 * 分段派生本身归 u5 gantt-segments.ts（设计 §3.1-2 语义规则①②），本组件零派生。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/gantt/__tests__/workflow-viz-gantt.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { WorkflowGanttSegments } from '@taiji/shared'
import WorkflowVizGantt from '../WorkflowVizGantt.vue'
import { buildGanttRows, computeGanttDomain, toPercent } from '../gantt-view'

const T0 = 1_700_000_000_000

function segments(partial: Partial<WorkflowGanttSegments> = {}): WorkflowGanttSegments {
  return {
    attemptSegments: [],
    phaseBands: [],
    phaseCards: [],
    ...partial,
  }
}

describe('buildGanttRows 行分组（白盒）', () => {
  it('按 taskIndex 分组、行内按 generation/attempt 升序、行按 taskIndex 升序', () => {
    const rows = buildGanttRows([
      { taskIndex: 2, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
      { taskIndex: 1, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 50, state: 'done' },
      { taskIndex: 2, generation: 1, attempt: 2, startTs: T0 + 160, endTs: T0 + 200, state: 'done' },
    ])
    expect(rows.map((r) => r.taskIndex)).toEqual([1, 2])
    expect(rows[1].segments.map((s) => s.attempt)).toEqual([1, 2])
  })

  it('同代际相邻段间隙 → 退避琥珀段（宽 = backoffMs）', () => {
    const rows = buildGanttRows([
      { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
      // attempt 2 起点 = retrying.ts：退避间隙 = T0+100 → T0+150（backoff 50ms）
      { taskIndex: 0, generation: 1, attempt: 2, startTs: T0 + 150, endTs: T0 + 300, state: 'done' },
    ])
    expect(rows[0].backoffGaps).toEqual([{ generation: 1, startTs: T0 + 100, endTs: T0 + 150 }])
  })

  it('跨代际间隙是中断/崩溃空隙：不产退避段（段不相连、空隙可见）', () => {
    const rows = buildGanttRows([
      { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
      { taskIndex: 0, generation: 2, attempt: 1, startTs: T0 + 5_000, endTs: T0 + 6_000, state: 'done' },
    ])
    expect(rows[0].backoffGaps).toEqual([])
  })
})

describe('computeGanttDomain 时间域（白盒）', () => {
  it('全部段起止并集 + 2% 边距；游标参与域（运行中游标可超最后事件）', () => {
    const d = computeGanttDomain({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'done' },
      ],
      phaseBands: [{ phase: 'p', startTs: T0 - 200, endTs: T0 + 800, emptyReplay: false, state: 'settled' }],
    }, T0 + 2_000)
    expect(d).not.toBeNull()
    expect(d!.startTs).toBeLessThan(T0 - 200)
    expect(d!.endTs).toBeGreaterThan(T0 + 2_000)
  })

  it('分段全空且无游标 → null（调用方出空态）', () => {
    expect(computeGanttDomain({ attemptSegments: [], phaseBands: [] })).toBeNull()
  })

  it('toPercent：域内线性映射、越界钳制', () => {
    const d = { startTs: 0, endTs: 100 }
    expect(toPercent(50, d)).toBe(50)
    expect(toPercent(-10, d)).toBe(0)
    expect(toPercent(110, d)).toBe(100)
  })
})

// ── 组件黑盒 ──

function mountGantt(segs: WorkflowGanttSegments, props: Record<string, unknown> = {}) {
  return mount(WorkflowVizGantt, { props: { segments: segs, ...props } })
}

describe('WorkflowVizGantt 组件（黑盒 DOM）', () => {
  it('call 横条按 attempt 分段渲染（行 + 段 + 段状态用户可见）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
        { taskIndex: 0, generation: 1, attempt: 2, startTs: T0 + 150, endTs: T0 + 300, state: 'done' },
      ],
    }))
    expect(wrapper.find('[data-testid="wfvz-gantt-row-0"]').exists()).toBe(true)
    const segs = wrapper.findAll('[data-testid="wfvz-gantt-seg"]')
    expect(segs).toHaveLength(2)
    expect(segs[0].attributes('data-attempt')).toBe('1')
    expect(segs[0].attributes('data-state')).toBe('failed')
    expect(segs[1].attributes('data-state')).toBe('done')
    // 段 title 用户可见（attempt 词 + 状态词）
    expect(segs[1].attributes('title')).toContain('第 2 次尝试')
  })

  it('退避琥珀段渲染（同代际相邻 attempt 间隙）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
        { taskIndex: 0, generation: 1, attempt: 2, startTs: T0 + 150, endTs: T0 + 300, state: 'done' },
      ],
    }))
    const backoff = wrapper.find('[data-testid="wfvz-gantt-backoff"]')
    expect(backoff.exists()).toBe(true)
    expect(backoff.attributes('data-generation')).toBe('1')
    expect(backoff.attributes('title')).toContain('退避重试等待')
  })

  it('跨代际中断空隙不产退避段（空隙保留可见）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
        { taskIndex: 0, generation: 2, attempt: 1, startTs: T0 + 5_000, endTs: T0 + 6_000, state: 'done' },
      ],
    }))
    expect(wrapper.find('[data-testid="wfvz-gantt-backoff"]').exists()).toBe(false)
  })

  it('phase 色带渲染；重放空段（emptyReplay）不绘制', () => {
    const wrapper = mountGantt(segments({
      phaseBands: [
        { phase: 'real', startTs: T0, endTs: T0 + 500, emptyReplay: false, state: 'settled' },
        { phase: 'ghost', startTs: T0 + 600, endTs: T0 + 700, emptyReplay: true, state: 'settled' },
      ],
    }))
    expect(wrapper.find('[data-testid="wfvz-gantt-band-real"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-gantt-band-ghost"]').exists()).toBe(false)
  })

  it('纯脚本 phase 色带带斜纹标注（scriptOnly → data-script-only）', () => {
    const wrapper = mountGantt(segments({
      phaseBands: [{ phase: 'gate', startTs: T0, endTs: T0 + 500, emptyReplay: false, state: 'settled' }],
      phaseCards: [{ phase: 'gate', startTs: T0, endTs: T0 + 500, turnCount: 1, state: 'settled', scriptOnly: true }],
    }))
    const band = wrapper.find('[data-testid="wfvz-gantt-band-gate"]')
    expect(band.attributes('data-script-only')).toBe('true')
  })

  it('运行中游标随 nowMs 推进（nowMs 参与时间域）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'running' },
      ],
    }), { runStatus: 'running', nowMs: T0 + 2_000 })
    const cursor = wrapper.find('[data-testid="wfvz-gantt-cursor"]')
    expect(cursor.exists()).toBe(true)
    expect(cursor.attributes('data-frozen')).toBeUndefined()
    // 运行中段带全局 keyframes 脉冲类（style.css wfvz-gantt-pulse）；未停止（无 data-stopped）
    const seg = wrapper.find('[data-testid="wfvz-gantt-seg"]')
    expect(seg.classes().join(' ')).toContain('wfvz-gantt-pulse')
    expect(seg.attributes('data-stopped')).toBeUndefined()
  })

  it('run 停止（interrupted）：游标冻结于最后事件 ts（data-frozen）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'running' },
      ],
    }), { runStatus: 'interrupted', nowMs: T0 + 999_999 })
    const cursor = wrapper.find('[data-testid="wfvz-gantt-cursor"]')
    expect(cursor.attributes('data-frozen')).toBe('true')
    // 冻结位置 = 最后事件 ts（T0+1000），与注入的 nowMs 无关——停走语义。
    // 域 = [T0, T0+1000] 外扩 2%：pct(T0+1000) = 1020/1040 ≈ 98.08
    expect(parseFloat(cursor.element.style.left)).toBeCloseTo(98.08, 0)
  })

  it('run 停止（done+failed 终局）：未收束段不脉冲、着色失败色系（D9 停止着色）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'running' },
      ],
    }), { runStatus: 'done', runOutcome: 'failed' })
    const seg = wrapper.find('[data-testid="wfvz-gantt-seg"]')
    expect(seg.attributes('data-stopped')).toBe('true')
    // 失败色系着色（bg-danger）且不脉冲（无 wfvz-gantt-pulse 动画类）
    expect(seg.classes().join(' ')).toContain('bg-danger')
    expect(seg.classes().join(' ')).not.toContain('wfvz-gantt-pulse')
  })

  it('run 停止（done+cancelled 终局）：未收束段着色中性暗（tray-tone 同语义同色）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'running' },
      ],
    }), { runStatus: 'done', runOutcome: 'cancelled' })
    const seg = wrapper.find('[data-testid="wfvz-gantt-seg"]')
    expect(seg.classes().join(' ')).toContain('bg-neutral-dim')
    expect(seg.attributes('data-stopped')).toBe('true')
  })

  it('callLabels 提供时行标签显示 agent 名（用户可见），缺省显示 #taskIndex', () => {
    const segs = segments({
      attemptSegments: [
        { taskIndex: 3, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'done' },
      ],
    })
    const withLabels = mountGantt(segs, { callLabels: { 3: 'reviewer-sec' } })
    expect(withLabels.find('[data-testid="wfvz-gantt-row-3"]').text()).toContain('reviewer-sec')
    const withoutLabels = mountGantt(segs)
    expect(withoutLabels.find('[data-testid="wfvz-gantt-row-3"]').text()).toContain('#3')
  })

  it('分段全空：空态文案（无时间线数据）', () => {
    const wrapper = mountGantt(segments())
    expect(wrapper.find('[data-testid="wfvz-gantt-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-gantt-empty"]').text()).toContain('暂无时间线数据')
  })

  it('时间轴刻度渲染（用户可见相对时长标签）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 60_000, state: 'done' },
      ],
    }))
    expect(wrapper.find('[data-testid="wfvz-gantt-axis"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="wfvz-gantt-tick"]').length).toBeGreaterThan(0)
  })
})
