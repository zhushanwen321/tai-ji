/**
 * 聚合单测族 · 双键旗标语义（display-containers §6.7 登记表双键列 / §8.2 验收条款 1）。
 *
 * 对账锚（§8.2 S7/S8 断言的单测化）：
 * - 模态族（settings-modal）开着 ⇒ Esc 让位 + ⌘W 让位（S8「设置页开着按 ⌘W 无动作」）；
 * - 弹出层族（popover-content）开着 ⇒ Esc 让位、**⌘W 不让位**（S7「Select 开着按 ⌘W 照常
 *   按层级序关最外层容器」——R4 双键拆分）；
 * - Toast 族开着 ⇒ 双键都不让位（S8「Toast 显示期 Esc 照常走层级序」）；
 * - shieldsView 分档（unconditional / intersecting / none）同源读取（S9 view 遮蔽联动的数据源）。
 *
 * 三视角：构建者白盒（refCount / 登记红线）+ 使用者黑盒（挂载点按钮开合 → DOM 状态文本 +
 * 旗标查询联动）+ 观察者形态（关合后旗标全复位）。
 *
 * 测试框架：vitest + @vue/test-utils。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/modal-surface-registry/registry-flags.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, onBeforeUnmount, ref } from 'vue'
import {
  registerModalSurface,
  anyModalSurfaceYieldsEsc,
  anyModalSurfaceYieldsCmdW,
  openShieldingSurfaces,
  isModalSurfaceOpen,
  resetModalSurfaceRegistry,
  type ModalSurfaceId,
} from '@/composables/features/app/modal-surface-registry'

/** 挂载点模拟：一个带开合按钮的表面（挂载即注册、卸载即注销，DOM 显示当前开合态） */
function mountSurface(surface: ModalSurfaceId, key: string) {
  const open = ref(false)
  const wrapper = mount(defineComponent({
    setup() {
      const dispose = registerModalSurface({ surface, key, isOpen: () => open.value })
      onBeforeUnmount(dispose)
      return () =>
        h('div', [
          h('button', { 'data-testid': `toggle-${key}`, onClick: () => { open.value = !open.value } }, 'toggle'),
          h('span', { 'data-testid': `state-${key}` }, open.value ? 'open' : 'closed'),
        ])
    },
  }))
  return { wrapper, open }
}

beforeEach(() => {
  resetModalSurfaceRegistry()
})

describe('双键旗标（yieldsEsc / yieldsCmdW）按家族分立', () => {
  it('模态族开着：Esc 让位 + ⌘W 让位（S8 锚）；关合后复位', async () => {
    const { wrapper } = mountSurface('settings-modal', 'modal')
    expect(wrapper.get('[data-testid="state-modal"]').text()).toBe('closed')
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)

    await wrapper.get('[data-testid="toggle-modal"]').trigger('click')
    expect(wrapper.get('[data-testid="state-modal"]').text()).toBe('open')
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(true)

    await wrapper.get('[data-testid="toggle-modal"]').trigger('click')
    expect(wrapper.get('[data-testid="state-modal"]').text()).toBe('closed')
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
  })

  it('弹出层族开着：Esc 让位但 ⌘W 不让位（S7「Select 开着按 ⌘W 照常关容器」R4 双键拆分锚）', async () => {
    const { wrapper } = mountSurface('popover-content', 'pop')
    await wrapper.get('[data-testid="toggle-pop"]').trigger('click')
    expect(wrapper.get('[data-testid="state-pop"]').text()).toBe('open')
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
  })

  it('Toast 族开着：双键都不让位（S8「Toast 显示期 Esc 照常走层级序」锚）', async () => {
    const { wrapper } = mountSurface('toast-container', 'toast')
    await wrapper.get('[data-testid="toggle-toast"]').trigger('click')
    expect(wrapper.get('[data-testid="state-toast"]').text()).toBe('open')
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
  })

  it('多成员混开：任一让位族成员开着即让位（模态 + 弹层 + Toast 同开）', async () => {
    const modal = mountSurface('settings-modal', 'm')
    const pop = mountSurface('popover-content', 'p')
    const toast = mountSurface('toast-container', 't')
    await toast.wrapper.get('[data-testid="toggle-t"]').trigger('click')
    expect(anyModalSurfaceYieldsEsc()).toBe(false)
    await pop.wrapper.get('[data-testid="toggle-p"]').trigger('click')
    expect(anyModalSurfaceYieldsEsc()).toBe(true)
    expect(anyModalSurfaceYieldsCmdW()).toBe(false)
    await modal.wrapper.get('[data-testid="toggle-m"]').trigger('click')
    expect(anyModalSurfaceYieldsCmdW()).toBe(true)
  })
})

describe('shieldsView 分档报告（S9 view 遮蔽联动的数据源）', () => {
  it('全屏阻塞面 = unconditional；弹出层/横幅 = intersecting；行内确认态 = none 不参报', async () => {
    const modal = mountSurface('search-modal', 'sm')
    const banner = mountSurface('rolling-restart-banner', 'rb')
    const confirm = mountSurface('session-delete-confirm', 'sc')
    expect(openShieldingSurfaces()).toEqual([])

    await modal.wrapper.get('[data-testid="toggle-sm"]').trigger('click')
    await banner.wrapper.get('[data-testid="toggle-rb"]').trigger('click')
    await confirm.wrapper.get('[data-testid="toggle-sc"]').trigger('click')

    const report = openShieldingSurfaces().sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(report).toEqual([
      { id: 'rolling-restart-banner', mode: 'intersecting' },
      { id: 'search-modal', mode: 'unconditional' },
    ])
  })
})

describe('注册红线与 refCount（构建者白盒）', () => {
  it('未登记表面 id 注册即抛错（新增表面必须先入登记表）', () => {
    expect(() =>
      registerModalSurface({ surface: 'not-registered' as ModalSurfaceId, key: 'x', isOpen: () => true }),
    ).toThrow(/未登记|not-registered|manifest/)
  })

  it('同 key 不同表面：拒绝复用（防 key 冲突静默换主）', () => {
    registerModalSurface({ surface: 'settings-modal', key: 'shared', isOpen: () => true })
    expect(() =>
      registerModalSurface({ surface: 'popover-content', key: 'shared', isOpen: () => true }),
    ).toThrow()
  })

  it('refCount 防重复注册：同 key 双注册，注销一次不摘除、归零才移除、注销幂等', () => {
    const open = ref(true)
    const dispose1 = registerModalSurface({ surface: 'settings-modal', key: 'dup', isOpen: () => open.value })
    const dispose2 = registerModalSurface({ surface: 'settings-modal', key: 'dup', isOpen: () => open.value })
    expect(isModalSurfaceOpen('settings-modal')).toBe(true)

    dispose1()
    dispose1() // 幂等：重复注销只生效一次
    expect(isModalSurfaceOpen('settings-modal'), 'refCount 未归零不得摘除').toBe(true)

    open.value = false
    expect(isModalSurfaceOpen('settings-modal')).toBe(false)
    open.value = true

    dispose2()
    expect(isModalSurfaceOpen('settings-modal'), '归零后移除').toBe(false)
  })
})
