/**
 * 编排器单测族 · Esc 键序矩阵（display-containers §5.1 规则 3 固定层级序 / §6.7 Esc 唯一属主 /
 * §8.2 验收条款「键序矩阵」，对账 S3）。
 *
 * 关闭次序 = 固定层级序「浮层 → 底抽屉 → 右抽屉」逐层剥（**不按开序时间记账**——状态模型
 * 不存开序）。判别态用例（S3）：按「底抽屉 → 右抽屉 → 浮层」开序连按 Esc，第二次必须关
 * 底抽屉而非右抽屉——逆开序（时间记账）实现在此红。
 *
 * 三视角：构建者白盒（层级序决策 + defaultPrevented 约定）+ 使用者黑盒（容器开合可见状态
 * 逐次翻转）+ 观察者形态（焦点契约：关闭后回 composer 的 DOM 断言）。
 *
 * 测试框架：vitest（happy-dom，config 默认环境）；真实 KeyboardEvent + 真实 core 三域状态。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/key-orchestrator/
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})

afterEach(() => {
  resetOrchestratorFixtures()
  document.body.innerHTML = ''
})

function pressEsc(): KeyboardEvent {
  const e = keyEvent('Escape')
  window.dispatchEvent(e)
  return e
}

describe('Esc 键序矩阵（固定层级序：浮层 → 底抽屉 → 右抽屉）', () => {
  it('三容器全开：Esc 按 浮层 → 底抽屉 → 右抽屉 逐层剥（可证伪开序——与逆开序实现判别）', () => {
    // 开序刻意 ≠ 层级序：底抽屉 → 右抽屉 → 浮层（S3 判别态开序）
    openBottom()
    openRight()
    openWorkflowOverlay()
    const { stop } = startOrchestrator()

    expect(containerStates()).toEqual({ overlay: true, bottom: true, right: true })

    pressEsc()
    expect(containerStates(), '第一次 Esc 只关浮层').toEqual({ overlay: false, bottom: true, right: true })

    pressEsc()
    expect(containerStates(), '第二次 Esc 必须关底抽屉（层级序）而非右抽屉（逆开序）')
      .toEqual({ overlay: false, bottom: false, right: true })

    pressEsc()
    expect(containerStates(), '第三次 Esc 关右抽屉').toEqual({ overlay: false, bottom: false, right: false })
    stop()
  })

  it('浮层关态：Esc 先剥底抽屉再剥右抽屉（层级序不看开序——右抽屉先开也后关）', () => {
    openRight()
    openBottom()
    const { stop } = startOrchestrator()

    pressEsc()
    expect(containerStates(), '第一次 Esc 关底抽屉（层级序第二层）').toEqual({ overlay: false, bottom: false, right: true })
    pressEsc()
    expect(containerStates()).toEqual({ overlay: false, bottom: false, right: false })
    stop()
  })

  it('仅一层开：Esc 关该层 + preventDefault（消费即约定，下游可判 Esc 已被消费）', () => {
    openRight()
    const { stop } = startOrchestrator()

    const e = pressEsc()
    expect(e.defaultPrevented).toBe(true)
    expect(containerStates().right).toBe(false)
    stop()
  })

  it('全关态 Esc：不动作、不 preventDefault（无层可剥——不吞掉其它消费方的 Esc）', () => {
    const { stop } = startOrchestrator()
    const e = pressEsc()
    expect(e.defaultPrevented).toBe(false)
    expect(containerStates()).toEqual({ overlay: false, bottom: false, right: false })
    stop()
  })

  it('焦点契约（§6.7）：任一容器关闭后焦点回 composer', () => {
    // composer-box 真实 DOM（Composer.vue 同款 class + testid 双锚；内层 contenteditable 为聚焦目标）
    const box = document.createElement('div')
    box.className = 'composer-box'
    box.setAttribute('data-testid', 'composer-box')
    const input = document.createElement('div')
    input.setAttribute('contenteditable', 'true')
    box.appendChild(input)
    document.body.appendChild(box)

    openBottom()
    const { stop } = startOrchestrator()
    pressEsc()
    expect(containerStates().bottom).toBe(false)
    expect(document.activeElement, '关闭后焦点回 composer').toBe(input)
    stop()
  })
})
