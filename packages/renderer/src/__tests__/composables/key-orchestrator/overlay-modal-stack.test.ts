/**
 * 编排器单测族 · 浮层 × 模态叠开组合的 Tab 属主与 Esc 递进（2026-10-03 用户裁决「Tab 只在
 * 最上层 overlay 生效；每层可 Esc 关、每次只关最上面一层」；登记
 * docs/todo/display-containers-overlay-tab-ownership.md；对账 §6.7 模态共存守卫 / §8.2 S3+S8）。
 *
 * S3 断言半边（单测承载，真实事件序 = dispatchEvent + await nextTick，禁 mock 时序）：
 * - 浮层 + 模态（⌘K 搜索族形态）同开 → Tab 不被浮层陷阱捕获（模态焦点域属主——焦点留在
 *   模态内、defaultPrevented 不置位）；
 * - 对照半边：同装配无模态叠加 → Tab 被陷阱拉回首元素（防逃逸语义不回退，判别态）；
 * - 模态经 Esc 关闭（flush 翻新注册）→ 让位解除，Tab 陷阱恢复（属主判定动作时刻直读，
 *   非永久闩锁）；
 * - Esc 序：Esc#1 关模态（编排器让位，浮层原样）→ Esc#2 关浮层（层级序递进）。
 *
 * 三视角：构建者白盒（聚合让位分支门控）+ 使用者黑盒（activeElement 归属 + 容器开合逐次
 * 翻转）+ 观察者形态（defaultPrevented 消费约定下游可判）。
 *
 * 测试框架：vitest（happy-dom）+ @vue/test-utils（真实组件挂载驱动注册/注销翻新）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/key-orchestrator/
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, onBeforeUnmount, ref } from 'vue'
import { registerModalSurface } from '@/composables/features/app/modal-surface-registry'
import { registerOverlayFocusTrapPanel } from '@/composables/features/app/key-orchestrator'
import {
  bindTestSession,
  containerStates,
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

/** 跨用例存活的挂载 wrapper（afterEach 统一卸载——卸载才摘 window 监听与聚合注册） */
const mountedWrappers: VueWrapper[] = []

/**
 * 模态形态（⌘K 搜索族同构）：挂载⇔开（注册随挂载、注销随卸载）+ Esc 消费方随开态活/死
 * （真实模态关即卸载、监听随之消失——关态守卫是其等价形态）+ 面板内可聚焦元素
 * （Tab 属主判定的焦点锚）。
 */
function mountSearchModalLike(): { input: HTMLElement } {
  const modalOpen = ref(true)
  const SearchModalLike = defineComponent({
    setup() {
      const dispose = registerModalSurface({
        surface: 'search-modal',
        key: 'stack-search-modal',
        isOpen: () => modalOpen.value,
      })
      onBeforeUnmount(dispose)
      const onEsc = (e: KeyboardEvent): void => {
        if (!modalOpen.value) return // 关态无 Esc 消费方（挂载⇔开）
        if (e.key !== 'Escape' || e.defaultPrevented) return
        e.preventDefault()
        modalOpen.value = false
      }
      window.addEventListener('keydown', onEsc)
      onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
      return () =>
        h('div', { 'data-testid': 'stack-search-modal-like' }, [
          h('input', { 'data-testid': 'stack-search-input' }),
        ])
    },
  })
  const wrapper = mount(SearchModalLike, { attachTo: document.body })
  mountedWrappers.push(wrapper)
  const input = wrapper.find('[data-testid="stack-search-input"]').element as HTMLElement
  return { input }
}

beforeEach(() => {
  resetOrchestratorFixtures()
  bindTestSession()
})

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
  resetOrchestratorFixtures()
  document.body.innerHTML = ''
})

describe('叠开组合：Tab 属主 = 最上层表面（2026-10-03 用户裁决）', () => {
  it('浮层 + 模态同开：Tab 不被浮层陷阱捕获（焦点留在模态内、不 preventDefault）', () => {
    const { panel } = makePanel(2)
    registerOverlayFocusTrapPanel(panel)
    openWorkflowOverlay()
    const { stop } = startOrchestrator()
    const { input } = mountSearchModalLike()

    input.focus()
    const e = keyEvent('Tab')
    window.dispatchEvent(e)

    expect(document.activeElement, '焦点留在模态输入框（陷阱未把焦点拉回浮层面板）').toBe(input)
    expect(e.defaultPrevented, '编排器让位不消费——模态焦点域自行处理 Tab').toBe(false)
    stop()
  })

  it('对照半边（判别态）：同装配仅无模态叠加 → Tab 被陷阱拉回首元素', () => {
    const { panel, buttons } = makePanel(2)
    registerOverlayFocusTrapPanel(panel)
    openWorkflowOverlay()
    const { stop } = startOrchestrator()

    document.body.focus()
    window.dispatchEvent(keyEvent('Tab'))
    expect(document.activeElement, '无模态叠加时陷阱照常生效（防逃逸语义不回退）').toBe(buttons[0])
    stop()
  })

  it('让位解除：模态 Esc 关闭 + flush 翻新后 → Tab 陷阱恢复（属主动作时刻直读）', async () => {
    const { panel, buttons } = makePanel(2)
    registerOverlayFocusTrapPanel(panel)
    openWorkflowOverlay()
    const { stop } = startOrchestrator()
    const { input } = mountSearchModalLike()

    input.focus()
    window.dispatchEvent(keyEvent('Escape'))
    await nextTick()
    await nextTick()
    expect(containerStates().overlay, 'Esc#1 只关模态（编排器让位），浮层原样').toBe(true)

    input.focus()
    window.dispatchEvent(keyEvent('Tab'))
    expect(document.activeElement, '模态关后 Tab 陷阱恢复——拉回浮层面板首元素').toBe(buttons[0])
    stop()
  })
})

describe('叠开组合：Esc 递进（每次只关最上面一层）', () => {
  it('浮层 + 模态同开：Esc#1 关模态（浮层原样）→ Esc#2 关浮层', async () => {
    openWorkflowOverlay()
    const { stop } = startOrchestrator()
    mountSearchModalLike()

    window.dispatchEvent(keyEvent('Escape'))
    await nextTick()
    expect(containerStates(), 'Esc#1 编排器让位——模态自消费，浮层/抽屉原样')
      .toEqual({ overlay: true, bottom: false, right: false })

    window.dispatchEvent(keyEvent('Escape'))
    await nextTick()
    expect(containerStates(), 'Esc#2 模态已关——层级序剥浮层')
      .toEqual({ overlay: false, bottom: false, right: false })

    stop()
  })
})
