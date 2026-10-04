/**
 * 编排器单测族 · isComposing 守卫（display-containers §6.7「isComposing 守卫统一前置——
 * IME 组合态三键一律不动作」/ §8.2「isComposing」；真机 IME 组合态不可稳定自动化，由本族
 * 构造 isComposing=true 事件对账）。
 *
 * 两条键路两种信号源：
 * - keydown 键路（Esc / Tab 浮层陷阱）：`KeyboardEvent.isComposing` 事件权威信号；
 * - IPC 键路（⌃` / ⌘W 经 before-input-event 转发）：compositionstart/compositionend 事件序
 *   维护的组合态布尔（ime-composition 模块）。
 *
 * 每条守卫用例配同键路的非组合态基线（证明「不动作」是守卫所致而非键路本身死键）。
 *
 * 测试框架：vitest（happy-dom）；真实 KeyboardEvent / Composition 事件 + 真实 core 状态。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/key-orchestrator/
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const windowClose = vi.fn(() => Promise.resolve())
vi.mock('@/lib/ipc', () => ({
  onShortcut: () => () => {},
  windowClose: () => windowClose(),
}))

import {
  handleCmdWShortcut,
  handleToggleBottomDrawerShortcut,
  registerOverlayFocusTrapPanel,
} from '@/composables/features/app/key-orchestrator'
import {
  bindTestSession,
  compositionEvent,
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
  compositionEvent('compositionend')
  document.body.innerHTML = ''
})

describe('IME 组合态三键一律不动作（isComposing 守卫统一前置）', () => {
  it('Esc：组合态不剥层（取消候选归输入语义）；非组合态同键照常剥层（基线对照）', () => {
    openBottom()
    openRight()
    const { stop } = startOrchestrator()

    window.dispatchEvent(keyEvent('Escape', { isComposing: true }))
    expect(containerStates(), '组合态 Esc 不动作').toEqual({ overlay: false, bottom: true, right: true })

    window.dispatchEvent(keyEvent('Escape'))
    expect(containerStates(), '基线：非组合态同键剥最外层').toEqual({ overlay: false, bottom: false, right: true })
    stop()
  })

  it('Tab（浮层焦点陷阱分支）：组合态不改焦点；非组合态照常首末循环', () => {
    // 浮层面板 + 两个可聚焦按钮（陷阱候选集）
    const panel = document.createElement('div')
    panel.tabIndex = -1
    const first = document.createElement('button')
    const last = document.createElement('button')
    panel.append(first, last)
    document.body.appendChild(panel)

    openWorkflowOverlay()
    registerOverlayFocusTrapPanel(panel)
    const { stop } = startOrchestrator()

    last.focus()
    window.dispatchEvent(keyEvent('Tab', { isComposing: true }))
    expect(document.activeElement, '组合态 Tab 不触发陷阱').toBe(last)

    window.dispatchEvent(keyEvent('Tab'))
    expect(document.activeElement, '基线：Tab 从末元素回首元素').toBe(first)
    stop()
  })

  it('⌘W（IPC 键路）：组合态无动作（容器不动、不关窗）；compositionend 后同键照常', () => {
    openRight()
    // 组合态跟踪随编排器启动而安装（生产恒由 AppShell 挂载）
    const { stop } = startOrchestrator()
    compositionEvent('compositionstart')
    handleCmdWShortcut()
    expect(windowClose).not.toHaveBeenCalled()
    expect(containerStates().right, '组合态 ⌘W 不动作').toBe(true)

    compositionEvent('compositionend')
    handleCmdWShortcut()
    expect(containerStates().right, '基线：组合结束后 ⌘W 关最外层').toBe(false)
    expect(windowClose).not.toHaveBeenCalled()
    stop()
  })

  it('⌃`（IPC 键路）：组合态不切底抽屉；compositionend 后同键照常开合', () => {
    const { stop } = startOrchestrator()
    compositionEvent('compositionstart')
    handleToggleBottomDrawerShortcut()
    expect(containerStates().bottom, '组合态 ⌃` 不动作').toBe(false)

    compositionEvent('compositionend')
    handleToggleBottomDrawerShortcut()
    expect(containerStates().bottom, '基线：⌃` 开底抽屉').toBe(true)
    handleToggleBottomDrawerShortcut()
    expect(containerStates().bottom, '再按 ⌃` 收回').toBe(false)
    stop()
  })
})
