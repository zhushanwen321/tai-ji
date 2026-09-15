/**
 * Panel store 单测 —— 单 panel 状态（v2：移除 split 后退化）。
 *
 * 历史背景：v1 用 PanelTree 递归树支持单/双 panel split 主从状态机（split/close/isDual）。
 * split 功能移除（2026-07-24）后退化为恒单 panel：layout 是单个 PanelLeaf，无树结构。
 *
 * 覆盖：
 * - 初始态：currentLeaf 存在、activePanelId=ROOT_PANEL_ID、focusedSessionId=null
 * - loadSession：不可变更新触发响应式（leaf 对象替换）
 * - loadSession 对不存在的 panelId no-op
 * - findPanelBySession 命中 / null
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel.store.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'

describe('usePanelStore 单 panel 状态（v2：移除 split）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('初始态：单 panel、currentLeaf 存在、activePanelId=ROOT_PANEL_ID、focusedSessionId=null', () => {
    const panel = usePanelStore()
    expect(panel.currentLeaf).toBeDefined()
    expect(panel.currentLeaf.id).toBe(ROOT_PANEL_ID)
    expect(panel.activePanelId).toBe(ROOT_PANEL_ID)
    expect(panel.focusedSessionId).toBe(null)
  })

  it('loadSession：目标 leaf 不可变替换（原 leaf 对象引用改变）', () => {
    const panel = usePanelStore()
    const leafBefore = panel.currentLeaf
    panel.loadSession(ROOT_PANEL_ID, 's-load')
    const leafAfter = panel.currentLeaf
    expect(leafAfter.sessionId).toBe('s-load')
    // leaf 对象被替换（不可变更新，非就地突变），保证 Vue 响应式触发
    expect(leafAfter).not.toBe(leafBefore)
    // focusedSessionId 跟随 layout.value.sessionId
    expect(panel.focusedSessionId).toBe('s-load')
  })

  it('loadSession 对不存在的 panelId 是 no-op', () => {
    const panel = usePanelStore()
    const layoutBefore = panel.layout
    panel.loadSession('no-such-panel', 's1')
    expect(panel.layout).toBe(layoutBefore)
  })

  it('findPanelBySession：命中返回叶子，未命中返回 null', () => {
    const panel = usePanelStore()
    expect(panel.findPanelBySession('s1')).toBeNull()
    panel.loadSession(ROOT_PANEL_ID, 's-x')
    const found = panel.findPanelBySession('s-x')
    expect(found?.id).toBe(ROOT_PANEL_ID)
  })
})
