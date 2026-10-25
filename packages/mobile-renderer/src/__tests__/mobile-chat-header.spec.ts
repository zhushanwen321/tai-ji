// MobileChatHeader 组件测试（u13/A5：聊天头部模型/思考档只读标签——V11 聊天头面）。
//
// 行为范围：会话在 sessionList 中且状态层有 modelId 时头部可见（modelId + thinkingLevel，
// 与列表行同源同形）；thinkingLevel 缺失只显示 modelId；无匹配 summary / 状态层未观测 →
// 头部整体不渲染（显式未知，不占位、不回退列表种子字段）。
//
// app-runtime 模块级 mock：组件消费 sessionList + liveStateOf 两个导出，mock 工厂内建可写
// ref 与 spy，测试经 testState 写入场景数据（隔离 core WS 依赖，测试禁触网络）。
// [W1 会话架构四层分离] 模型/思考档权威 = 状态层（liveStateOf），sessionList 只用于确认
// 会话存在。
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-chat-header.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { SessionSummary } from '@taiji/shared'

const testState = await vi.hoisted(async () => {
  const { ref } = await import('vue')
  const { vi: hoistedVi } = await import('vitest')
  return {
    list: ref<SessionSummary[]>([]),
    liveStateOf: hoistedVi.fn((_id: string) => undefined as { modelId?: string; thinkingLevel?: string } | undefined),
  }
})

vi.mock('../shell/app-runtime', () => ({
  sessionList: testState.list,
  liveStateOf: testState.liveStateOf,
}))

import MobileChatHeader from '../views/MobileChatHeader.vue'

function makeSummary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    lastActiveAt: 0,
    ...overrides,
  }
}

function mountHeader(sessionId: string) {
  return mount(MobileChatHeader, { props: { sessionId } })
}

describe('MobileChatHeader 聊天头部模型标签（u13/A5）', () => {
  beforeEach(() => {
    testState.liveStateOf.mockReset()
    testState.liveStateOf.mockReturnValue(undefined)
  })

  it('头部可见：状态层 modelId 与 thinkingLevel 同行呈现（V11 聊天头面）', () => {
    testState.list.value = [makeSummary({ id: 's-1' })]
    testState.liveStateOf.mockImplementation((id: string) => (id === 's-1' ? { modelId: 'm-1', thinkingLevel: 'high' } : undefined))
    const wrapper = mountHeader('s-1')
    expect(wrapper.find('[data-testid="mobile-chat-header"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-chat-header-model"]').text()).toBe('m-1 · high')
    wrapper.unmount()
  })

  it('thinkingLevel 缺失：仅显示 modelId', () => {
    testState.list.value = [makeSummary({ id: 's-1' })]
    testState.liveStateOf.mockImplementation((id: string) => (id === 's-1' ? { modelId: 'm-2' } : undefined))
    const wrapper = mountHeader('s-1')
    expect(wrapper.get('[data-testid="mobile-chat-header-model"]').text()).toBe('m-2')
    wrapper.unmount()
  })

  it('sessionList 无匹配会话：头部不渲染', () => {
    testState.list.value = [makeSummary({ id: 's-1' })]
    const wrapper = mountHeader('s-other')
    expect(wrapper.find('[data-testid="mobile-chat-header"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('[W1] 状态层未观测：显式未知，头部不渲染（不回退 SessionSummary 种子字段）', () => {
    // W3：SessionSummary 种子字段已删（三状态字段退役），「显式未知」用例不再给种子
    testState.list.value = [makeSummary({ id: 's-1' })]
    const wrapper = mountHeader('s-1')
    expect(wrapper.find('[data-testid="mobile-chat-header"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
