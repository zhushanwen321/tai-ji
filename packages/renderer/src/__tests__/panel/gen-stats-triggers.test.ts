/**
 * GenStatsTriggers 组件测试 —— composer-gen-stats P4（三视角：构建者白盒 + 使用者黑盒 DOM + 观察者形态）。
 *
 * - 使用者黑盒（真实 HoverCard）：双触发器存在（title 定位）、null 显「—」、帧驱动显示更新、
 *   命中率 80/50 三档语义色（class 断言，用户可见样式）；
 * - 观察者形态（HoverCard 家族 stub 常开）：浮层内容行（速度四行 / 缓存两行 + bar + 口径说明 /
 *   model 标题 / 暂无数据）——reka HoverCard 未 hover 不渲染 content，stub 常开让浮层内容
 *   可做用户可见 DOM 断言；
 * - 数据注入：经真实 events.dispatchSession 通道喂 session.stats_update 帧（对齐
 *   context-capacity-popover.test.ts 形态）；getGenStats RPC mock 为永不 resolve 的 pending
 *   （恢复腿在途，不污染帧直驱断言）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/gen-stats-triggers.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import * as events from '@taiji/core/transport/api'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { __clearInFlightGenStatsForTest } from '@/composables/features/model/useGenStats'
import type { GenStatsFrame, ServerMessage } from '@taiji/shared'

import GenStatsTriggers from '@/components/panel/GenStatsTriggers.vue'

// ── mock 边界：getGenStats RPC mock 为受控 pending（恢复腿不落地）──
// mock 目标 = 实现 import 的权威路径（u5 re-anchor 删除 @/api/request bridge 后，
// mock 指旧路径 = 拦截失效，恢复腿会真实打 transport）；spread actual 只换 command/
// 超时常量：useSessionEvents 经主模块 events.on 订阅，须保留真实 events 通道（测试侧
// dispatchSession 与实现侧订阅经同一真实 events 模块实例，注册表共享），否则帧链路断
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

/** HoverCard 家族 stub：内容常开渲染（观察者形态——浮层内容行可 DOM 断言） */
const HOVER_STUBS = {
  HoverCard: { name: 'HoverCard', template: '<div><slot /></div>' },
  HoverCardTrigger: { name: 'HoverCardTrigger', template: '<div><slot /></div>' },
  HoverCardContent: { name: 'HoverCardContent', template: '<div><slot /></div>' },
}

const SPEED_TITLE = 'TOKEN 速度' // zh-CN locale（vitest-i18n-setup 解析）
const CACHE_TITLE = '缓存命中率'

/** 帧工厂 */
function genFrame(sessionId: string, overrides: Partial<GenStatsFrame> = {}): GenStatsFrame {
  return {
    sessionId,
    speed: { current: 35, day: 28, d7: 22, d30: 19 },
    cacheRatio: { current: 91, day: 87 },
    model: 'prov-a/m1',
    ...overrides,
  }
}

function pushSessionMsg(sid: string, msg: ServerMessage): void {
  events.dispatchSession(sid, msg)
}

function mountTriggers(stubHover = false) {
  return mount(GenStatsTriggers, {
    props: { sessionId: 's1', modelId: 'prov-a/m1' },
    global: stubHover ? { stubs: HOVER_STUBS } : {},
  })
}

beforeEach(() => {
  commandMock.mockReset()
  commandMock.mockImplementation(() => new Promise(() => {}))
  __clearSessionCleanupRegistryForTest()
  __clearInFlightGenStatsForTest()
})

// ── 使用者黑盒（真实 HoverCard 渲染路径）────────────────────

describe('双触发器渲染（黑盒 DOM）', () => {
  it('双触发器存在（速度 + 缓存命中率，title 定位）', () => {
    const wrapper = mountTriggers()
    expect(wrapper.find(`[title="${SPEED_TITLE}"]`).exists()).toBe(true)
    expect(wrapper.find(`[title="${CACHE_TITLE}"]`).exists()).toBe(true)
  })

  it('无帧（从未收到合法帧）→ 两触发器均显「—」', () => {
    const wrapper = mountTriggers()
    expect(wrapper.find('[data-testid="genstats-speed-value"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="genstats-cache-value"]').text()).toBe('—')
  })

  it('帧驱动：速度「35 t/s」、命中率「91%」独立显示', async () => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', { type: 'session.stats_update', payload: genFrame('s1') })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-speed-value"]').text()).toBe('35 t/s')
    expect(wrapper.find('[data-testid="genstats-cache-value"]').text()).toBe('91%')
  })

  it('字段级独立判定：速度有值 + 命中率 null（非 cache 模型常态）→ 速度显值、命中率显「—」', async () => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { cacheRatio: { current: null, day: null } }),
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-speed-value"]').text()).toBe('35 t/s')
    expect(wrapper.find('[data-testid="genstats-cache-value"]').text()).toBe('—')
  })

  it('脏帧（帧内 model 与当前 modelId 不匹配）→ 不覆盖显示，保持「—」', async () => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', { type: 'session.stats_update', payload: genFrame('s1', { model: 'prov-b/m2' }) })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-speed-value"]').text()).toBe('—')
  })

  // ── 命中率语义色三档（≥80 success / 50–80 warn / <50 danger；null 中性）──
  it.each([
    { ratio: 85, tier: 'text-success' },
    { ratio: 80, tier: 'text-success' },
    { ratio: 60, tier: 'text-warn' },
    { ratio: 50, tier: 'text-warn' },
    { ratio: 30, tier: 'text-danger' },
  ])('命中率 $ratio% → 语义色 $tier', async ({ ratio, tier }) => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { cacheRatio: { current: ratio, day: ratio } }),
    })
    await flushPromises()

    const btn = wrapper.find(`[title="${CACHE_TITLE}"]`)
    expect(btn.classes()).toContain(tier)
  })

  it('命中率 null → 触发器中性色（无语义色分档）', async () => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { cacheRatio: { current: null, day: null } }),
    })
    await flushPromises()

    const btn = wrapper.find(`[title="${CACHE_TITLE}"]`)
    expect(btn.classes()).toContain('text-neutral-dim')
    expect(btn.classes()).not.toContain('text-success')
  })

  // ── 归因降噪（2026-09-19 D-A）：帧带 currentMiss → 成因文案 + 中性色（非故障）──
  it.each([
    { reason: 'cold-start', label: '首次请求' },
    { reason: 'idle-expiry', label: '空闲过期' },
    { reason: 'context-rewrite', label: '压缩重建' },
  ] as const)('归因 $reason → 触发器显「$label」而非 0%，且为中性色（非 danger）', async ({ reason, label }) => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', {
        cacheRatio: { current: 0, day: 0, currentMiss: { reason, idleMs: reason === 'idle-expiry' ? 12 * 60_000 : undefined } },
      }),
    })
    await flushPromises()

    const btn = wrapper.find(`[title="${CACHE_TITLE}"]`)
    expect(wrapper.find('[data-testid="genstats-cache-value"]').text()).toBe(label)
    expect(btn.classes()).toContain('text-neutral-dim')
    expect(btn.classes()).not.toContain('text-danger')
  })

  it('未知成因的 0%（无 currentMiss）→ 仍显「0%」+ danger 色（降噪不吞真 miss 信号）', async () => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { cacheRatio: { current: 0, day: 0 } }),
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-cache-value"]').text()).toBe('0%')
    expect(wrapper.find(`[title="${CACHE_TITLE}"]`).classes()).toContain('text-danger')
  })
})

// ── 观察者形态（浮层内容行，HoverCard stub 常开）────────────

describe('浮层内容（观察者形态）', () => {
  it('速度浮层：head 双端（标题 + model）+ 四行聚合 + 口径说明', async () => {
    const wrapper = mountTriggers(true)
    await flushPromises()

    pushSessionMsg('s1', { type: 'session.stats_update', payload: genFrame('s1') })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-speed-model"]').text()).toBe('prov-a/m1')
    const text = wrapper.text()
    expect(text).toContain('本次')
    expect(text).toContain('35 t/s')
    expect(text).toContain('今日均值（此模型）')
    expect(text).toContain('28 t/s')
    expect(text).toContain('近 7 天')
    expect(text).toContain('22 t/s')
    expect(text).toContain('近 30 天')
    expect(text).toContain('19 t/s')
    expect(text).toContain('今日/7 天/30 天为该模型跨会话累计（加权平均）')
    // C4 口径补句：速度 = 单次 LLM 请求耗时口径（不含工具执行）
    expect(text).toContain('按单次 LLM 请求耗时计算，不含工具执行时间')
    // C4「本次」label 的 title 补句（本会话最近一次请求语义澄清）以属性断言锁定
    expect(wrapper.find('[title="本会话最近一次请求的记录"]').exists()).toBe(true)
  })

  it('缓存浮层：两行（本次请求 / 今日加权）+ bar（宽度 = 命中率）+ 口径说明', async () => {
    const wrapper = mountTriggers(true)
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { cacheRatio: { current: 91, day: 87 } }),
    })
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('本次请求')
    expect(text).toContain('91%')
    expect(text).toContain('今日加权（此模型）')
    expect(text).toContain('87%')
    expect(text).toContain('cacheRead ÷ (input + cacheRead + cacheWrite)')
    // C4 口径补句：模型不支持缓存时显示「—」（归因降噪后：无计量 ≠ 0%）
    expect(text).toContain('模型不支持缓存时显示「—」')

    const bar = wrapper.find('[data-testid="genstats-cache-bar"]')
    expect(bar.exists()).toBe(true)
    expect((bar.element as HTMLElement).style.width).toBe('91%')
  })

  it('缓存命中率 null → bar 不渲染，行值显「—」', async () => {
    const wrapper = mountTriggers(true)
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { cacheRatio: { current: null, day: 50 } }),
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-cache-bar"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('—')
  })

  // ── 归因降噪浮层（2026-09-19 D-A）：成因说明行 + bar 隐藏 + 本次行显成因文案 ──
  it('归因态浮层：本次行显成因文案、成因说明行（含空闲时长）、bar 隐藏', async () => {
    const wrapper = mountTriggers(true)
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', {
        cacheRatio: { current: 0, day: 96, currentMiss: { reason: 'idle-expiry', idleMs: 12 * 60_000 } },
      }),
    })
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('空闲过期')
    expect(text).toContain('距上次请求已空闲 12m')
    expect(text).toContain('provider 缓存已过期')
    expect(text).toContain('今日加权（此模型）')
    expect(text).toContain('96%') // 今日加权照常显示（归因只作用于本次行）

    expect(wrapper.find('[data-testid="genstats-cache-miss-note"]').text()).toContain('空闲')
    // 归因态无 0% 数值可画 → bar 整体隐藏（空轨道会被读成另一种 0）
    expect(wrapper.find('[data-testid="genstats-cache-bar"]').exists()).toBe(false)
  })

  it('context-rewrite 归因浮层：压缩重建说明行', async () => {
    const wrapper = mountTriggers(true)
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { cacheRatio: { current: 0, day: 90, currentMiss: { reason: 'context-rewrite' } } }),
    })
    await flushPromises()

    expect(wrapper.text()).toContain('压缩重建')
    expect(wrapper.text()).toContain('上下文压缩后前缀重建')
  })

  it('命中态无成因说明行（降噪行只在归因存在时出现）', async () => {
    const wrapper = mountTriggers(true)
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { cacheRatio: { current: 91, day: 87 } }),
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-cache-miss-note"]').exists()).toBe(false)
  })

  it('无合法帧 → 浮层显「暂无数据」（从未有帧与有帧无值的 UX 差异落在浮层）', () => {
    const wrapper = mountTriggers(true)
    expect(wrapper.text()).toContain('暂无数据')
  })

  it('有帧但字段全 null → 浮层无「暂无数据」，行值显「—」（两态区分）', async () => {
    const wrapper = mountTriggers(true)
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', {
        speed: { current: null, day: null, d7: null, d30: null },
        cacheRatio: { current: null, day: null },
      }),
    })
    await flushPromises()

    expect(wrapper.text()).not.toContain('暂无数据')
    expect(wrapper.find('[data-testid="genstats-speed-value"]').text()).toBe('—')
  })
})
