/**
 * ContextCapacityCard 纯读测试（W6 · Q1 修复 → context-consistency Phase 2.2 适配；
 * ui-optimize 决策 6 起宿主 = hover 指标聚合页的容量卡）。
 *
 * [迁移来源] 原文件 context-capacity-popover.test.ts mount 平铺触发器
 * ContextCapacityPopover 断言按钮文字——决策 6 退役平铺形态（组件删除）后，分区纯读的
 * 用户可见断言宿主换为 ContextCapacityCard（数字唯一入口：hover 指标聚合页），断言锚从
 * 触发器按钮文字换为卡内 stats 文本。组件纯读语义不变：per-session 分区状态在
 * useContextUsage composable，组件只做 status → 显示映射（ok → 真值；no-value/unknown →
 * 「—」）。切回恢复腿 / in-flight / 哨兵行为由 use-context-usage.test.ts（层 1）与
 * context-usage-journeys.test.ts（层 3）覆盖。
 *
 * mock 策略：getContext RPC mock 为受控 pending deferred（不 resolve，分区保持 unknown
 * 过渡态，不污染「无值/在途」断言——mock 门面的固定真值 reply 会让「—」断言失效）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/context-capacity-card.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { apiFacadeWithSessionDomain } from '../helpers/session-context-mock'
import * as events from '@taiji/core/transport/api'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { __clearInFlightContextFetchForTest } from '@/composables/features/model/useContextUsage'
import type { ServerMessage } from '@taiji/shared'

import ContextCapacityCard from '@/components/panel/ContextCapacityCard.vue'

// ── mock 边界：getContext mock 为受控 pending（挂载触发的恢复腿不落地）；'@/api' 门面
//    session 域重指单源 helpers/session-context-mock（domain mock 一行内联 + 工厂转发）──
const getContextMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
vi.mock('@/api', () => apiFacadeWithSessionDomain())

beforeEach(() => {
  setActivePinia(createPinia())
  getContextMock.mockReset()
  getContextMock.mockImplementation(
    () => new Promise(() => {}) /* 永不 resolve：分区保持 unknown，本文件只测帧直驱显示 */,
  )
  __clearSessionCleanupRegistryForTest()
  __clearInFlightContextFetchForTest()
})

/** 模拟 runtime 推送 session 通道消息 */
function pushSessionMsg(sid: string, msg: ServerMessage): void {
  events.dispatchSession(sid, msg)
}

describe('ContextCapacityCard 纯读 useContextUsage 分区', () => {
  it('U29: 收到 context.update（含用量）→ 卡内显新用量（used「12K」+ 使用率「6%」）', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's1' },
    })
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'context.update',
      id: 'push-1',
      payload: {
        sessionId: 's1',
        usagePercent: 6,
        inputTokens: 12000,
        contextLimit: 200000,
      },
    })
    await flushPromises()

    // stats 格式：used 格「{used}K」+ usageRate 格「{percent}%」—— 12000 → 12K
    const text = wrapper.text()
    expect(text).toContain('12K')
    expect(text).toContain('6%')
  })

  it('U30: 其他 session 的 context.update 不影响当前卡', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's1' },
    })
    await flushPromises()

    pushSessionMsg('other-session', {
      type: 'context.update',
      id: 'push-2',
      payload: {
        sessionId: 'other-session',
        usagePercent: 99,
        inputTokens: 99000,
        contextLimit: 100000,
      },
    })
    await flushPromises()

    // 未收到目标 session 的推送，分区仍 unknown（status≠'ok'）→ 使用率显「—」
    expect(wrapper.text()).toContain('—')
  })

  it('U31: 无值占位帧（仅含 sessionId，D1 空 = 字段缺失）→ 分区 no-value，使用率保持「—」', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's2' },
    })
    await flushPromises()

    pushSessionMsg('s2', {
      type: 'context.update',
      id: 'push-3',
      payload: {
        sessionId: 's2',
      },
    })
    await flushPromises()

    // 无值占位帧（字段缺失）→ 分区写 no-value → 使用率显「—」（合法无值诚实显示）
    expect(wrapper.text()).toContain('—')
  })

  it('contextLimit=0 但 inputTokens>0（provider 未配 contextWindow）→ 显已用量，不显百分比', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's4' },
    })
    await flushPromises()

    pushSessionMsg('s4', {
      type: 'context.update',
      id: 'ctx-no-window',
      payload: { sessionId: 's4', usagePercent: 0, inputTokens: 69000, contextLimit: 0 },
    })
    await flushPromises()

    // hasPercent=false → usageRate 格显「—」；used 格照常「69K」
    const text = wrapper.text()
    expect(text).toContain('69K')
    // 无百分比：卡内不含 % 号
    expect(text).not.toContain('%')
  })

  it('context.update 仍正常工作（不回归）', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's3' },
    })
    await flushPromises()

    pushSessionMsg('s3', {
      type: 'context.update',
      id: 'ctx-1',
      payload: { sessionId: 's3', usagePercent: 50, inputTokens: 50000, contextLimit: 100000 },
    })
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('50K')
    expect(text).toContain('50%')
  })

  it('大数显 M（≥100万 token）', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's5' },
    })
    await flushPromises()

    pushSessionMsg('s5', {
      type: 'context.update',
      id: 'ctx-big',
      payload: { sessionId: 's5', usagePercent: 80, inputTokens: 1630000, contextLimit: 2000000 },
    })
    await flushPromises()

    // 1630000 → 1.6M
    const text = wrapper.text()
    expect(text).toContain('1.6M')
    expect(text).toContain('80%')
  })
})
