import RespawnNoticeBar from '../../features/chat/RespawnNoticeBar.vue';
import SourceImportSection from '../../features/settings/common/SourceImportSection.vue';
import { provideSettingsTransport } from '@taiji/core';
import { makeSettingsTransportStub } from '@taiji/core/testing';
import type { SourceDetectResult } from '@taiji/shared';
import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, vi } from 'vitest';

// wave3 簇 [ui/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - features/chat/__tests__/RespawnNoticeBar.test.ts
 * - features/settings/common/__tests__/SourceImportSection.test.ts
 */

// ======================================================================
// ← features/chat/__tests__/RespawnNoticeBar.test.ts
// ======================================================================

// 覆盖全局 setup 的 t：断言真实文案（与 renderer locales zh-CN 同文）；共享口径见 helpers/i18n-mock
// （本文件字典无命名参数占位符；组件调用 t 不带参数，插值分支不参与）
vi.mock('vue-i18n', async () => {
  const { i18nMock } = await import('../helpers/i18n-mock')
  return i18nMock({
    'panel.message.respawnRestored':
      '会话引擎已从崩溃中恢复。中断的回合未保留；崩溃时进行中的后台任务与子代理已终止、不会自动恢复。可继续发消息。',
    'panel.message.respawnFailed': '引擎恢复失败，点此重试或新建会话',
    'panel.message.respawnFailedHint': '多次自动恢复未成功',
    'panel.message.respawnRetry': '重试恢复',
  })
})

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

// ======================================================================
// ← features/settings/common/__tests__/SourceImportSection.test.ts
// ======================================================================

const K = {
  unreadable: 'settings.loadPaths.importFromAgents.unreadable',
  notInstalled: 'settings.loadPaths.importFromAgents.notInstalled',
  skillCount: 'settings.loadPaths.importFromAgents.skillCount',
} as const

function mountSection(results: SourceDetectResult[]) {
  provideSettingsTransport(makeSettingsTransportStub({
    detectSources: vi.fn(async () => results),
  }))
  return mount(SourceImportSection, {
    props: { kind: 'skill' as const, existingDirs: [] },
  })
}

describe('SourceImportSection · 不可读三态区分（RT-5#5）', () => {
  it('error=unreadable 的源渲染「目录不可读」，不渲染「未安装」也不渲染计数', async () => {
    const wrapper = mountSection([
      { source: 'claude', installed: true, dir: '/home/u/.claude/skills', error: 'unreadable' },
      { source: 'codex', installed: false, dir: '/home/u/.codex/skills' },
      { source: 'pi', installed: true, dir: '/home/u/.pi/agent/skills', skillCount: 3 },
    ])
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="import-candidate"]')
    expect(rows).toHaveLength(3)

    // claude：不可读 → unreadable 文案；无 notInstalled / 计数
    const claudeText = rows[0]!.text()
    expect(claudeText).toContain(K.unreadable)
    expect(claudeText).not.toContain(K.notInstalled)
    expect(claudeText).not.toContain(K.skillCount)

    // codex：目录不存在 → notInstalled（三态区分的对照侧）
    expect(rows[1]!.text()).toContain(K.notInstalled)
    expect(rows[1]!.text()).not.toContain(K.unreadable)

    // pi：正常 → 计数
    expect(rows[2]!.text()).toContain(K.skillCount)
  })
})
