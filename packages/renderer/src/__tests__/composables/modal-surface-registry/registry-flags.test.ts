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
import { defineComponent, h, nextTick, onBeforeUnmount, ref } from 'vue'
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

  it('三实例交接（D3 S9 真机实锤回归）：rect 读点随最新活实例覆盖，交接窗口不指死实例、归零后重注册起新条目', async () => {
    // 形态还原：ToastContainer 以固定 key 'toast-container' 在 App.vue(connecting 态) →
    // PanelContainer / MainPanel 三挂载点交接——新实例先注册、旧实例后注销（Vue 挂载点
    // 切换的真实事件序，真实组件 mount/unmount 驱动注册/注销，非手工桩时序）。
    // 旧缺陷：refCount 条目保留首注册者 getters ⇒ 活实例注册后读点仍指已卸载实例
    // （containerRef=null ⇒ rect 恒 null ⇒ main 侧保守恒相交，几何相交判定失效）。
    // 每实例 rect 带实例序号标记（x=序号），卸载后 el=null ⇒ 死实例 getter 返回 null——
    // 三种形态（死实例=null / 首注册者=1 / 活实例=2,3）可判别。
    let instanceSeq = 0
    function mountToastInstance() {
      const seq = ++instanceSeq
      const el = ref<HTMLElement | null>(null)
      const visible = ref(false)
      const wrapper = mount(defineComponent({
        setup() {
          const dispose = registerModalSurface({
            surface: 'toast-container',
            key: 'toast-container',
            isOpen: () => visible.value,
            rect: () => (el.value ? { x: seq, y: 0, width: 100, height: 40 } : null),
          })
          onBeforeUnmount(dispose)
          return () => h('div', { ref: el, 'data-testid': `toast-host-${seq}` })
        },
      }))
      return { wrapper, visible, seq }
    }
    const reportedXs = () => openShieldingSurfaces().map((s) => s.rect?.x ?? null)

    // ① 实例 A 注册并开：rect = A（x=1）
    const a = mountToastInstance()
    a.visible.value = true
    await nextTick()
    expect(reportedXs(), '单实例在册：读点 = A').toEqual([1])

    // ② 实例 B 注册（交接窗口开启——A 尚未注销）+ 开：条目读点立即覆盖为 B（最新注册者 wins）
    const b = mountToastInstance()
    b.visible.value = true
    await nextTick()
    expect(reportedXs(), '交接窗口内读点必须已切到 B，不得保留首注册者 A').toEqual([2])

    // ③ 实例 A 注销（refCount 2→1，条目保留）：rect 仍 = B 活实例——
    //    A 已卸载（el=null ⇒ 其 getter 返回 null），读点若残留 A 则 rect 键直接消失
    a.wrapper.unmount()
    await nextTick()
    expect(reportedXs(), '交接完成：读点 = 活实例 B，死实例 A（null）不得浮现').toEqual([2])
    expect(isModalSurfaceOpen('toast-container'), 'refCount 未归零条目保留').toBe(true)

    // ④ 实例 B 注销（refCount 归零 → 条目摘除，「挂载⇔开」语义保持）
    b.wrapper.unmount()
    await nextTick()
    expect(openShieldingSurfaces()).toEqual([])
    expect(isModalSurfaceOpen('toast-container'), '归零后摘除').toBe(false)

    // ⑤ 实例 C 重注册（摘除后全新条目）并开：读点 = C（x=3）
    const c = mountToastInstance()
    c.visible.value = true
    await nextTick()
    expect(reportedXs(), '重注册起新条目：读点 = C').toEqual([3])

    // 收尾：卸载 C，不给后续用例留活条目（beforeEach 也有 reset 兜底）
    c.wrapper.unmount()
    await nextTick()
    expect(isModalSurfaceOpen('toast-container')).toBe(false)
  })
})
