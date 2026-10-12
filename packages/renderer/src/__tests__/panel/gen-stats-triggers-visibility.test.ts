/**
 * GenStatsTriggers 空值不占位渲染测试（2026-10-11 用户裁决防回归）。
 *
 * 裁决：触发器无值（null 且非归因态）时整钮不渲染——新会话/新旁路线首 turn 前
 * 底栏不再出现「— — —」（对齐 landing 无数据不渲染的形态）。无值编码纪律不变：
 * null=无数据不渲染，0=真实测量值照常显示。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：无帧 → 三值节点全不渲染；有帧 → 三值节点渲染；
 *   部分无值帧 → 无值维不渲染、有值维照常（维度级独立）
 * - 观察者（形态）：根容器恒在（零宽折叠由 flex 布局自然承担，不出孤立的组容器盒）
 *
 * mock 策略：@/api 局部替换（useGenStats 恢复腿走 core transport command——经
 * importActual 保留 events 面，仅 command 按 sid 发帧/挂起）；HoverCard 浮层不展开
 * （只断言触发器按钮），reka 在 happy-dom 下触发器正常渲染。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/gen-stats-triggers-visibility.test.ts
 */
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { ref } from 'vue'
import { useGenStats, __clearInFlightGenStatsForTest } from '@/composables/features/model/useGenStats'
import type { GenStatsFrame } from '@taiji/shared'

// 恢复腿 RPC 面：按 sid 出帧（PENDING sid 恒挂起 = 无帧形态）；events 面走 actual
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock }
})

import GenStatsTriggers from '@/components/panel/GenStatsTriggers.vue'

const SID = 's-stats'
const PENDING_SID = 's-pending'

function frameOf(over: {
  ttft?: number | null
  speed?: number | null
  cache?: number | null
}): GenStatsFrame {
  return {
    sessionId: SID,
    speed: { current: over.speed ?? null, day: null, d7: null, d30: null },
    cacheRatio: { current: over.cache ?? null, day: null },
    ttft: { current: over.ttft ?? null, day: null, d7: null, d30: null },
  } as GenStatsFrame
}

/** 组合式挂载壳：GenStatsTriggers 必须在 setup 同步消费 useGenStats（getCurrentInstance 守卫）。 */
function mountTriggers(sessionId?: string) {
  return mount({
    components: { GenStatsTriggers },
    setup() {
      // 真 ref（useGenStats 内部 watch 对源形态有契约，假 {value} 对象会触发 Invalid watch source）
      const sidRef = ref<string | null | undefined>(sessionId ?? undefined)
      useGenStats(sidRef, ref(undefined))
      return { sid: sidRef }
    },
    template: `<GenStatsTriggers :session-id="sid" />`,
  })
}

const valueTestids = [
  'genstats-ttft-value',
  'genstats-speed-value',
  'genstats-cache-value',
] as const

enableAutoUnmount(afterEach)

beforeEach(() => {
  commandMock.mockReset()
  __clearInFlightGenStatsForTest()
  commandMock.mockImplementation((_method: string, payload: { sessionId?: string }) =>
    payload?.sessionId === PENDING_SID ? new Promise(() => {}) : Promise.resolve(frameOf({})),
  )
})

describe('GenStatsTriggers 空值不占位（使用者黑盒 DOM）', () => {
  it('无帧（挂起恢复腿）→ 三触发器值节点全不渲染，根容器仍在', () => {
    const wrapper = mountTriggers(PENDING_SID)
    for (const id of valueTestids) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(false)
    }
    expect(wrapper.find('div.flex.items-center.gap-0').exists()).toBe(true)
  })

  it('全有值帧 → 三触发器照常渲染（0 是真值也渲染）', async () => {
    commandMock.mockResolvedValue(frameOf({ ttft: 0, speed: 0, cache: 0 }))
    const wrapper = mountTriggers(SID)
    await vi.waitFor(() => {
      for (const id of valueTestids) {
        expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
      }
    })
  })

  it('部分无值帧 → 无值维不渲染、有值维照常（维度级独立）', async () => {
    commandMock.mockResolvedValue(frameOf({ ttft: null, speed: 12.5, cache: null }))
    const wrapper = mountTriggers(SID)
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="genstats-speed-value"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-testid="genstats-ttft-value"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="genstats-cache-value"]').exists()).toBe(false)
  })
})
