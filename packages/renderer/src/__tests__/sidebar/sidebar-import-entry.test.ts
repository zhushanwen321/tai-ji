/**
 * Sidebar「导入会话」入口接线测试（import-session u6 + u7 fresh 徽标接线）。
 *
 * 验证（impl-plan §2 u6 验收条款 + u7）：
 *  - TC1: 「导入会话」ghost 按钮渲染在「新建任务」之后、「搜索」之前（nav 顺序断言）
 *  - TC2: ⌘I（meta+i）经 useGlobalShortcuts（真实执行，未 mock）触发 → ImportSessionDialog
 *         props open=true；无 mod 修饰的裸 i 不触发
 *  - TC3: 点击入口按钮 → ImportSessionDialog props open=true
 *  - TC4: ImportSessionDialog emit imported → Sidebar 驱动 fresh「导入」徽标状态机
 *         （markImportedFresh；数秒后淡出移除——设计 §3.1 / demo doImport 时序）
 *
 * mock 策略对齐 sidebar-assign-project-wiring.test.ts 范式（Sidebar.vue 整体 mount 依赖
 * 10+ store/composable，shallowMount + store/composable mock），mock 段收敛
 * __tests__/helpers/sidebar-mount.ts 两文件共享单源。差异点：Button 用显式 slot stub
 * （默认 shallow stub 不渲染 slot 文本，无法断言 nav 内按钮顺序/文案）；ImportSessionDialog
 * 保持默认 stub（不执行其内部 RPC 链路，只断言 props 接线）。
 *
 * 监听器泄漏防护：useGlobalShortcuts 的 window keydown 监听挂 effect scope（unmount 才解绑），
 * 且命中后 stopImmediatePropagation 截胡后续实例——断言中途失败必须 unmount，否则泄漏实例
 * 截胡下一用例的按键。所有用例 try/finally 包裹 unmount。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-import-entry.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'

import {
  chatComposableModule,
  commandStoreModule,
  fileTreeStoreModule,
  listSyncModule,
  navigationStoreModule,
  panelStoreModule,
  platformShortcutModule,
  sessionDerivationsModule,
  sessionStoreModule,
  sidebarStoreModule,
  sidebarSubagentActionsModule,
  subagentStoreModule,
  toastModule,
  useSidebarModule,
  workflowStoreModule,
} from '../helpers/sidebar-mount'

vi.mock('@/composables/useToast', () => toastModule())
vi.mock('@/composables/features/sidebar/useSidebar', () => useSidebarModule())
vi.mock('@/stores/sidebar', () => sidebarStoreModule())
vi.mock('@/stores/session', () => sessionStoreModule({ includeSetListLoadError: true }))
vi.mock('@/stores/fileTree', () => fileTreeStoreModule())
vi.mock('@/stores/panel', () => panelStoreModule())
vi.mock('@/stores/subagent', () => subagentStoreModule())
vi.mock('@/stores/workflow', () => workflowStoreModule())
vi.mock('@/stores/navigation', () => navigationStoreModule())
vi.mock('@/composables/features/command/useCommandStore', () => commandStoreModule())
vi.mock('@/composables/features/chat/useChat', () => chatComposableModule())
vi.mock('@/composables/features/chat/useSessionDerivations', () => sessionDerivationsModule())
vi.mock('@/composables/features/chat/useListSync', () => listSyncModule())
vi.mock('@/composables/features/sidebar/useSidebarSubagentActions', () => sidebarSubagentActionsModule())
vi.mock('@/composables/usePlatformShortcut', () => platformShortcutModule())
// 注：原版此处另有 vi.mock('@/api/events', ...)——'@/api/events' 模块不存在（Sidebar 实际
// import '@taiji/core/transport/api'，见 Sidebar.vue:248），该 mock 从未命中，已删除。

import Sidebar from '@/components/sidebar/Sidebar.vue'
import ImportSessionDialog from '@/components/sidebar/ImportSessionDialog.vue'
import {
  isImportedFresh,
  __resetImportedFreshForTest,
  IMPORT_FRESH_VISIBLE_MS,
  IMPORT_FRESH_FADE_MS,
  type ImportSessionImportedPayload,
} from '@/composables/features/sidebar/useImportSession'

/** shallowMount Sidebar，Button 用显式 slot stub（真实 <button> 元素 + slot 文本可见） */
function mountSidebar() {
  return shallowMount(Sidebar, {
    global: {
      stubs: {
        Button: { template: '<button><slot /></button>' },
      },
    },
  })
}

/** 构造 keydown 事件派发到 window（useGlobalShortcuts 的 useEventListener 挂点） */
function fireKey(options: { key: string; metaKey?: boolean }): void {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: options.key,
    metaKey: options.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  __resetImportedFreshForTest()
})

describe('Sidebar 导入会话入口接线（import-session u6）', () => {
  it('TC1: 「导入会话」按钮渲染在「新建任务」之后、「搜索」之前，带定位 testid', () => {
    const wrapper = mountSidebar()
    try {
      const navTexts = wrapper.find('nav').findAll('button').map((b) => b.text())
      expect(navTexts.length).toBe(3)
      expect(navTexts[0]).toContain('新建任务')
      expect(navTexts[1]).toContain('导入会话')
      expect(navTexts[2]).toContain('搜索')
      // 入口按钮 testid（E2E 走查 V1 定位锚点）
      expect(wrapper.find('[data-testid="sidebar-import-session-btn"]').exists()).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it('TC2: ⌘I 经 useGlobalShortcuts 打开 ImportSessionDialog；裸 i（无 mod）不触发', async () => {
    const wrapper = mountSidebar()
    try {
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(false)

      fireKey({ key: 'i', metaKey: true })
      await nextTick()
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(true)

      // 回归：无 mod 修饰不触发（keymap 默认匹配要求 meta/ctrl）
      wrapper.getComponent(ImportSessionDialog).vm.$emit('update:open', false)
      await nextTick()
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(false)
      fireKey({ key: 'i' })
      await nextTick()
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('TC3: 点击入口按钮打开 ImportSessionDialog', async () => {
    const wrapper = mountSidebar()
    try {
      const importBtn = wrapper.find('[data-testid="sidebar-import-session-btn"]')
      expect(importBtn.exists()).toBe(true)

      await importBtn.trigger('click')
      expect(wrapper.getComponent(ImportSessionDialog).props('open')).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it('TC4: imported 事件 → Sidebar 驱动 fresh「导入」徽标状态机（u7：实显 → 淡出 → 移除）', async () => {
    vi.useFakeTimers()
    const wrapper = mountSidebar()
    try {
      const payload: ImportSessionImportedPayload = {
        sessionId: 'imported-fresh-sid',
        sessionName: '会话名',
        projectName: 'Stock',
        targetPath: '/target/copied.jsonl',
      }
      wrapper.getComponent(ImportSessionDialog).vm.$emit('imported', payload)
      await nextTick()

      // 构建者：Sidebar 接线 → markImportedFresh 生效（visible 实显）
      expect(isImportedFresh('imported-fresh-sid')).toBe('visible')
      // 其他 session 不受影响
      expect(isImportedFresh('other-sid')).toBeNull()

      // 观察者：3.2s 后进入淡出阶段，再 200ms 移除（demo doImport 时序）
      vi.advanceTimersByTime(IMPORT_FRESH_VISIBLE_MS)
      expect(isImportedFresh('imported-fresh-sid')).toBe('fading')
      vi.advanceTimersByTime(IMPORT_FRESH_FADE_MS)
      expect(isImportedFresh('imported-fresh-sid')).toBeNull()
    } finally {
      wrapper.unmount()
      __resetImportedFreshForTest()
      vi.useRealTimers()
    }
  })
})
