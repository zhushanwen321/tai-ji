/**
 * 生产挂载点接线单测族 —— manifest 成员的宿主组件生产注册（D2 修复组 A · U1）。
 *
 * 背景：聚合注册表（modal-surface-registry）的编排器让位 / ⌘W 守卫 / view 遮蔽联动都读
 * 挂载点注册——u-w1-agg 落地时生产注册仅 SessionList 一处（D2 审查 p3 [17:05]），测试族
 * 全部以手工桩注册 ⇒ 生产挂载点缺口对测试族结构性不可见。本测试族以**真实宿主组件**
 * 挂载对账（非手工桩）：组件挂载即注册、卸载即注销（注册对称性），开合态绑状态本体
 * （reka root context open / toast 在列态），旗标按登记表家族分立。
 *
 * 覆盖形态（每形态选真实宿主，未覆盖宿主走同一接线模式）：
 * - reka 托管弹层族（开合态 = root context open 状态本体，R4 时序前提的直读形态）：
 *   renderer DialogContent / PopoverContent / SelectContent 三包装
 * - Toast 族（开合态 = useToast 在列态本体）
 * - 挂载⇔开型（FormOverlay：v-if 门控挂载，注册随挂载/注销随卸载）
 * - ui 包注册桥（MODAL_SURFACE_REGISTRAR_KEY provide/inject——ui 原语经桥自注册、
 *   未装配桥时静默跳过）
 *
 * 三视角：构建者白盒（注册表条目增删）+ 使用者黑盒（真实交互翻 开/关 → DOM + 旗标联动）
 * + 观察者形态（openShieldingSurfaces 报告逐条可判别）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/modal-surface-registry/production-wiring.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { DialogRoot, PopoverRoot, SelectRoot, SelectTrigger } from 'reka-ui'

import {
  registerModalSurface,
  resetModalSurfaceRegistry,
  isModalSurfaceId,
  anyModalSurfaceYieldsEsc,
  anyModalSurfaceYieldsCmdW,
  openShieldingSurfaces,
  isModalSurfaceOpen,
} from '@/composables/features/app/modal-surface-registry'
import { MODAL_SURFACE_REGISTRAR_KEY, type UiModalSurfaceRegistration } from '@taiji/ui'
import { useToast } from '@/composables/useToast'
import { setActivePinia, createPinia } from 'pinia'

import DialogContentWrapper from '@/components/ui/dialog/DialogContent.vue'
import PopoverContentWrapper from '@/components/ui/popover/PopoverContent.vue'
import SelectContentWrapper from '@/components/ui/select/SelectContent.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import FormOverlay from '@/components/extension/form/FormOverlay.vue'

beforeEach(() => {
  resetModalSurfaceRegistry()
})

enableAutoUnmount(afterEach)

/** 受控 DialogRoot 宿主（消费方形态：Dialog :open + DialogContent 常驻模板） */
function mountDialogHost() {
  const open = ref(false)
  const wrapper = mount(defineComponent({
    setup() {
      return () =>
        h(DialogRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, {
          default: () => h(DialogContentWrapper),
        })
    },
  }))
  return { wrapper, open }
}

describe('reka 托管弹层族（renderer 三包装）：开合态绑 root context open 状态本体', () => {
  it('dialog-confirm：开 → Esc/⌘W 双让位 + shieldsView unconditional；关 → 全复位', async () => {
    const host = mountDialogHost()
    expect(isModalSurfaceOpen('dialog-confirm'), '包装常驻挂载即注册（关态也在册）').toBe(false)
    expect(anyModalSurfaceYieldsEsc()).toBe(false)

    host.open.value = true
    await nextTick()
    expect(isModalSurfaceOpen('dialog-confirm')).toBe(true)
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(true)
    expect(openShieldingSurfaces()).toEqual([{ id: 'dialog-confirm', mode: 'unconditional' }])

    host.open.value = false
    await nextTick()
    expect(isModalSurfaceOpen('dialog-confirm')).toBe(false)
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
    expect(openShieldingSurfaces()).toEqual([])
  })

  it('popover-content：开 → Esc 让位、⌘W 不让位（R4 双键拆分）+ shieldsView intersecting 带 rect', async () => {
    const open = ref(false)
    const wrapper = mount(defineComponent({
      setup() {
        return () =>
          h(PopoverRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, {
            default: () => h(PopoverContentWrapper),
          })
      },
    }))
    void wrapper

    open.value = true
    await nextTick()
    await nextTick()
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
    const report = openShieldingSurfaces()
    expect(report).toHaveLength(1)
    expect(report[0]!.id).toBe('popover-content')
    expect(report[0]!.mode).toBe('intersecting')
    expect(report[0]!.rect, 'rect 由内容根元素实测（happy-dom 全零 rect 仍成键）').toBeDefined()

    open.value = false
    await nextTick()
    await nextTick()
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    expect(openShieldingSurfaces()).toEqual([])
  })

  it('select-content：开 → Esc 让位、⌘W 不让位 + shieldsView intersecting；关 → 复位', async () => {
    const open = ref(false)
    mount(defineComponent({
      setup() {
        return () =>
          h(SelectRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, {
            default: () => [h(SelectTrigger), h(SelectContentWrapper)],
          })
      },
    }))

    open.value = true
    await nextTick()
    await nextTick()
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
    expect(openShieldingSurfaces().map((s) => s.id)).toEqual(['select-content'])

    open.value = false
    await nextTick()
    await nextTick()
    expect(openShieldingSurfaces()).toEqual([])
  })

  it('注册对称性：包装卸载即注销（同 id 多实例互不串扰——实例级 key）', async () => {
    const hostA = mountDialogHost()
    const hostB = mountDialogHost()

    hostA.open.value = true
    await nextTick()
    expect(isModalSurfaceOpen('dialog-confirm')).toBe(true)

    // A 卸载（关态注销），B 仍关——聚合复位；B 开后聚合独立翻转（未串到 A 的闭包状态）
    hostA.wrapper.unmount()
    await nextTick()
    expect(isModalSurfaceOpen('dialog-confirm')).toBe(false)

    hostB.open.value = true
    await nextTick()
    expect(isModalSurfaceOpen('dialog-confirm')).toBe(true)
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
  })
})

describe('ToastContainer：开合态绑 useToast 在列态本体', () => {
  it('入列 → open（intersecting）；清空 → closed；双键都不让位（Toast 不入让位族）', async () => {
    setActivePiniaForToast()
    const wrapper = mount(ToastContainer)
    const { info, remove, toasts } = useToast()
    expect(isModalSurfaceOpen('toast-container')).toBe(false)

    info('遮蔽联动事实源')
    await nextTick()
    await nextTick()
    expect(toasts.value.length).toBe(1)
    expect(isModalSurfaceOpen('toast-container')).toBe(true)
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
    const report = openShieldingSurfaces()
    expect(report).toEqual([{ id: 'toast-container', mode: 'intersecting', rect: expect.anything() }])

    remove(toasts.value[0]!.id)
    await nextTick()
    await nextTick()
    expect(isModalSurfaceOpen('toast-container')).toBe(false)
    expect(openShieldingSurfaces()).toEqual([])
    void wrapper
  })
})

describe('挂载⇔开型（FormOverlay）：注册随挂载 / 注销随卸载', () => {
  it('挂载即在册且 yieldsEsc（面板表单 overlay 打开中）；卸载即注销', async () => {
    const wrapper = mount(FormOverlay, { props: { questions: [{ type: 'text', question: 'q' }] } })
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    expect(isModalSurfaceOpen('form-overlay')).toBe(true)
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(openShieldingSurfaces()).toEqual([{ id: 'form-overlay', mode: 'unconditional' }])

    wrapper.unmount()
    await nextTick()
    expect(isModalSurfaceOpen('form-overlay')).toBe(false)
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
  })
})

describe('ui 包注册桥（MODAL_SURFACE_REGISTRAR_KEY）', () => {
  it('provide 注册桥后，ui 原语挂载即经桥注册、旗标查询联动（App.vue 同款登记红线）', async () => {
    const registrations: UiModalSurfaceRegistration[] = []
    const registrar = (registration: UiModalSurfaceRegistration): (() => void) => {
      registrations.push(registration)
      const { surface, key, isOpen, rect } = registration
      if (!isModalSurfaceId(surface)) {
        throw new Error(`modal-surface-registry: 未登记的表面 id '${surface}'——先在 manifest.ts 登记（§6.7 完备性判据）`)
      }
      return registerModalSurface({ surface, key, isOpen, rect })
    }
    const open = ref(false)
    const wrapper = mount(defineComponent({
      setup() {
        return () =>
          h(PopoverRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, {
            default: () => h(UiPopoverContent),
          })
      },
    }), {
      global: { provide: { [MODAL_SURFACE_REGISTRAR_KEY as symbol]: registrar } },
    })
    void wrapper

    open.value = true
    await nextTick()
    await nextTick()
    expect(registrations.map((r) => r.surface)).toContain('popover-content')
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
  })

  it('未装配桥（无 provide）：ui 原语挂载零注册零副作用', async () => {
    const open = ref(true)
    mount(defineComponent({
      setup() {
        return () =>
          h(PopoverRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, {
            default: () => h(UiPopoverContent),
          })
      },
    }))
    await nextTick()
    await nextTick()
    // ui 原语开态存在（reka 渲染），但注册表零条目——ui 单测 / 非 taiji 宿主零副作用
    expect(openShieldingSurfaces()).toEqual([])
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
  })
})

// ── 测试辅助 ────────────────────────────────────────────────────────────────

import { PopoverContent as UiPopoverContent } from '@taiji/ui'

function setActivePiniaForToast(): void {
  setActivePinia(createPinia())
}
