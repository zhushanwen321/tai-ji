/**
 * RollingRestartBanner.vue 组件测试（crash-forensics-and-watchdog §3.3 D5 / D3，u7d + #27）。
 *
 * 三视角 DOM 断言（TEST-STRATEGY §3，InboundFrameDroppedNotice.test.ts 同型）——
 * 验收 A1 四态渲染（用户可见 DOM）+ #27 轻态：
 * - 预告（countdown）：「即将自动重启」+ 终端会话终止预告 + warn 色调
 * - 推迟中（deferred）：「最长等待 30 分钟」有界等待语义 + 关闭按钮可见
 * - 红牌（rolling / forced）：danger 色调 + 「正在重启 runtime」
 * - 已恢复转绿（recovered）：info 色调 + 「重启完成」（30s 自动清除的定时语义在
 *   composable 测试覆盖，此处断言渲染契约）
 * - #27（reattach-deferred）：高压延迟轻态文案 + 恢复指引
 * - idle：不渲染；关闭按钮 → 条消失
 *
 * mock 策略：组件是纯投影消费方（状态源 = useRollingRestartStatus），mock 状态源聚焦
 * 渲染契约；相位机/拉取恢复/终态分叉由 composables/__tests__/useRollingRestartStatus.test.ts
 * 覆盖。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/ui/__tests__/RollingRestartBanner.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { RollingRestartBannerPhase } from '@/composables/useRollingRestartStatus'

const stateMock = vi.hoisted(() => ({
  phase: null as unknown as Ref<RollingRestartBannerPhase>,
}))

vi.mock('@/composables/useRollingRestartStatus', async () => {
  const { shallowRef } = await import('vue')
  stateMock.phase = shallowRef({ kind: 'idle' } as RollingRestartBannerPhase)
  return {
    RECOVERED_AUTO_CLEAR_MS: 30_000,
    useRollingRestartStatus: () => ({
      phase: stateMock.phase,
      dismiss: () => { stateMock.phase.value = { kind: 'idle' } },
    }),
  }
})

const RollingRestartBanner = (await import('../RollingRestartBanner.vue')).default

function setPhase(phase: RollingRestartBannerPhase): void {
  stateMock.phase.value = phase
}

describe('RollingRestartBanner 滚动重启四态横幅（D5 / A1）', () => {
  beforeEach(() => {
    setPhase({ kind: 'idle' })
  })

  it('idle：不渲染', () => {
    const wrapper = mount(RollingRestartBanner)
    expect(wrapper.find('[data-testid="rolling-restart-banner"]').exists()).toBe(false)
  })

  it('预告（countdown）：即将自动重启 + 终端会话终止预告 + 关闭按钮可见', () => {
    setPhase({ kind: 'countdown', executesAt: Date.now() + 30_000, inflight: 0 })
    const wrapper = mount(RollingRestartBanner)
    const banner = wrapper.find('[data-testid="rolling-restart-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.attributes('data-phase')).toBe('countdown')
    expect(banner.attributes('role')).toBe('alert')
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('即将自动重启')
    expect(text).toContain('终端会话将随重启终止')
    expect(wrapper.find('[data-testid="rolling-restart-dismiss"]').exists()).toBe(true)
  })

  it('预告退化形态（status 拉取恢复，executesAt 未知）：不含秒数的「即将自动重启」', () => {
    setPhase({ kind: 'countdown', executesAt: 0, inflight: null })
    const wrapper = mount(RollingRestartBanner)
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('即将自动重启')
    expect(text).not.toContain('秒内')
  })

  it('推迟中（deferred）：30 分钟有界等待语义 + 终端会话预告', () => {
    setPhase({ kind: 'deferred', reason: 'inflight', inflight: 2, deferDeadlineAt: Date.now() + 30 * 60_000 })
    const wrapper = mount(RollingRestartBanner)
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('内存接近上限')
    expect(text).toContain('最长等待 30 分钟')
    expect(text).toContain('终端会话将随重启终止')
  })

  it('推迟中 errs 形态（absent-report）：计数未知文案，不展示误导性任务数', () => {
    setPhase({ kind: 'deferred', reason: 'absent-report', inflight: null, deferDeadlineAt: Date.now() + 30 * 60_000 })
    const wrapper = mount(RollingRestartBanner)
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('正在确认后台任务状态')
  })

  it('红牌（rolling / forced）：danger 色调 + 正在重启 runtime 文案', () => {
    setPhase({ kind: 'rolling', reason: 'hard-threshold', inflight: 1 })
    const wrapper = mount(RollingRestartBanner)
    const banner = wrapper.find('[data-testid="rolling-restart-banner"]')
    expect(banner.attributes('data-phase')).toBe('rolling')
    expect(wrapper.find('[data-testid="rolling-restart-icon"]').classes().join(' ')).toContain('text-danger')
    expect(wrapper.find('[data-testid="rolling-restart-text"]').text()).toContain('正在重启 runtime')
  })

  it('已恢复转绿（recovered）：info 色调 + 重启完成文案', () => {
    setPhase({ kind: 'recovered' })
    const wrapper = mount(RollingRestartBanner)
    const banner = wrapper.find('[data-testid="rolling-restart-banner"]')
    expect(banner.attributes('data-phase')).toBe('recovered')
    expect(wrapper.find('[data-testid="rolling-restart-icon"]').classes().join(' ')).toContain('text-info')
    expect(wrapper.find('[data-testid="rolling-restart-text"]').text()).toContain('重启完成')
  })

  it('#27 轻态（reattach-deferred）：高压延迟文案 + 复查周期 + 手动恢复指引', () => {
    setPhase({ kind: 'reattach-deferred', pollMs: 30_000 })
    const wrapper = mount(RollingRestartBanner)
    const banner = wrapper.find('[data-testid="rolling-restart-banner"]')
    expect(banner.attributes('data-phase')).toBe('reattach-deferred')
    const text = wrapper.find('[data-testid="rolling-restart-text"]').text()
    expect(text).toContain('自动恢复已推迟')
    expect(text).toContain('每 30 秒复查')
    expect(text).toContain('手动打开会话')
  })

  it('关闭按钮 → 条消失（用户主动出口）', async () => {
    setPhase({ kind: 'deferred', reason: 'inflight', inflight: 0, deferDeadlineAt: 0 })
    const wrapper = mount(RollingRestartBanner)
    expect(wrapper.find('[data-testid="rolling-restart-banner"]').exists()).toBe(true)
    await wrapper.find('[data-testid="rolling-restart-dismiss"]').trigger('click')
    expect(wrapper.find('[data-testid="rolling-restart-banner"]').exists()).toBe(false)
  })
})
