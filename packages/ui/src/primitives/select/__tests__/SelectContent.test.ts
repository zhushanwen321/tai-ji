/**
 * SelectContent 模态表面注册测试（§6.7 弹出层族）。
 *
 * 覆盖面：provide 注册桥后挂载即注册（surface id 'select-content'）；开合态读点绑
 * reka SelectRoot context 的 open 状态本体（关 → false / 开 → true）；rect 读点两条路径——
 * 内容未挂载（关态）返回 null（上报不带 rect）、开态实测内容根元素返回四元组矩形。
 *
 * 测试模式：注册桥经 global.provide 注入捕获桩（App.vue 同款契约，未装配桥时组件静默
 * 跳过注册——该降级语义由 renderer 侧 production-wiring 测试族覆盖，此处测装配态）。
 * reka Select 经 Portal teleport 到 document.body，attachTo body + nextTick 后查询。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/select/__tests__/SelectContent.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { SelectRoot, SelectTrigger } from 'reka-ui'
import SelectContent from '../SelectContent.vue'
import {
  MODAL_SURFACE_REGISTRAR_KEY,
  type UiModalSurfaceRegistration,
} from '../../../modal-surface-registrar'

/** 挂载 SelectRoot 宿主（可控 open）+ 捕获桩注册桥 */
function mountSelectHost() {
  const registrations: UiModalSurfaceRegistration[] = []
  const open = ref(false)
  const wrapper: VueWrapper = mount(
    defineComponent({
      setup() {
        return () =>
          h(SelectRoot, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, {
            default: () => [h(SelectTrigger), h(SelectContent)],
          })
      },
    }),
    {
      attachTo: document.body,
      global: {
        provide: {
          [MODAL_SURFACE_REGISTRAR_KEY as symbol]: (registration: UiModalSurfaceRegistration) => {
            registrations.push(registration)
            return () => {}
          },
        },
      },
    },
  )
  return { wrapper, registrations, open }
}

describe('SelectContent 模态表面注册（§6.7 弹出层族）', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('挂载即经桥注册；关态 isOpen=false、rect 读点返回 null（内容未挂载不带 rect 上报）', () => {
    const host = mountSelectHost()
    wrapper = host.wrapper

    expect(host.registrations).toHaveLength(1)
    const registration = host.registrations[0]!
    expect(registration.surface).toBe('select-content')
    expect(registration.isOpen(), '开合态绑 root context open（关态）').toBe(false)
    expect(registration.rect?.(), '内容未挂载 → null（主进程保守按相交）').toBeNull()
  })

  it('开态 isOpen 翻转为 true（状态本体直读），rect 实测内容根元素返回四元组矩形', async () => {
    const host = mountSelectHost()
    wrapper = host.wrapper
    const registration = host.registrations[0]!

    host.open.value = true
    await nextTick()
    await nextTick()
    expect(registration.isOpen(), '开合态绑 root context open（开态）').toBe(true)
    const rect = registration.rect?.()
    expect(rect, '内容根元素已挂载（portal 渲染）→ 实测矩形').not.toBeNull()
    expect(Object.keys(rect ?? {}).sort()).toEqual(['height', 'width', 'x', 'y'])
  })
})
