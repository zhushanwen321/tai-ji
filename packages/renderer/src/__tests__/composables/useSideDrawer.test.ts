/**
 * useSideDrawer per-session 控制态隔离单测（W3: U1-U10）。
 *
 * 验证从模块级单例 isOpen/activeTab/docked 重构为 per-session Map 分区后
 * （U2 切回恢复三态/U4 docked 不污染/U10 reactive 容器契约与 core
 * domain/drawer/__tests__/control.test.ts 逐字重复，已删——经兼容层转发以外的
 * renderer 侧增量保留）：
 * - U1 (AC-1): 跨 session 不干扰——切走/切回不互相污染
 * - U5 (AC-5): deleteSession 清理分区
 * - U6 (AC-6): 手动关后切回不被重开（无新事件）
 * - U9 (AC-9): 双 panel standby 无独立 drawer 状态
 *
 * [P4 s5 drawer-widget-removal] U3 (pendingOpen 切回消费)/ U7 (快速来回切幂等)/
 * U8 (手动 open 清 pendingOpen) 已删：pendingOpen 机制随 tasks 域移除（PluginViewContainer 承接）。
 *
 * 运行：npx vitest run src/__tests__/composables/useSideDrawer.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'

// ── mock panel store：控制 focusedSessionId（active panel 的 sessionId）──
// useSideDrawer 内部读 panel store 的 focusedSessionId computed 作分区键。
// 测试通过 setFocusedSessionId 切换「当前 active panel 绑定的 session」。
const mockFocusedSessionId = ref<string | null>(null)
const mockPanels = ref<Array<{ id: string; sessionId: string | null }>>([
  { id: 'panel-root', sessionId: null },
])

vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    get focusedSessionId() {
      return mockFocusedSessionId.value
    },
    get panels() {
      return mockPanels.value
    },
    setActive(panelId: string) {
      const p = mockPanels.value.find((leaf) => leaf.id === panelId)
      if (p) mockFocusedSessionId.value = p.sessionId
    },
    loadSession(panelId: string, sessionId: string | null) {
      const p = mockPanels.value.find((leaf) => leaf.id === panelId)
      if (p) {
        p.sessionId = sessionId
        if (panelId === 'panel-root') mockFocusedSessionId.value = sessionId
      }
    },
  }),
}))

import { useSideDrawer, resetSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'

/** 切换当前 focused session（模拟 selectSession 改 active panel 的 session 绑定） */
function focusSession(sid: string | null): void {
  mockFocusedSessionId.value = sid
}

beforeEach(() => {
  // 注意：不调 __clearSessionCleanupRegistryForTest()——useSideDrawer 是模块级单例，
  // controlState 的 cleanup 注册在模块加载时完成（一次），跨 test 保留是正确的。
  // clear 反而会丢掉单例的 cleanup 注册，导致 U5 的 triggerSessionCleanups 验证失效。
  // 状态隔离靠 resetSideDrawer（清分区）。
  mockFocusedSessionId.value = null
  mockPanels.value = [{ id: 'panel-root', sessionId: null }]
  resetSideDrawer()
})

describe('useSideDrawer U1 (AC-1) 跨 session 不干扰', () => {
  it('session A 的 drawer 打开，用户在 B，B 的 drawer 不被弹开', () => {
    focusSession('A')
    useSideDrawer().open('git')

    focusSession('B')
    const { isOpen, activeTab } = useSideDrawer()

    // B 的 drawer 不被弹开
    expect(isOpen.value).toBe(false)
    expect(activeTab.value).toBe('terminal')
  })
})

describe('useSideDrawer U5 (AC-5) deleteSession 清理分区', () => {
  it('triggerSessionCleanups(A) 清掉 A 控制态分区', () => {
    focusSession('A')
    useSideDrawer().open('git')

    // session 销毁编排
    triggerSessionCleanups('A')

    // A 分区重置：切到 A 应是默认态（isOpen=false）
    focusSession('A')
    expect(useSideDrawer().isOpen.value).toBe(false)
    expect(useSideDrawer().activeTab.value).toBe('terminal')
  })
})

describe('useSideDrawer U6 (AC-6) 手动关不被重开', () => {
  it('A 手动 open 后 close，切走再切回，drawer 保持关闭（无新事件）', () => {
    focusSession('A')
    const drawer = useSideDrawer()
    drawer.open('git')
    drawer.close()

    focusSession('B')
    focusSession('A') // 切回，无新事件

    expect(useSideDrawer().isOpen.value).toBe(false)
  })
})

describe('useSideDrawer U9 (AC-9) 双 panel standby 无独立状态', () => {
  it('setActive(P2) 后 drawer 显示 B 分区状态（standby 期间无独立维护）', () => {
    // 双 panel 布局：P1(A) P2(B)
    mockPanels.value = [
      { id: 'P1', sessionId: 'A' },
      { id: 'P2', sessionId: 'B' },
    ]
    focusSession('A') // P1 active

    // 在 A 分区操作：开 git tab
    useSideDrawer().open('git')
    expect(useSideDrawer().activeTab.value).toBe('git')

    // 切到 P2（B 变 active）—— B 作为 standby 期间无操作，其分区是默认态
    focusSession('B')
    const drawer = useSideDrawer()
    expect(drawer.isOpen.value).toBe(false) // B 默认态
    expect(drawer.activeTab.value).toBe('terminal')

    // 切回 P1（A），A 分区状态保留
    focusSession('A')
    expect(useSideDrawer().isOpen.value).toBe(true)
    expect(useSideDrawer().activeTab.value).toBe('git')
  })
})
