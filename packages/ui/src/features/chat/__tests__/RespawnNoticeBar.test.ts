/**
 * RespawnNoticeBar.vue 组件测试（[u8-pi-respawn]，crash-resilience §3.3 D7 / 场景 T4）。
 *
 * 三视角 DOM 断言（TEST-STRATEGY §3，TruncatedHistoryBar.test.ts 同型）：
 * - restored 形态：T4 文案可见（在途回合未保留 + 后台任务/子代理不自动恢复 + 可继续发消息），
 *   无重试按钮（自动链路正常，无需手动出口）
 * - restoreFailed 形态：失败文案「引擎恢复失败，点此重试或新建会话」可见 + 重试按钮可见
 * - 重试按钮触发 → emit retry（壳层接 session.restore RPC 手动恢复，熔断后唯一用户出口）
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/RespawnNoticeBar.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

// 覆盖全局 setup 的 t：断言真实文案（与 renderer locales zh-CN 同文）
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const msgs: Record<string, string> = {
        'panel.message.respawnRestored':
          '会话引擎已从崩溃中恢复。中断的回合未保留；崩溃时进行中的后台任务与子代理已终止、不会自动恢复。可继续发消息。',
        'panel.message.respawnFailed': '引擎恢复失败，点此重试或新建会话',
        'panel.message.respawnFailedHint': '多次自动恢复未成功',
        'panel.message.respawnRetry': '重试恢复',
      }
      return msgs[key] ?? key
    },
  }),
}))

import { mount } from '@vue/test-utils'
import RespawnNoticeBar from '../RespawnNoticeBar.vue'

describe('RespawnNoticeBar pi 崩溃恢复提示条（u8，T4）', () => {
  it('restored 形态：T4 文案可见（在途回合未保留 + 后台任务/子代理不复活 + 可继续发消息），无重试按钮', () => {
    const wrapper = mount(RespawnNoticeBar, { props: { variant: 'restored' } })
    const bar = wrapper.find('[data-testid="respawn-notice-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('data-variant')).toBe('restored')
    // 用户可见 T4 文案（三要素齐全：在途回合 / 后台任务与子代理 / 可继续）
    const text = wrapper.find('[data-testid="respawn-notice-text"]').text()
    expect(text).toContain('会话引擎已从崩溃中恢复')
    expect(text).toContain('中断的回合未保留')
    expect(text).toContain('后台任务与子代理已终止、不会自动恢复')
    expect(text).toContain('可继续发消息')
    // 恢复成功无手动出口按钮
    expect(wrapper.find('[data-testid="respawn-notice-retry"]').exists()).toBe(false)
  })

  it('restoreFailed 形态：失败文案「引擎恢复失败，点此重试或新建会话」可见 + 重试按钮可见', () => {
    const wrapper = mount(RespawnNoticeBar, { props: { variant: 'restoreFailed' } })
    expect(wrapper.find('[data-testid="respawn-notice-bar"]').attributes('data-variant')).toBe('restoreFailed')
    const text = wrapper.find('[data-testid="respawn-notice-text"]').text()
    expect(text).toContain('引擎恢复失败，点此重试或新建会话')
    const btn = wrapper.find('[data-testid="respawn-notice-retry"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('重试恢复')
  })

  it('重试按钮触发 → emit retry（壳层接 session.restore 手动恢复 RPC）', async () => {
    const wrapper = mount(RespawnNoticeBar, { props: { variant: 'restoreFailed' } })
    await wrapper.find('[data-testid="respawn-notice-retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})
