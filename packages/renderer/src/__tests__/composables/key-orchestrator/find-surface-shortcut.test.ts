/**
 * 编排器单测族 · Ctrl+F 表面内查找 + Esc 先关查找框（find-in-surface phase 1 接线，
 * orchestrator.ts 键序判定新增的两条分支）：
 *
 * - Ctrl/Cmd+F（window keydown bubble）：isComposing 守卫 → defaultPrevented 先检 →
 *   preventDefault + useFindInSurface.openFindAtPointer()（悬停归属优先 → 回退栈序 →
 *   全无不动作）。
 * - Esc 分支内「查找框开着 → 先关查找框」层：查找框是表面上的临时覆盖层，先于容器剥层
 *   （焦点在表面其它位置时 Esc 不得穿透成「关容器」）。
 *
 * 装配口径同族（helpers.ts）：真实 core 三域状态 + 真实聚合注册表 + 真实 KeyboardEvent +
 * **真实 useFindInSurface 单例**（归属判定读真实 DOM——`[data-find-surface]` 桩元素与
 * 生产属性值同款：overlay / bottom-drawer / right-drawer）；无 IPC 键路参与，不 mock。
 *
 * 测试框架：vitest（happy-dom，config 默认环境）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/key-orchestrator/
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useFindInSurface } from '@/composables/features/find/useFindInSurface'
import {
  bindTestSession,
  containerStates,
  keyEvent,
  openBottom,
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
  useFindInSurface().close()
  document.body.innerHTML = ''
})

/** 可搜表面桩（OverlayShell/PanelContainer 同款属性值；归属判定读该标记） */
function appendSurface(kind: string): void {
  const el = document.createElement('div')
  el.setAttribute('data-find-surface', kind)
  document.body.appendChild(el)
}

function pressEsc(): KeyboardEvent {
  const e = keyEvent('Escape')
  window.dispatchEvent(e)
  return e
}

describe('Ctrl+F 表面内查找（find-in-surface 接线）', () => {
  it('Cmd+F：悬停缺省走回退栈序开最上层可搜表面（overlay）+ 消费事件 + 送达聚焦意图', () => {
    openWorkflowOverlay()
    appendSurface('overlay')
    const { stop } = startOrchestrator()

    const e = keyEvent('f', { metaKey: true })
    window.dispatchEvent(e)

    const find = useFindInSurface()
    expect(e.defaultPrevented).toBe(true)
    expect(find.isOpen.value).toBe(true)
    expect(find.surfaceKind.value).toBe('overlay')
    expect(find.focusTick.value, 'focusTick 自增 = FindBar 聚焦意图已送达').toBe(1)
    stop()
  })

  it('Ctrl+F：同款触发（双平台同触，metaKey||ctrlKey 无平台分支）', () => {
    appendSurface('bottom-drawer')
    const { stop } = startOrchestrator()

    const e = keyEvent('f', { ctrlKey: true })
    window.dispatchEvent(e)

    const find = useFindInSurface()
    expect(e.defaultPrevented).toBe(true)
    expect(find.isOpen.value).toBe(true)
    expect(find.surfaceKind.value).toBe('bottom-drawer')
    stop()
  })

  it('先行档已消费（defaultPrevented）→ 不动作（不重复开查找）', () => {
    appendSurface('overlay')
    const { stop } = startOrchestrator()

    const e = keyEvent('f', { metaKey: true })
    e.preventDefault()
    window.dispatchEvent(e)

    const find = useFindInSurface()
    expect(find.isOpen.value).toBe(false)
    stop()
  })

  it('无修饰键的 f：纯文本输入键不触发查找、不吞事件', () => {
    appendSurface('overlay')
    const { stop } = startOrchestrator()

    const e = keyEvent('f')
    window.dispatchEvent(e)

    expect(e.defaultPrevented).toBe(false)
    expect(useFindInSurface().isOpen.value).toBe(false)
    stop()
  })

  it('IME 组合态：守卫统一前置，Ctrl+F 不动作', () => {
    appendSurface('overlay')
    const { stop } = startOrchestrator()

    window.dispatchEvent(keyEvent('f', { metaKey: true, isComposing: true }))

    expect(useFindInSurface().isOpen.value).toBe(false)
    stop()
  })
})

describe('Esc：查找框是临时覆盖层，先于容器剥层', () => {
  it('查找框开着：Esc 先关查找框（消费事件），容器层不被穿透关闭；再按 Esc 才剥层', () => {
    openBottom()
    const find = useFindInSurface()
    find.open('bottom-drawer')
    const { stop } = startOrchestrator()

    const e1 = pressEsc()
    expect(e1.defaultPrevented).toBe(true)
    expect(find.isOpen.value, 'Esc 先关查找框').toBe(false)
    expect(find.surfaceKind.value).toBe('')
    expect(containerStates().bottom, '容器层不随第一次 Esc 关闭').toBe(true)

    pressEsc()
    expect(containerStates().bottom, '查找框已关，第二次 Esc 正常剥容器层').toBe(false)
    stop()
  })

  it('查找框关态基线：Esc 照常剥层（不吞无查找现场的事件）', () => {
    openBottom()
    const { stop } = startOrchestrator()

    const e = pressEsc()
    expect(e.defaultPrevented).toBe(true)
    expect(containerStates().bottom).toBe(false)
    stop()
  })
})
