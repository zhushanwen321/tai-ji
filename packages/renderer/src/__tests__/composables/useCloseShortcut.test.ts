/**
 * useCloseShortcut 单测（Cmd/Ctrl+W 优先关 drawer）。
 *
 * 覆盖：
 * - shortcut type='close' + drawer 开 → close drawer，不调 windowClose
 * - shortcut type='close' + drawer 关 → windowClose IPC
 * - shortcut type 非 'close' → 不响应
 *
 * mock 策略：vi.mock('@/lib/ipc') 捕获 onShortcut（暴露 callback）+ windowClose；
 * vi.mock('@/composables/features/drawer/useSideDrawer') 提供 isOpen ref + close spy。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useCloseShortcut.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { effectScope } from 'vue'

// ── mock lib/ipc：onShortcut 暴露 callback + windowClose 捕获 ──
const mockWindowClose = vi.fn().mockResolvedValue(undefined)
let shortcutCallback: ((type: string) => void) | null = null
const mockOnShortcut = vi.fn((cb: (type: string) => void) => {
  shortcutCallback = cb
  return () => {
    shortcutCallback = null
  }
})

vi.mock('@/lib/ipc', () => ({
  onShortcut: (cb: (type: string) => void) => mockOnShortcut(cb),
  windowClose: () => mockWindowClose(),
}))

// ── mock useSideDrawer：可控的 isOpen ref + close spy ──
const isOpenRef = ref(false)
const mockClose = vi.fn()

vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({
    isOpen: isOpenRef,
    close: mockClose,
  }),
}))

import { useCloseShortcut } from '@/composables/features/app/useCloseShortcut'

beforeEach(() => {
  vi.clearAllMocks()
  isOpenRef.value = false
  shortcutCallback = null
})

/** 在 effectScope 内调 composable，返回 scope。测试结束前不 stop（onScopeDispose 会退订） */
function setupCloseShortcut(): { stop: () => void } {
  const scope = effectScope()
  scope.run(() => {
    useCloseShortcut()
  })
  return { stop: () => scope.stop() }
}

describe('useCloseShortcut（Cmd/Ctrl+W 优先关 drawer）', () => {
  it('drawer 开 → type=close → 关 drawer，不调 windowClose', () => {
    isOpenRef.value = true
    const { stop } = setupCloseShortcut()

    shortcutCallback?.('close')
    expect(mockClose).toHaveBeenCalledTimes(1)
    expect(mockWindowClose).not.toHaveBeenCalled()
    stop()
  })

  it('drawer 关 → type=close → windowClose IPC', () => {
    isOpenRef.value = false
    const { stop } = setupCloseShortcut()

    shortcutCallback?.('close')
    expect(mockClose).not.toHaveBeenCalled()
    expect(mockWindowClose).toHaveBeenCalledTimes(1)
    stop()
  })

  it('type 非 close → 不响应', () => {
    const { stop } = setupCloseShortcut()

    shortcutCallback?.('standard')
    shortcutCallback?.('focus')
    expect(mockClose).not.toHaveBeenCalled()
    expect(mockWindowClose).not.toHaveBeenCalled()
    stop()
  })
})
