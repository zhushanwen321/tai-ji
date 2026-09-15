/**
 * InboundFrameDroppedNotice.vue 组件测试（crash-forensics-and-watchdog §3.3 D8 / §4 A6）。
 *
 * 三视角 DOM 断言（TEST-STRATEGY §3，CrashRecoveredBar.test.ts 同型）：
 * - 终止阀生效 session：会话级静态提示可见（role=alert + 标题 + 恢复指引文案），
 *   提示文案明示「切走再切回」这一唯一恢复动作
 * - 单 session 作用域：tripped 集合不含本 session（或为空）→ 不渲染（其余 session 不连坐）
 *
 * mock 策略：本组件是纯投影消费方（状态源 = core ws-client 终止阀经 useInboundFrameGuard
 * 投影），故 mock 状态源让断言聚焦「渲染契约」；投影逻辑与恢复编排由
 * composables/__tests__/useInboundFrameGuard.test.ts 覆盖。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/ui/__tests__/InboundFrameDroppedNotice.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const stateMock = vi.hoisted(() => ({
  trippedSessionIds: { value: new Set<string>() },
}))

vi.mock('@/composables/useInboundFrameGuard', () => ({
  useInboundFrameGuardState: () => ({ trippedSessionIds: stateMock.trippedSessionIds }),
}))

import InboundFrameDroppedNotice from '../InboundFrameDroppedNotice.vue'

describe('InboundFrameDroppedNotice 入站丢帧终止阀静态提示（D8 / A6）', () => {
  beforeEach(() => {
    stateMock.trippedSessionIds.value = new Set<string>()
  })

  it('终止阀生效 session：提示可见（role=alert + 标题 + 恢复指引）且标题含会话暂停语义', () => {
    stateMock.trippedSessionIds.value = new Set(['s1'])
    const wrapper = mount(InboundFrameDroppedNotice, { props: { sessionId: 's1' } })

    const notice = wrapper.find('[data-testid="inbound-frame-dropped-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.attributes('role')).toBe('alert') // 静态错误页形态：响亮降级
    expect(wrapper.find('[data-testid="inbound-frame-dropped-title"]').text()).toBe('本会话数据流已暂停')
    // 恢复指引必须指向唯一恢复动作（切走再切回），不得给「对端自行恢复」的隐性承诺
    expect(wrapper.find('[data-testid="inbound-frame-dropped-hint"]').text()).toContain('切换')
    expect(wrapper.text()).toContain('再切回')
  })

  it('单 session 作用域：tripped 集合含别的 session → 本 session 不渲染（不连坐）', () => {
    stateMock.trippedSessionIds.value = new Set(['other'])
    const wrapper = mount(InboundFrameDroppedNotice, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
  })

  it('终止阀未生效（集合为空）→ 不渲染', () => {
    const wrapper = mount(InboundFrameDroppedNotice, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
  })
})
