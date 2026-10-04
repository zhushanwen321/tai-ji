/**
 * 编排器单测族 · ⌘W 双键让位 + 层级序 + 全关后关窗（display-containers §6.7 R4 双键拆分 /
 * §8.2「双键让位」，对账 S7）。
 *
 * S7 断言半边（单测承载）：
 * - 三容器全关后 ⌘W 才关窗（不多关不早关）；
 * - 设置页（yieldsCmdW ✓）开着 ⌘W → 无动作（窗口不关、容器不动、模态不动）；
 * - Select/弹出层族（yieldsEsc ✓ / yieldsCmdW ✗）开着 ⌘W → 照常按层级序关最外层容器
 *   （非死键——R4 双键拆分：弹层瞬态、reka 不以 ⌘W dismiss，让位即死键）。
 *
 * 测试框架：vitest（happy-dom）；真实 core 三域状态 + 真实聚合注册表；仅 '@/lib/ipc' mock
 * （windowClose IPC 面）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/key-orchestrator/
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const windowClose = vi.fn(() => Promise.resolve())
vi.mock('@/lib/ipc', () => ({
  onShortcut: () => () => {},
  windowClose: () => windowClose(),
}))

import { registerModalSurface, resetModalSurfaceRegistry } from '@/composables/features/app/modal-surface-registry'
import { handleCmdWShortcut } from '@/composables/features/app/key-orchestrator'
import {
  bindTestSession,
  containerStates,
  keyEvent,
  openBottom,
  openRight,
  openWorkflowOverlay,
  resetOrchestratorFixtures,
  startOrchestrator,
} from './helpers'

beforeEach(() => {
  resetOrchestratorFixtures()
  bindTestSession()
  windowClose.mockClear()
})

afterEach(() => {
  resetOrchestratorFixtures()
  resetModalSurfaceRegistry()
})

describe('⌘W：yields⌘W 让位 + 层级序逐层关 + 全关后关窗', () => {
  it('全关后 ⌘W 才关窗（不多关不早关）', () => {
    openRight()
    handleCmdWShortcut()
    expect(windowClose, '容器开着时 ⌘W 关容器不关窗').not.toHaveBeenCalled()
    expect(containerStates().right).toBe(false)

    handleCmdWShortcut()
    expect(windowClose, '全关后再 ⌘W 才关窗').toHaveBeenCalledTimes(1)
  })

  it('三容器全开：⌘W 沿同一层级序逐层关（浮层 → 底抽屉 → 右抽屉），全关后关窗', () => {
    openBottom()
    openRight()
    openWorkflowOverlay()

    handleCmdWShortcut()
    expect(containerStates()).toEqual({ overlay: false, bottom: true, right: true })
    handleCmdWShortcut()
    expect(containerStates()).toEqual({ overlay: false, bottom: false, right: true })
    handleCmdWShortcut()
    expect(containerStates()).toEqual({ overlay: false, bottom: false, right: false })
    expect(windowClose).not.toHaveBeenCalled()

    handleCmdWShortcut()
    expect(windowClose).toHaveBeenCalledTimes(1)
  })

  it('设置页（yieldsCmdW ✓）开着：⌘W 无动作——窗口不关、容器不动、模态不动（S7 让位守卫）', () => {
    const dispose = registerModalSurface({
      surface: 'settings-modal',
      key: 'cmdw-settings',
      isOpen: () => true,
    })
    openBottom()
    openRight()

    handleCmdWShortcut()
    expect(windowClose).not.toHaveBeenCalled()
    expect(containerStates(), '两个容器原样保持').toEqual({ overlay: false, bottom: true, right: true })
    dispose()
  })

  it('Select 下拉（弹出层族 yieldsCmdW ✗）开着：⌘W 照常按层级序关最外层容器（非死键，R4 双键拆分）', () => {
    const dispose = registerModalSurface({
      surface: 'select-content',
      key: 'cmdw-select',
      isOpen: () => true,
    })
    openBottom()

    handleCmdWShortcut()
    expect(containerStates().bottom, '弹层族不让 ⌘W——照常关底抽屉').toBe(false)
    expect(windowClose).not.toHaveBeenCalled()
    dispose()
  })

  it('双键拆分对照（§6.7 R4）：同一弹出层族开着 Esc 让位而 ⌘W 动作', () => {
    const dispose = registerModalSurface({
      surface: 'popover-content',
      key: 'cmdw-popover',
      isOpen: () => true,
    })
    openBottom()
    const { stop } = startOrchestrator()

    window.dispatchEvent(keyEvent('Escape'))
    expect(containerStates().bottom, 'Esc 让位（弹层是视觉最外层，Esc 先关弹层）').toBe(true)

    handleCmdWShortcut()
    expect(containerStates().bottom, '⌘W 不让位（防弹层开态 ⌘W 死键）').toBe(false)
    stop()
    dispose()
  })
})
