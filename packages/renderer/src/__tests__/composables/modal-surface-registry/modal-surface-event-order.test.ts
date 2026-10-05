/**
 * 聚合单测族 · 真实事件序对账（display-containers §6.7 R4 时序前提 / §8.2 验收条款 1）。
 *
 * 以**真实事件序**（window/document dispatchEvent + await nextTick）对账 §6.7 的两条时序
 * 命题，不以 mock 时序：
 *
 * A. 「编排器先行 + flush 翻新」形态（reka 弹出层族）：编排器 window bubble 监听注册于
 *    AppShell 根 setup（先于任何弹层挂载——FIFO 同相位下编排器先执行让位判定、reka 后行
 *    dismiss）；聚合开合态翻新走 Vue 响应式 flush（微任务）——真实输入的相邻按键跨宏任务，
 *    flush 必先完成 ⇒ 第一次 Esc 让位、第二次 Esc 时聚合已是「弹层已关」的正确态。
 *
 * B. 「document 先行消费方同步清态」反例（PlanCommentPopover 形态）：document 级监听在
 *    window bubble 之前执行并**同步**清状态本体 ⇒ 聚合直读同一事件会读到「已关」进层级序
 *    （双动作击穿点）——故该档成员必须走先行档契约（消费即 preventDefault），不能依赖聚合。
 *    反例用例把退化形态钉在测试里（不 preventDefault ⇒ 同一 Esc 双动作），证明契约的必要性。
 *
 * 三视角：构建者白盒（监听注册序 / flush 点）+ 使用者黑盒（DOM 开合态随事件翻转）+
 * 观察者形态（编排器决策序列 yield→act 逐次可判别）。
 *
 * 测试框架：vitest + @vue/test-utils（无 fake timer——纯事件序 + nextTick flush）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/modal-surface-registry/modal-surface-event-order.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, onBeforeUnmount, ref } from 'vue'
import {
  registerModalSurface,
  anyModalSurfaceYieldsEsc,
  resetModalSurfaceRegistry,
} from '@/composables/features/app/modal-surface-registry'

/** 编排器模拟（§6.7 守卫两重：defaultPrevented 先检 → 聚合让位 → 层级序剥层） */
type Decision = 'skip-prevented' | 'yield' | 'act'
const decisions: Decision[] = []
function onOrchestratorKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (e.defaultPrevented) {
    decisions.push('skip-prevented')
    return
  }
  if (anyModalSurfaceYieldsEsc()) {
    decisions.push('yield')
    return
  }
  decisions.push('act')
}

function esc(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
}

beforeEach(() => {
  resetModalSurfaceRegistry()
  decisions.length = 0
})

afterEach(() => {
  window.removeEventListener('keydown', onOrchestratorKeydown)
  document.body.innerHTML = ''
})

describe('A. 编排器先行 + flush 翻新（reka 弹出层族形态）', () => {
  it('第一次 Esc 让位（弹层还开着）→ flush 后聚合已关 → 第二次 Esc 才走层级序', async () => {
    // 编排器先注册（AppShell 根 setup 位次），FIFO 同相位先于弹层挂载后的任何监听
    window.addEventListener('keydown', onOrchestratorKeydown)

    const surfaceOpen = ref(true)
    const dismisses = ref(0)
    // 弹层成员：挂载⇔开（注册随挂载、注销随卸载——开合态翻新走 flush 的实装形态）；
    // 自带 dismiss 监听（后行注册，reka DismissableLayer 同款：只关自己、不 preventDefault）
    const Surface = defineComponent({
      setup() {
        const dispose = registerModalSurface({
          surface: 'popover-content',
          key: 'evt-popover',
          isOpen: () => true,
        })
        onBeforeUnmount(dispose)
        const onDismiss = (): void => {
          dismisses.value += 1
          surfaceOpen.value = false
        }
        window.addEventListener('keydown', onDismiss)
        onBeforeUnmount(() => window.removeEventListener('keydown', onDismiss))
        return () => h('div', { 'data-testid': 'surface' }, '弹层开着')
      },
    })
    const Host = defineComponent({
      setup() {
        return () => h('div', surfaceOpen.value ? h(Surface) : h('span', { 'data-testid': 'surface-gone' }, '弹层已关'))
      },
    })
    const wrapper = mount(Host, { attachTo: document.body })

    // 用户可见 DOM：弹层在场
    expect(document.querySelector('[data-testid="surface"]')).not.toBeNull()
    expect(anyModalSurfaceYieldsEsc()).toBe(true)

    // 第一次 Esc（真实事件）
    window.dispatchEvent(esc())
    expect(decisions).toEqual(['yield'])
    expect(dismisses.value).toBe(1)
    expect(surfaceOpen.value, 'dismiss 已置关（更新在 flush）').toBe(false)

    // flush（微任务）：卸载 + 注销完成——真实输入的相邻按键跨宏任务，此间必收敛
    await nextTick()
    expect(document.querySelector('[data-testid="surface"]'), '弹层 DOM 已卸').toBeNull()
    expect(document.querySelector('[data-testid="surface-gone"]')).not.toBeNull()
    expect(anyModalSurfaceYieldsEsc(), '第二次按键前聚合已是已关').toBe(false)

    // 第二次 Esc：让位不再发生，层级序剥层
    window.dispatchEvent(esc())
    expect(decisions).toEqual(['yield', 'act'])
    expect(dismisses.value, '弹层已关后不再消费 Esc').toBe(1)

    wrapper.unmount()
  })
})

describe('B. document 先行消费方同步清态（PlanCommentPopover 形态反例）', () => {
  const onBeforeUnmountCleanup: Array<() => void> = []

  afterEach(() => {
    while (onBeforeUnmountCleanup.length > 0) onBeforeUnmountCleanup.pop()!()
  })

  /** 文档级消费方模拟：先行于 window bubble 执行；withPreventDefault=真=先行档契约，假=退化形态 */
  function mountDocConsumer(withPreventDefault: boolean): { selOpen: () => boolean } {
    const selOpen = ref(true)
    registerModalSurface({
      surface: 'form-overlay',
      key: 'evt-doc-surface',
      isOpen: () => selOpen.value,
    })
    const onDocKeydown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !selOpen.value) return
      if (withPreventDefault) e.preventDefault()
      selOpen.value = false // 同步清状态本体（dismiss 同款）
    }
    document.addEventListener('keydown', onDocKeydown)
    onBeforeUnmountCleanup.push(() => document.removeEventListener('keydown', onDocKeydown))
    return { selOpen: () => selOpen.value }
  }

  it('不 preventDefault（退化形态）：编排器读到「已关」进层级序——同一 Esc 双动作击穿', () => {
    window.addEventListener('keydown', onOrchestratorKeydown)
    const consumer = mountDocConsumer(false)

    // 事件派发到 document（传播路径 document → window bubble：document 监听先执行）
    document.dispatchEvent(esc())
    expect(consumer.selOpen(), '文档级消费方已同步清态').toBe(false)
    // 退化形态断言：聚合直读已关 ⇒ 编排器在**同一 Esc** 上再剥一层容器（双动作）
    expect(decisions).toEqual(['act'])
  })

  it('preventDefault（先行档契约）：编排器守卫一跳过——一次 Esc 单动作', () => {
    window.addEventListener('keydown', onOrchestratorKeydown)
    const consumer = mountDocConsumer(true)

    document.dispatchEvent(esc())
    expect(consumer.selOpen(), '浮条/浮层已关').toBe(false)
    expect(decisions, 'defaultPrevented 已置位 ⇒ 编排器不动作').toEqual(['skip-prevented'])
  })
})
