/**
 * 编排器单测族 · 浮层 Tab 焦点陷阱随迁保位（display-containers §7.3/§7.5「Tab 焦点陷阱与
 * IME 守卫随迁编排器浮层分支整体保位（不留 W1→W2 空窗），a11y 不回退」）。
 *
 * 陷阱实装自 WorkflowVizOverlay.trapTab 原样迁入（DESIGN §5.12 焦点管理三要素之三）：
 * 浮层开着时 Tab 在面板可聚焦元素首末循环，防逃逸到被遮罩挡住的背景 UI。
 *
 * 三视角：构建者白盒（注册面板 + 编排器浮层分支门控）+ 使用者黑盒（activeElement 首末循环
 * DOM 断言）+ 观察者形态（浮层关态/无面板态 Tab 零动作——不吞浏览器默认 Tab 行为）。
 *
 * 测试框架：vitest（happy-dom）；真实 KeyboardEvent + 真实 core overlay 开合态。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/key-orchestrator/
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getOverlayFocusTrapPanel,
  registerOverlayFocusTrapPanel,
} from '@/composables/features/app/key-orchestrator'
import {
  bindTestSession,
  keyEvent,
  openWorkflowOverlay,
  resetOrchestratorFixtures,
  startOrchestrator,
} from './helpers'

function makePanel(buttonCount: number): { panel: HTMLElement; buttons: HTMLElement[] } {
  const panel = document.createElement('div')
  panel.tabIndex = -1
  const buttons = Array.from({ length: buttonCount }, () => document.createElement('button'))
  panel.append(...buttons)
  document.body.appendChild(panel)
  return { panel, buttons }
}

beforeEach(() => {
  resetOrchestratorFixtures()
  bindTestSession()
})

afterEach(() => {
  resetOrchestratorFixtures()
  document.body.innerHTML = ''
})

describe('浮层 Tab 焦点陷阱（编排器浮层分支，§7.5 随迁保位）', () => {
  it('末元素 Tab 回首元素、首元素 Shift+Tab 到末元素（不逃逸到遮罩后背景 UI）', () => {
    const { panel, buttons } = makePanel(3)
    const [first, , last] = buttons
    openWorkflowOverlay()
    registerOverlayFocusTrapPanel(panel)
    const { stop } = startOrchestrator()

    last.focus()
    window.dispatchEvent(keyEvent('Tab'))
    expect(document.activeElement, '末元素 Tab 拉回首元素').toBe(first)

    window.dispatchEvent(keyEvent('Tab', { shiftKey: true }))
    expect(document.activeElement, '首元素 Shift+Tab 跳到末元素').toBe(last)
    stop()
  })

  it('焦点在面板外（Tab 进入）：拉回首元素；Shift+Tab 拉到末元素', () => {
    const { panel, buttons } = makePanel(2)
    const [first, last] = buttons
    openWorkflowOverlay()
    registerOverlayFocusTrapPanel(panel)
    const { stop } = startOrchestrator()

    document.body.focus()
    window.dispatchEvent(keyEvent('Tab'))
    expect(document.activeElement, '面板外 Tab 拉入面板首元素').toBe(first)

    document.body.focus()
    window.dispatchEvent(keyEvent('Tab', { shiftKey: true }))
    expect(document.activeElement, '面板外 Shift+Tab 拉入面板末元素').toBe(last)
    stop()
  })

  it('面板无可聚焦元素：preventDefault + 面板自身聚焦（安全默认焦点）', () => {
    const { panel } = makePanel(0)
    openWorkflowOverlay()
    registerOverlayFocusTrapPanel(panel)
    const { stop } = startOrchestrator()

    const e = keyEvent('Tab')
    window.dispatchEvent(e)
    expect(e.defaultPrevented, '无可聚焦候选时吞掉 Tab（防逃逸）').toBe(true)
    expect(document.activeElement).toBe(panel)
    stop()
  })

  it('浮层关态：Tab 零动作（不吞浏览器默认 Tab 行为）——编排器浮层分支门控', () => {
    const { panel } = makePanel(2)
    // 残留注册（面板未随关闭注销的防御场景）也因浮层关态不触发陷阱
    registerOverlayFocusTrapPanel(panel)
    const { stop } = startOrchestrator()

    const e = keyEvent('Tab')
    window.dispatchEvent(e)
    expect(e.defaultPrevented, '浮层关态 Tab 不被陷阱消费').toBe(false)
    stop()
  })

  it('面板注册/注销读点（overlay 宿主注入契约）：注册可读、注销回 null', () => {
    const { panel } = makePanel(1)
    registerOverlayFocusTrapPanel(panel)
    expect(getOverlayFocusTrapPanel()).toBe(panel)
    registerOverlayFocusTrapPanel(null)
    expect(getOverlayFocusTrapPanel()).toBe(null)
  })
})
