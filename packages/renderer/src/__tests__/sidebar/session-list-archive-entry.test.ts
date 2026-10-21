/**
 * SessionList 工具组归档入口测试（session-archive 设计 D10，u-renderer-entry）。
 *
 * 覆盖验收条款「角标 0 隐藏」+ 入口交互：
 * - 归档入口钮存在（Archive 图标，位于「+ 新建项目」与平铺/分组开关之间）且恒可点
 *   （count 0 也打开归档列表——空列表有引导空态）
 * - 角标：count 0 隐藏 / count 3 显示 3 / count 150 封顶 99+
 * - 点击 emit openArchives
 * - SessionItem 归档事件透传（@archive → emit archive）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-archive-entry.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import SessionList from '@/components/sidebar/SessionList.vue'

const SESSION_MODE_KEY = 'taiji:sidebar-session-mode'

function makeSession(id: string): SessionSummary {
  return { id, label: `会话 ${id}`, cwd: '/alpha', status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0 }
}

function mountList(archiveCount?: number, restoredSessionId?: string) {
  const groups: SessionGroup[] = [{ cwd: '/alpha', sessions: [makeSession('a1')] }]
  return mount(SessionList, {
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
      ...(archiveCount !== undefined ? { archiveCount } : {}),
      ...(restoredSessionId !== undefined ? { restoredSessionId } : {}),
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem(SESSION_MODE_KEY)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SessionList 归档入口（D10 工具组）', () => {
  it('入口钮存在且恒可点（count 0 不禁用）；缺省 archiveCount prop = 0（角标隐藏默认形态）', async () => {
    const wrapper = mountList()
    const btn = wrapper.find('[data-testid="sidebar-archive-entry-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.find('svg.lucide-archive').exists()).toBe(true)

    await btn.trigger('click')
    expect(wrapper.emitted('openArchives')).toHaveLength(1)
    wrapper.unmount()
  })

  it('角标 0 隐藏（D10：count 0 隐藏，按钮仍可点）', () => {
    const wrapper = mountList(0)
    expect(wrapper.find('[data-testid="sidebar-archive-count-badge"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('角标 3 → 显示「3」；title 携带计数', () => {
    const wrapper = mountList(3)
    const badge = wrapper.find('[data-testid="sidebar-archive-count-badge"]')
    expect(badge.text()).toBe('3')
    expect(wrapper.find('[data-testid="sidebar-archive-entry-btn"]').attributes('title')).toBe('已归档会话（3）')
    wrapper.unmount()
  })

  it('角标 150 → 封顶显示「99+」', () => {
    const wrapper = mountList(150)
    expect(wrapper.find('[data-testid="sidebar-archive-count-badge"]').text()).toBe('99+')
    wrapper.unmount()
  })
})

describe('SessionList 归档事件透传（D6 悬停归档钮链路）', () => {
  it('SessionItem 两段确认后 emit archive → SessionList 透传 emit archive(sessionId)', async () => {
    const wrapper = mountList()
    const btn = wrapper.find('[data-testid="session-archive-btn"]')

    await btn.trigger('click')
    await btn.trigger('click')

    expect(wrapper.emitted('archive')).toEqual([['a1']])
    wrapper.unmount()
  })
})

describe('SessionList 恢复高亮（session-archive §5.1「原项目组顶部、accent-soft 高亮渐隐」）', () => {
  it('restoredSessionId 匹配行：accent-soft 底色 + highlight testid；其余行与缺省态无高亮', () => {
    const wrapper = mountList(undefined, 'a1')
    const row = wrapper.find('[data-testid="session-item-restored-highlight"]')
    expect(row.exists()).toBe(true)
    expect(row.classes()).toContain('bg-accent-soft')
    wrapper.unmount()
  })

  it('restoredSessionId 无匹配（null 或他行）：无高亮 testid、无 accent-soft 底色', () => {
    const wrapper = mountList(undefined, 'other-id')
    expect(wrapper.find('[data-testid="session-item-restored-highlight"]').exists()).toBe(false)
    expect(wrapper.find('.session-item').classes()).not.toContain('bg-accent-soft')
    wrapper.unmount()
  })
})
