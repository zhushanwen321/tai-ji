/**
 * useGlobalShortcuts shortcutOverrides 分支测试（review S-7 补充）。
 *
 * 覆盖 matchOverrideKey 路径（设置页重录快捷键）：
 *  - 注入重录键（'mod+n' / 'shift+j' / 'alt+x'）后，按重录键触发对应 action
 *  - 有 override 时按默认键不触发（override 取代默认匹配）
 *
 * Mock 策略（对齐 shortcut-config.test.ts 壳单例 mock 范式）：
 *  - useCommandStore mock 为可控 shortcutOverrides ref（vi.hoisted 共享，测试内直接改值）
 *  - @taiji/core 仅覆盖 useSearchModal（其余导出走真实实现）
 *  - navigation / preset / sidebar 走真实 pinia store
 *
 * 监听器生命周期：useGlobalShortcuts 用 @vueuse useEventListener 挂 window keydown，
 * effectScope + scope.stop() 确保每用例解绑，避免用例间监听器累积重复派发。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/shell/useGlobalShortcuts.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'

/** commandStore 壳 mock：shortcutOverrides 可控 ref（重录键注入点） */
const commandStoreMock = vi.hoisted(() => ({
  shortcutOverrides: { value: {} as Record<string, string> },
}))
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({
    shortcutOverrides: commandStoreMock.shortcutOverrides,
  }),
}))

/** @taiji/core 仅覆盖 useSearchModal（toggle spy），其余导出保留真实实现 */
const searchModalMock = vi.hoisted(() => ({
  toggle: vi.fn(),
}))
vi.mock('@taiji/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core')>()
  return {
    ...actual,
    useSearchModal: () => ({ toggle: searchModalMock.toggle }),
  }
})

import { useGlobalShortcuts, type UseGlobalShortcutsOptions } from '@/composables/shell/useGlobalShortcuts'
import { useSidebarStore } from '@/stores/sidebar'
import { useNavigationStore } from '@/stores/navigation'
import { usePresetStore } from '@/stores/preset'

/** 构造 keydown 事件并派发到 window（useGlobalShortcuts 的监听挂点） */
function fireKey(options: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): void {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: options.key,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
    bubbles: true,
    cancelable: true,
  }))
}

/** 在独立 effect scope 内启动快捷键派发，返回 stop 函数（解绑 window 监听） */
function mountShortcuts(options: UseGlobalShortcutsOptions): () => void {
  const scope = effectScope()
  scope.run(() => useGlobalShortcuts(options))
  return () => scope.stop()
}

describe('useGlobalShortcuts shortcutOverrides 分支', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    commandStoreMock.shortcutOverrides.value = {}
  })

  it('new-session 重录为 mod+m：按重录键触发 onNewSession，按默认 ⌘N 不触发', () => {
    const onNewSession = vi.fn()
    const stop = mountShortcuts({ onNewSession, forkFromLastAssistant: vi.fn(), enterForkModeFromLastAssistant: vi.fn(), handoffFromLastAssistant: vi.fn(), navigation: useNavigationStore(), openSettings: vi.fn() })
    try {
      // 重录键与默认键（mod+n）错开，才能验证「重录后默认键失效」
      commandStoreMock.shortcutOverrides.value = { 'new-session': 'mod+m' }

      // 重录键 mod+m（meta 前缀）→ 触发
      fireKey({ key: 'm', metaKey: true })
      expect(onNewSession).toHaveBeenCalledTimes(1)

      // 默认键 ⌘N 失效：override 取代 keymap 默认匹配，按 ⌘N 不再触发
      fireKey({ key: 'n', metaKey: true })
      expect(onNewSession).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('toggle-sidebar 重录为 shift+j：按 shift+j 触发 toggleCollapsed，默认 ⌘B 不触发', () => {
    const sidebar = useSidebarStore()
    const stop = mountShortcuts({ onNewSession: vi.fn(), forkFromLastAssistant: vi.fn(), enterForkModeFromLastAssistant: vi.fn(), handoffFromLastAssistant: vi.fn(), navigation: useNavigationStore(), openSettings: vi.fn() })
    try {
      commandStoreMock.shortcutOverrides.value = { 'toggle-sidebar': 'shift+j' }
      const before = sidebar.collapsed

      // 重录键 shift+j → 折叠切换
      fireKey({ key: 'j', shiftKey: true })
      expect(sidebar.collapsed).toBe(!before)

      // 默认键 ⌘B 失效（override 取代默认匹配，且 j 键默认走 handoff 分支有 composer 守卫，此处无关）
      fireKey({ key: 'b', metaKey: true })
      expect(sidebar.collapsed).toBe(!before)
    } finally {
      stop()
    }
  })

  it('open-preset-select 重录为 alt+x：按 alt+x 触发 requestOpen，默认 ⌘⇧P 不触发', () => {
    const requestOpen = vi.spyOn(usePresetStore(), 'requestOpen')
    const stop = mountShortcuts({ onNewSession: vi.fn(), forkFromLastAssistant: vi.fn(), enterForkModeFromLastAssistant: vi.fn(), handoffFromLastAssistant: vi.fn(), navigation: useNavigationStore(), openSettings: vi.fn() })
    try {
      commandStoreMock.shortcutOverrides.value = { 'open-preset-select': 'alt+x' }

      // 重录键 alt+x → requestOpen
      fireKey({ key: 'x', altKey: true })
      expect(requestOpen).toHaveBeenCalledTimes(1)

      // 默认键 ⌘⇧P 失效
      fireKey({ key: 'p', metaKey: true, shiftKey: true })
      expect(requestOpen).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      requestOpen.mockRestore()
    }
  })

  it('重录键命中走 override：无 override 时默认 ⌘N 仍触发 onNewSession（回归防护）', () => {
    const onNewSession = vi.fn()
    const stop = mountShortcuts({ onNewSession, forkFromLastAssistant: vi.fn(), enterForkModeFromLastAssistant: vi.fn(), handoffFromLastAssistant: vi.fn(), navigation: useNavigationStore(), openSettings: vi.fn() })
    try {
      // 默认（无 override）：⌘N 触发
      fireKey({ key: 'n', metaKey: true })
      expect(onNewSession).toHaveBeenCalledTimes(1)

      // 无 mod 修饰不触发
      fireKey({ key: 'n' })
      expect(onNewSession).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })
})
