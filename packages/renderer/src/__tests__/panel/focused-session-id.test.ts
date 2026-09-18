/**
 * focusedSessionId 派生测试 —— 单 panel 下 session 切换时 UI 焦点 session 跟随。
 *
 * split 功能移除（单 panel 化）后，focusedSessionId 直接读 layout.value.sessionId
 * （panel store 暴露的 focusedSessionId computed）。sidebar 高亮 / 文件树均读
 * focusedSessionId，不再读 session.activeId（activeId 收敛为导航语义）。
 *
 * 历史 bug 背景：此前 sidebar 高亮读 session.activeId，loadSession 只改 panel layout，
 * 不改 session.activeId → 高亮不动。引入 focusedSessionId（从 layout.value.sessionId 派生）修复。
 *
 * 覆盖：
 * - T1：单 panel，leaf.sessionId='s1' → focusedSessionId='s1'
 * - T4：focusedSession 按 id 查 session.list（FileView label/branch 数据源）
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/focused-session-id.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'

// features 层调用 api 域；本测试只验 focusedSessionId 派生，mock 成 no-op。
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    getCommands: vi.fn(() => Promise.resolve({ commands: [] })),
  },
}))

import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'

function makeSummary(id: string): SessionSummary {
  return { id, label: `session-${id}`, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

function seedSession(s: SessionSummary): void {
  const store = useSessionStore()
  const group: SessionGroup = { cwd: s.cwd, sessions: [s] }
  store.applySnapshot({ groups: [group] })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('focusedSessionId 派生（单 panel：session 切换 → UI 焦点 session）', () => {
  it('T1: 单 panel，leaf.sessionId=s1 → focusedSessionId=s1', () => {
    const panel = usePanelStore()
    seedSession(makeSummary('s1'))
    panel.loadSession(ROOT_PANEL_ID, 's1')

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    expect(sidebar.focusedSessionId.value).toBe('s1')
    scope.stop()
  })

  it('T4: focusedSession 按 focusedSessionId 查 session.list（FileView label 数据源）', () => {
    const panel = usePanelStore()
    seedSession(makeSummary('s1'))
    panel.loadSession(ROOT_PANEL_ID, 's1')

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    expect(sidebar.focusedSession.value?.label).toBe('session-s1')
    // focusedSessionId 指向不存在的 session → focusedSession=null
    panel.loadSession(ROOT_PANEL_ID, 'nonexistent')
    expect(sidebar.focusedSession.value).toBe(null)
    scope.stop()
  })
})
