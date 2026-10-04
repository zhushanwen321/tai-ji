// MobileChatHeader 组件测试（u13/A5：聊天头部模型/思考档只读标签——V11 聊天头面）。
//
// 行为面：会话在 sessionList 中时头部可见（modelId + thinkingLevel，与列表行同源同形）；
// thinkingLevel 缺失只显示 modelId；无匹配 summary 头部整体不渲染（无会话数据不占位）。
//
// app-runtime 模块级 mock：组件只消费 sessionList 一个导出，mock 工厂内建可写 ref，
// 测试经 testState 写入场景数据（隔离 core WS 依赖，测试禁触网络）。
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-chat-header.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { SessionSummary } from '@taiji/shared'

const testState = await vi.hoisted(async () => {
  const { ref } = await import('vue')
  return { list: ref<SessionSummary[]>([]) }
})

vi.mock('../shell/app-runtime', () => ({
  sessionList: testState.list,
}))

import MobileChatHeader from '../views/MobileChatHeader.vue'

function makeSummary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    modelId: 'test-model',
    tokenCount: 0,
    lastActiveAt: 0,
    ...overrides,
  }
}

function mountHeader(sessionId: string) {
  return mount(MobileChatHeader, { props: { sessionId } })
}

describe('MobileChatHeader 聊天头部模型标签（u13/A5）', () => {
  it('头部可见：modelId 与 thinkingLevel 同行呈现（V11 聊天头面）', () => {
    testState.list.value = [makeSummary({ id: 's-1', modelId: 'm-1', thinkingLevel: 'high' })]
    const wrapper = mountHeader('s-1')
    expect(wrapper.find('[data-testid="mobile-chat-header"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-chat-header-model"]').text()).toBe('m-1 · high')
    wrapper.unmount()
  })

  it('thinkingLevel 缺失：仅显示 modelId', () => {
    testState.list.value = [makeSummary({ id: 's-1', modelId: 'm-2' })]
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
})
