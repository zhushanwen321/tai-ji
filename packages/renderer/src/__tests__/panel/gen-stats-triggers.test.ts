/**
 * GenStatsTriggers 组件测试 —— composer-gen-stats P4 + composer-genstats-ttft U4
 * （三视角：构建者白盒 + 使用者黑盒 DOM + 观察者形态）。
 *
 * - 使用者黑盒（真实 HoverCard）：三触发器存在（title 定位）、null 显「—」、帧驱动显示更新、
 *   命中率 80/50 三档语义色、TTFT 1499/1500/3000/3001 三档语义色边界（S5）与 999/1000
 *   格式化 ms/s 边界（class 断言，用户可见样式）；
 * - 观察者形态（HoverCard 家族 stub 常开）：浮层内容行（TTFT 四行 p50 / 速度四行 /
 *   缓存两行 + bar + 口径说明 / model 标题 / 暂无数据）——reka HoverCard 未 hover 不渲染
 *   content，stub 常开让浮层内容可做用户可见 DOM 断言；
 * - 构建者白盒：SFC 普通 script 块命名导出的纯函数（formatTtftDuration / ttftTier）
 *   直连单测（双 script 块先例 AsyncErrorFallback.vue）；
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

import GenStatsTriggers, {
  formatTtftDuration,
  ttftTier,
  TTFT_WARN_THRESHOLD_MS,
  TTFT_DANGER_THRESHOLD_MS,
} from '@/components/panel/GenStatsTriggers.vue'

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
const TTFT_TITLE = '首字延迟 TTFT'

/** 帧工厂（ttft 基线：current=820 →「820ms」，day=900 →「900ms」，d7=1100 →「1.1s」，d30=1300 →「1.3s」） */
function genFrame(sessionId: string, overrides: Partial<GenStatsFrame> = {}): GenStatsFrame {
  return {
    sessionId,
    speed: { current: 35, day: 28, d7: 22, d30: 19 },
    cacheRatio: { current: 91, day: 87 },
    ttft: { current: 820, day: 900, d7: 1100, d30: 1300 },
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
})

// ── TTFT 触发器（composer-genstats-ttft U4，黑盒 DOM）────────────

describe('TTFT 触发器渲染（黑盒 DOM）', () => {
  it('TTFT 触发器存在且位于速度触发器左侧（title 定位 + DOM 顺序）', () => {
    const wrapper = mountTriggers()
    const ttftBtn = wrapper.find(`[title="${TTFT_TITLE}"]`)
    const speedBtn = wrapper.find(`[title="${SPEED_TITLE}"]`)
    expect(ttftBtn.exists()).toBe(true)
    expect(speedBtn.exists()).toBe(true)
    // 速度按钮视角：TTFT 元素带 PRECEDING 位 = TTFT 在速度左侧（设计 §3.1 组件内顺序 TTFT · 速度 · 缓存）
    const preceding =
      speedBtn.element.compareDocumentPosition(ttftBtn.element) & Node.DOCUMENT_POSITION_PRECEDING
    expect(preceding).toBeTruthy()
  })

  it('无帧（从未收到合法帧）→ TTFT 显「—」', () => {
    const wrapper = mountTriggers()
    expect(wrapper.find('[data-testid="genstats-ttft-value"]').text()).toBe('—')
  })

  it('帧驱动：ttft.current=820 →「820ms」', async () => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', { type: 'session.stats_update', payload: genFrame('s1') })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-ttft-value"]').text()).toBe('820ms')
  })

  it('帧内 ttft 全 null（错误 turn / runtime 中途启动丢锚路径）→ 显「—」（无值纪律：null 非 0）', async () => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { ttft: { current: null, day: null, d7: null, d30: null } }),
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-ttft-value"]').text()).toBe('—')
    // 同帧速度照常显示（字段级独立判定，ttft 无值不拖累其它指标）
    expect(wrapper.find('[data-testid="genstats-speed-value"]').text()).toBe('35 t/s')
  })

  // ── 格式化 ms/s 边界（设计 §3.1：<1000 →「820ms」；≥1000 →「1.2s」1 位小数去尾 0）──
  it.each([
    { ms: 999, text: '999ms' },
    { ms: 1000, text: '1s' },
    { ms: 1001, text: '1s' },
    { ms: 1200, text: '1.2s' },
  ])('格式化边界：ttftMs=$ms → 触发器显「$text」', async ({ ms, text }) => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { ttft: { current: ms, day: null, d7: null, d30: null } }),
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="genstats-ttft-value"]').text()).toBe(text)
  })

  // ── 三档语义色边界 S5（延迟反向）：<1500 success · 1500–3000 warn · >3000 danger ──
  it.each([
    { ms: 1499, tier: 'text-success' },
    { ms: 1500, tier: 'text-warn' },
    { ms: 3000, tier: 'text-warn' },
    { ms: 3001, tier: 'text-danger' },
  ])('TTFT $ms ms → 语义色 $tier（S5 边界）', async ({ ms, tier }) => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { ttft: { current: ms, day: null, d7: null, d30: null } }),
    })
    await flushPromises()

    const btn = wrapper.find(`[title="${TTFT_TITLE}"]`)
    expect(btn.classes()).toContain(tier)
  })

  it('TTFT null → 触发器中性灰（无语义色分档，与其他档位类互斥）', async () => {
    const wrapper = mountTriggers()
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { ttft: { current: null, day: null, d7: null, d30: null } }),
    })
    await flushPromises()

    const btn = wrapper.find(`[title="${TTFT_TITLE}"]`)
    expect(btn.classes()).toContain('text-neutral-dim')
    expect(btn.classes()).not.toContain('text-success')
    expect(btn.classes()).not.toContain('text-warn')
    expect(btn.classes()).not.toContain('text-danger')
  })
})

// ── TTFT 纯函数（SFC 普通 script 块命名导出，构建者白盒）────

describe('TTFT 纯函数：formatTtftDuration / ttftTier', () => {
  it('formatTtftDuration：<1000 → 整数毫秒（0 是真实测量值显「0ms」，非无值）', () => {
    expect(formatTtftDuration(0)).toBe('0ms')
    expect(formatTtftDuration(820)).toBe('820ms')
    expect(formatTtftDuration(999)).toBe('999ms')
  })

  it('formatTtftDuration：≥1000 → s 1 位小数四舍五入去尾 0', () => {
    expect(formatTtftDuration(1000)).toBe('1s')
    expect(formatTtftDuration(1200)).toBe('1.2s')
    expect(formatTtftDuration(1250)).toBe('1.3s') // Math.round(12.5)=13 → 1.3s（四舍五入）
    expect(formatTtftDuration(1499)).toBe('1.5s')
    expect(formatTtftDuration(3000)).toBe('3s')
    expect(formatTtftDuration(3210)).toBe('3.2s')
  })

  it('ttftTier：阈值边界与 null 恒中性（S5；阈值常量与实现同源导入）', () => {
    expect(TTFT_WARN_THRESHOLD_MS).toBe(1500)
    expect(TTFT_DANGER_THRESHOLD_MS).toBe(3000)
    expect(ttftTier(null)).toBe('neutral')
    expect(ttftTier(0)).toBe('success')
    expect(ttftTier(1499)).toBe('success')
    expect(ttftTier(1500)).toBe('warn')
    expect(ttftTier(3000)).toBe('warn')
    expect(ttftTier(3001)).toBe('danger')
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
    // C4 口径补句：模型不支持缓存时恒为 0%
    expect(text).toContain('模型不支持缓存时恒为 0%')

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

// ── TTFT 浮层（composer-genstats-ttft U4，观察者形态）────────────

describe('TTFT 浮层（观察者形态）', () => {
  it('浮层存在：head 双端（标题 + model）+ 四行 p50 聚合 + 口径说明', async () => {
    const wrapper = mountTriggers(true)
    await flushPromises()

    pushSessionMsg('s1', { type: 'session.stats_update', payload: genFrame('s1') })
    await flushPromises()

    const popover = wrapper.find('[data-testid="genstats-ttft-popover"]')
    expect(popover.exists()).toBe(true)
    expect(popover.text()).toContain(TTFT_TITLE)
    expect(wrapper.find('[data-testid="genstats-ttft-model"]').text()).toBe('prov-a/m1')

    // 四行：本次 820ms / 今日 p50 900ms / 近 7 天 p50 1.1s / 近 30 天 p50 1.3s（label + 预格式化值）
    const text = popover.text()
    expect(text).toContain('本次')
    expect(text).toContain('820ms')
    expect(text).toContain('今日 p50（此模型）')
    expect(text).toContain('900ms')
    expect(text).toContain('近 7 天 p50')
    expect(text).toContain('1.1s')
    expect(text).toContain('近 30 天 p50')
    expect(text).toContain('1.3s')
    // 口径 note：p50 中位数 + 请求发出→首 token 口径 + 不含工具执行
    expect(text).toContain('p50 中位数')
    expect(text).toContain('不含工具执行时间')
    // 「本次」行复用 C4 hover 补句（同速度侧语义）
    expect(wrapper.find('[title="本会话最近一次请求的记录"]').exists()).toBe(true)
  })

  it('有帧但 ttft 字段全 null → 行值显「—」，浮层无「暂无数据」（两态区分）', async () => {
    const wrapper = mountTriggers(true)
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'session.stats_update',
      payload: genFrame('s1', { ttft: { current: null, day: null, d7: null, d30: null } }),
    })
    await flushPromises()

    const popover = wrapper.find('[data-testid="genstats-ttft-popover"]')
    expect(popover.exists()).toBe(true)
    expect(popover.text()).not.toContain('暂无数据')
    expect(popover.text()).toContain('—')
    // 触发器同步显「—」
    expect(wrapper.find('[data-testid="genstats-ttft-value"]').text()).toBe('—')
  })

  it('无合法帧 → TTFT 浮层显「暂无数据」', () => {
    const wrapper = mountTriggers(true)
    const popover = wrapper.find('[data-testid="genstats-ttft-popover"]')
    expect(popover.exists()).toBe(true)
    expect(popover.text()).toContain('暂无数据')
  })
})
