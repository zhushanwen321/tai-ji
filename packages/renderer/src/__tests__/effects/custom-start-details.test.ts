/**
 * customStart details 保留单测（审计项 A）。
 *
 * 验证：extension 通过 message.customMessage/customStart 推送的 `__gui__` 结构化
 * 渲染数据，经 customStart effect 构造的 system Message 时，details 字段被原样保留，
 * 前端可据此路由到 GuiComponentRenderer。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/custom-start-details.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'

describe('customStart details 保留（审计项 A）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('customStart 带 details.__gui__ → msg.details 原样保留', () => {
    const store = useChatStore()
    const guiDetails = {
      __gui__: {
        v: 1,
        component: { type: 'stats-line', props: { items: [] } },
      },
    }
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'gui-component',
        content: 'GUI 组件渲染',
        details: guiDetails,
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].customType).toBe('gui-component')
    // 关键断言：details 字段被保留（含 __gui__）
    expect(msgs[0].details).toBeDefined()
    expect(msgs[0].details).toEqual(guiDetails)
    expect((msgs[0].details as Record<string, unknown>).__gui__).toBeDefined()
  })

  it('customStart 无 details → msg.details 无 __gui__（不触发 GUI 路由）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'plain',
        content: '无 details',
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    // readRecord 缺省返回 {}，details 为空对象，不携带 __gui__，前端不会误路由
    const details = msgs[0].details as Record<string, unknown> | undefined
    expect(details?.__gui__).toBeUndefined()
  })

  it('customStart subagent-bg-notify 保留原始 details（bgNotify 字段已删，§3.3.6）', () => {
    const store = useChatStore()
    const bgDetails = {
      id: 'job-1',
      status: 'done',
      agent: 'coder',
      model: 'claude-4.5',
      result: 'Done.',
      startedAt: 1000,
      endedAt: 13000,
    }
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'subagent-bg-notify',
        content: 'Subagent done.',
        details: bgDetails,
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    // details 原始字段被保留
    expect(msgs[0].details).toEqual(bgDetails)
  })
})
