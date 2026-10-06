/**
 * useCloseShortcut 单测（容器快捷键 IPC 桥，display-containers §6.7/§7.5）。
 *
 * 覆盖（桥接契约 + 编排器集成）：
 * - 'shortcut' type='close'（⌘W）→ 编排器 handleCmdWShortcut：层级序逐层关容器、全关后关窗；
 * - 'shortcut' type='toggle-bottom-drawer'（⌃`）→ 底抽屉开关（浮层开着照常切换）；
 * - 其它 type（'standard'/'focus' 等 globalShortcut 族）→ 不响应；
 * - 退订契约：onScopeDispose 调用 onShortcut 返回的退订函数。
 *
 * mock 策略：vi.mock('@/lib/ipc') 捕获 onShortcut（暴露 callback）+ windowClose spy；
 * 容器开合态用真实 core 三域状态（编排器判定真值，不 mock）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useCloseShortcut.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'

const windowClose = vi.fn(() => Promise.resolve())
let shortcutCallback: ((type: string) => void) | null = null
let unsubscribeCalled = false
const mockOnShortcut = vi.fn((cb: (type: string) => void) => {
  shortcutCallback = cb
  return () => {
    unsubscribeCalled = true
    shortcutCallback = null
  }
})

vi.mock('@/lib/ipc', () => ({
  onShortcut: (cb: (type: string) => void) => mockOnShortcut(cb),
  windowClose: () => windowClose(),
}))

import { useCloseShortcut } from '@/composables/features/app/useCloseShortcut'
import {
  bindTestSession,
  containerStates,
  openBottom,
  openRight,
  openWorkflowOverlay,
  resetOrchestratorFixtures,
} from './key-orchestrator/helpers'

beforeEach(() => {
  vi.clearAllMocks()
  unsubscribeCalled = false
  shortcutCallback = null
  resetOrchestratorFixtures()
  bindTestSession()
})

afterEach(() => {
  resetOrchestratorFixtures()
})

/** 在 effectScope 内调 composable（onScopeDispose 跟随 scope 退订） */
function setupCloseShortcut(): { stop: () => void } {
  const scope = effectScope()
  scope.run(() => {
    useCloseShortcut()
  })
  return { stop: () => scope.stop() }
}

describe('useCloseShortcut（容器快捷键 IPC 桥 → 编排器）', () => {
  it('type=close（⌘W）：三容器全开 → 沿层级序逐层关，全关后才 windowClose', () => {
    openBottom()
    openRight()
    openWorkflowOverlay()
    const { stop } = setupCloseShortcut()

    shortcutCallback?.('close')
    expect(containerStates()).toEqual({ overlay: false, bottom: true, right: true })
    shortcutCallback?.('close')
    shortcutCallback?.('close')
    expect(containerStates()).toEqual({ overlay: false, bottom: false, right: false })
    expect(windowClose, '全关前不关窗').not.toHaveBeenCalled()

    shortcutCallback?.('close')
    expect(windowClose, '全关后再 close 才关窗').toHaveBeenCalledTimes(1)
    stop()
  })

  it('type=toggle-bottom-drawer（⌃`）：底抽屉开合切换（浮层开着照常切换）', () => {
    openWorkflowOverlay()
    const { stop } = setupCloseShortcut()

    shortcutCallback?.('toggle-bottom-drawer')
    expect(containerStates().bottom, '⌃` 开底抽屉（浮层开着也切）').toBe(true)
    shortcutCallback?.('toggle-bottom-drawer')
    expect(containerStates().bottom, '再按 ⌃` 收回').toBe(false)
    expect(windowClose).not.toHaveBeenCalled()
    stop()
  })

  it('type 非 close/toggle-bottom-drawer（globalShortcut 族）→ 不响应', () => {
    openRight()
    const { stop } = setupCloseShortcut()

    shortcutCallback?.('standard')
    shortcutCallback?.('focus')
    expect(containerStates().right, '其它 type 不动容器').toBe(true)
    expect(windowClose).not.toHaveBeenCalled()
    stop()
  })

  it('onScopeDispose 退订：scope 停止后再发 type 不响应', () => {
    openRight()
    const { stop } = setupCloseShortcut()
    stop()

    expect(unsubscribeCalled, '退订函数被调用').toBe(true)
    shortcutCallback?.('close')
    expect(containerStates().right, '退订后不再响应').toBe(true)
    expect(windowClose).not.toHaveBeenCalled()
  })
})
