/**
 * ContextUsageRing 测试 —— 指标聚合按钮的上下文容量环形进度图标（2026-10-19 用户裁决：
 * Gauge 拱形图标被误读为「被裁切的不完整圆」，改为底环透明恒在 + 占用弧三档语义色）。
 *
 * 三视角：
 * - 使用者黑盒：svg 渲染（data-testid）+ 底环恒在（轨道语义）；
 * - 观察者形态：三档语义色 class（success/warn/danger，阈值与 usageBarClass 同源）+
 *   占用弧 dasharray 与 percent 对应 + rotate(-90) 顶部起点 + 0% 不渲染弧；
 * - 构建者白盒：数据注入经真实 events.dispatchSession 通道推 context.update 帧
 *   （对齐 composer-metrics-aggregate 测试形态；getContext 恢复路径受控 pending）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/context-usage-ring.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { commandMock, transportApiCommandModule } from '../helpers/transport-command-mock'
import { apiFacadeWithSessionDomain } from '../helpers/session-context-mock'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { __clearInFlightContextFetchForTest } from '@/composables/features/model/useContextUsage'
import { pushSessionMsg } from '../helpers/gen-stats-mount'

import ContextUsageRing from '@/components/panel/ContextUsageRing.vue'

vi.mock('@taiji/core/transport/api', () => transportApiCommandModule())
const getContextMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
vi.mock('@/api', () => apiFacadeWithSessionDomain())

function mountRing(sessionId: string | undefined = 's1') {
  return mount(ContextUsageRing, { props: { sessionId }, attrs: { class: 'size-[16px] shrink-0' } })
}

/** 合法 context.update 帧工厂（0 帧哨兵要求三字段不可全 0） */
function usageFrame(percent: number): Parameters<typeof pushSessionMsg>[1] {
  return {
    type: 'context.update',
    payload: { sessionId: 's1', inputTokens: 1000, contextLimit: 10000, usagePercent: percent },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  commandMock.mockReset()
  commandMock.mockImplementation(() => new Promise(() => {}))
  getContextMock.mockReset()
  getContextMock.mockImplementation(() => new Promise(() => {}))
  __clearSessionCleanupRegistryForTest()
  __clearInFlightContextFetchForTest()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('无数据态（黑盒 DOM）', () => {
  it('只渲染透明底环（轨道恒在），无占用弧、无语义色（继承按钮文字色）', () => {
    const wrapper = mountRing()
    const svg = wrapper.find('[data-testid="context-usage-ring"]')
    expect(svg.exists()).toBe(true)
    // 底环 stroke-opacity 0.25（「背景偏透明」），弧未渲染
    const circles = wrapper.findAll('circle')
    expect(circles).toHaveLength(1)
    expect(circles[0].attributes('stroke-opacity')).toBe('0.25')
    // 无数据不加色 → class 无语义色调（继承 hover 提亮链）
    expect(svg.classes()).not.toContain('text-success')
    expect(svg.classes()).not.toContain('text-warn')
    expect(svg.classes()).not.toContain('text-danger')
  })
})

describe('占用弧三档（观察者形态 + 真实帧通道）', () => {
  it('50%：绿档 success，弧长 = 50% 周长，rotate(-90) 顶部起点，底环仍在', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(50))
    await wrapper.vm.$nextTick()

    const circles = wrapper.findAll('circle')
    expect(circles).toHaveLength(2)
    // 弧长 = 50% × 2πr（r=9；模板插值输出浮点全精度，期望值用同一表达式计算）
    const CIRCUMFERENCE = 2 * Math.PI * 9
    expect(circles[1].attributes('stroke-dasharray')).toBe(`${0.5 * CIRCUMFERENCE} ${CIRCUMFERENCE}`)
    expect(circles[1].attributes('transform')).toBe('rotate(-90 12 12)')
    expect(circles[1].attributes('stroke-linecap')).toBe('round')
    const svg = wrapper.find('[data-testid="context-usage-ring"]')
    expect(svg.classes()).toContain('text-success')
    expect(svg.classes()).not.toContain('text-warn')
    expect(svg.classes()).not.toContain('text-danger')
  })

  it('75%：黄档 warn（≥70 阈值档）', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(75))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="context-usage-ring"]').classes()).toContain('text-warn')
  })

  it('95%：红档 danger（>90 阈值档）', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(95))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="context-usage-ring"]').classes()).toContain('text-danger')
  })

  it('0%：有真值但不渲染弧（round cap 会画出假弧点），色归绿档', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(0))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('circle')).toHaveLength(1)
    expect(wrapper.find('[data-testid="context-usage-ring"]').classes()).toContain('text-success')
  })

  it('无值帧（字段缺省 = 合法无值，如 compact 后）：回中性无弧态', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(50))
    await wrapper.vm.$nextTick()
    pushSessionMsg('s1', { type: 'context.update', payload: { sessionId: 's1' } })
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('circle')).toHaveLength(1)
    expect(wrapper.find('[data-testid="context-usage-ring"]').classes()).not.toContain('text-success')
  })
})
