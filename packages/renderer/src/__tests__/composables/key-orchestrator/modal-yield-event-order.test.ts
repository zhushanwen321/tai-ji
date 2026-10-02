/**
 * 编排器单测族 · 模态共存让位与聚合让位真实事件序（display-containers §6.7 模态共存守卫 +
 * R4 时序前提 / §8.2「聚合让位真实事件序」，对账 S8）。
 *
 * S8 断言半边（单测承载，真实事件序 = dispatchEvent + await nextTick，禁 mock 时序）：
 * - 设置页（yieldsEsc/yieldsCmdW ✓）开着：第一次 Esc 只关设置页、两个抽屉原样不动
 *   （编排器聚合让位 + 模态自己的 Esc 消费方动作）；再按 Esc 才按层级序关底抽屉（让位递进）；
 * - 弹出层族（yieldsEsc ✓）开着：Esc 让位、reka 式 dismiss 后（flush 翻新注册）第二次 Esc
 *   才走层级序——R4 时序前提「编排器先行 + flush 翻新」以真实事件序对账；
 * - Toast（yieldsEsc ✗，仅 shieldsView）显示期：Esc 照常走层级序（不消费 Esc）；
 * - defaultPrevented 先检：先行档消费方已消费（preventDefault）→ 编排器不动作。
 *
 * 测试框架：vitest（happy-dom）+ @vue/test-utils（真实组件挂载驱动注册/注销翻新）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/key-orchestrator/
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, onBeforeUnmount, ref } from 'vue'
import { registerModalSurface } from '@/composables/features/app/modal-surface-registry'
import {
  bindTestSession,
  containerStates,
  keyEvent,
  openBottom,
  openRight,
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

describe('S8 模态共存（Esc 让位 + 让位递进）', () => {
  it('设置页开着：第一次 Esc 只关设置页（两抽屉原样）→ 第二次 Esc 才关底抽屉', async () => {
    // 设置页形态：挂载⇔开（注册随挂载）+ 自带 window 级 Esc 消费方（后行注册，SettingsModal
    // 同款：先检 defaultPrevented 再 preventDefault）
    const modalOpen = ref(true)
    const dismisses = ref(0)
    const SettingsLike = defineComponent({
      setup() {
        const dispose = registerModalSurface({
          surface: 'settings-modal',
          key: 's8-settings',
          isOpen: () => modalOpen.value,
        })
        onBeforeUnmount(dispose)
        const onEsc = (e: KeyboardEvent): void => {
          if (e.key !== 'Escape' || e.defaultPrevented) return
          e.preventDefault()
          dismisses.value += 1
          modalOpen.value = false
        }
        window.addEventListener('keydown', onEsc)
        onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
        return () => h('div', { 'data-testid': 's8-settings-like' }, 'settings')
      },
    })

    openBottom()
    openRight()
    const { stop } = startOrchestrator()
    const wrapper = mount(SettingsLike, { attachTo: document.body })
    await nextTick()

    pressEsc()
    await nextTick()
    expect(dismisses.value, '设置页自己的 Esc 消费方动作（视觉最外层）').toBe(1)
    expect(containerStates(), '两个抽屉原样不变（编排器让位守卫）')
      .toEqual({ overlay: false, bottom: true, right: true })

    pressEsc()
    await nextTick()
    expect(containerStates(), '让位递进：设置关后第二次 Esc 按层级序关底抽屉')
      .toEqual({ overlay: false, bottom: false, right: true })

    wrapper.unmount()
    stop()
  })

  it('Toast 显示期（yieldsEsc ✗）：Esc 照常走层级序关容器（Toast 不消费 Esc）', () => {
    const dispose = registerModalSurface({
      surface: 'toast-container',
      key: 's8-toast',
      isOpen: () => true,
    })
    openRight()
    const { stop } = startOrchestrator()

    pressEsc()
    expect(containerStates().right, 'Toast 显示期 Esc 关右抽屉').toBe(false)
    stop()
    dispose()
  })

  it('defaultPrevented 先检：先行档消费方已消费的 Esc 不触发层级序', () => {
    openBottom()
    const { stop } = startOrchestrator()
    // 先行档（window capture，CommandPopover/AmbiguousFilePopover 形态）：消费即 preventDefault
    const firstTier = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') e.preventDefault()
    }
    window.addEventListener('keydown', firstTier, true)

    pressEsc()
    expect(containerStates().bottom, '已消费的 Esc 不再剥层').toBe(true)

    window.removeEventListener('keydown', firstTier, true)
    stop()
  })
})

describe('S8/R4 聚合让位真实事件序（reka 弹出层族形态）', () => {
  it('第一次 Esc 让位（弹层还开着）→ dismiss + flush 注销 → 第二次 Esc 才走层级序', async () => {
    // 弹层成员：挂载⇔开（注册随挂载、注销随卸载——开合态翻新走 flush 的实装形态）；
    // 自带 dismiss 监听（后行注册，reka DismissableLayer 同款：只关自己、不 preventDefault）
    const surfaceOpen = ref(true)
    const dismisses = ref(0)
    const PopoverLike = defineComponent({
      setup() {
        const dispose = registerModalSurface({
          surface: 'popover-content',
          key: 'r4-popover',
          isOpen: () => true,
        })
        onBeforeUnmount(dispose)
        const onDismiss = (e: KeyboardEvent): void => {
          if (e.key !== 'Escape') return
          dismisses.value += 1
          surfaceOpen.value = false
        }
        window.addEventListener('keydown', onDismiss)
        onBeforeUnmount(() => window.removeEventListener('keydown', onDismiss))
        return () => h('div', { 'data-testid': 'r4-popover-like' }, 'popover')
      },
    })
    const PopoverHost = defineComponent({
      setup: () => () => (surfaceOpen.value ? h(PopoverLike) : null),
    })

    openBottom()
    // 编排器先注册（AppShell 根 setup 位次），FIFO 同相位先于弹层挂载后的任何监听
    const { stop } = startOrchestrator()
    const wrapper = mount(PopoverHost, { attachTo: document.body })
    await nextTick()

    pressEsc()
    await nextTick()
    expect(dismisses.value, '第一次 Esc 由弹层 dismiss 消费（视觉最外层有递进）').toBe(1)
    expect(containerStates().bottom, '编排器让位——底抽屉原样').toBe(true)

    // flush 翻新：弹层卸载 → 注册注销 → 聚合已是「弹层已关」的正确态
    await nextTick()
    await nextTick()

    pressEsc()
    await nextTick()
    expect(containerStates().bottom, '第二次 Esc 走层级序关底抽屉').toBe(false)

    wrapper.unmount()
    stop()
  })
})
