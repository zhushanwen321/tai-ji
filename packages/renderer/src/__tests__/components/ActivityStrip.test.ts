/**
 * ActivityStrip subagentThinking 扩展条件测试（u3-thinking / subagent-drawer-blank §6.3）。
 *
 * 直接 mount ActivityStrip，chat store mock 三个读口（sessionPhase / isCompacting /
 * getCompactingReason——组件消费面全集中于此）。验证：
 * - subagentThinking=false（可选 prop 默认）→ 无 thinking 行
 * - subagentThinking=true → thinking 行出现（文案复用 dispatching key「思考中…」）
 * - subagentThinking=true 且 turn=dispatching → 仍只有一行（条件合并不重复渲染）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/ActivityStrip.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ActivityStrip from '@/components/panel/message-stream/ActivityStrip.vue'

// chat store mock：ActivityStrip 消费面仅三读口（occupancy 投影 turn / compacting / reason）
const chatState = vi.hoisted(() => ({
  turn: 'idle' as 'idle' | 'dispatching' | 'generating' | 'settling',
  compacting: false,
  reason: undefined as string | undefined,
}))
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    sessionPhase: () => ({ turn: chatState.turn, compacting: chatState.compacting, bash: false }),
    isCompacting: () => chatState.compacting,
    getCompactingReason: () => chatState.reason,
  }),
}))

// happy-dom 不提供真实 ResizeObserver 布局测量（useConstantHeightAssert dev 断言需要）
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function mountStrip(props: Record<string, unknown> = {}) {
  return mount(ActivityStrip, {
    props: { sessionId: 's-strip-test', ...props },
    attachTo: document.body,
  })
}

describe('ActivityStrip subagentThinking 行渲染（u3-thinking / §6.3）', () => {
  beforeEach(() => {
    chatState.turn = 'idle'
    chatState.compacting = false
    chatState.reason = undefined
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  })

  it('subagentThinking=false（默认）→ 无 thinking 行', () => {
    const wrapper = mountStrip()
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('subagentThinking=true → thinking 行出现（文案复用 dispatching key「思考中…」）', () => {
    const wrapper = mountStrip({ subagentThinking: true })
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="activity-strip-text-thinking"]').text()).toContain('思考中')
    wrapper.unmount()
  })

  it('subagentThinking=true 且 turn=dispatching → 仍只有一行（条件合并不重复渲染）', () => {
    chatState.turn = 'dispatching'
    const wrapper = mountStrip({ subagentThinking: true })
    const rows = wrapper.findAll('[data-testid^="activity-strip-row-"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].attributes('data-testid')).toBe('activity-strip-row-thinking')
    wrapper.unmount()
  })
})
