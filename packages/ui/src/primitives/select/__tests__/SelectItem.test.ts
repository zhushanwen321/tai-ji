/**
 * SelectItem 组件测试（W3 · review batch 1 · MF-3）。
 *
 * 覆盖 #action slot 的 [HISTORICAL] 回归修复（3 个 bug）：
 * 1. 宽度抖动→popper 重定位：action 容器 absolute 脱离文档流（不再占 flex 宽度）
 * 2. opacity transition→位置重算：移除 transition，action 始终可见
 * 3. reka pointerup 选中：action 容器 pointerdown/pointerup/click 三重 stop
 *
 * 测试模式：reka Select 经 Portal teleport 到 document.body，mount attachTo body +
 * flushPromises 后用 document.body.querySelector 查询；事件用原生 dispatchEvent。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/select/__tests__/SelectItem.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import Select from '../Select.vue'
import SelectContent from '../SelectContent.vue'
import SelectItem from '../SelectItem.vue'

/** 挂载 Select（强制 open），可配置 SelectItem 是否带 #action slot */
function mountSelect(opts: { withAction?: boolean; value?: string } = {}) {
  const { withAction = true, value = '' } = opts
  const v = ref(value)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(
          Select,
          {
            modelValue: v.value,
            open: true,
            // reka AcceptableValue 含 number/boolean/null，测试仅用 string 值 → 收窄赋值
            'onUpdate:modelValue': (x: unknown) => {
              if (typeof x === 'string') v.value = x
            },
          },
          {
            default: () =>
              h(SelectContent, {}, {
                default: () =>
                  h(
                    SelectItem,
                    { value: 'a' },
                    {
                      default: () => 'Item A',
                      ...(withAction
                        ? {
                            action: () =>
                              h(
                                'button',
                                { type: 'button', 'data-testid': 'action-btn' },
                                '试听',
                              ),
                          }
                        : {}),
                    },
                  ),
              }),
          },
        )
    },
  })
  const wrapper = mount(Wrapper, { attachTo: document.body })
  return { wrapper, value: v }
}

async function open() {
  await flushPromises()
}

describe('SelectItem #action slot', () => {
  it('v-if 条件渲染：传 #action → 渲染 action 容器 + slot 内容；不传 → 不渲染', async () => {
    // 传 #action
    mountSelect({ withAction: true })
    await open()
    expect(document.body.querySelector('[data-testid="action-btn"]')).not.toBeNull()
    document.body.innerHTML = ''

    // 不传 #action
    mountSelect({ withAction: false })
    await open()
    expect(document.body.querySelector('[data-testid="action-btn"]')).toBeNull()
    document.body.innerHTML = ''
  })

  it('[HISTORICAL bug1/2] action 容器 absolute 脱离文档流（不占 flex 宽度、无 opacity transition）', async () => {
    mountSelect({ withAction: true })
    await open()
    const btn = document.body.querySelector<HTMLElement>('[data-testid="action-btn"]')!
    const wrap = btn.parentElement!
    // absolute：脱离 flex 文档流（修复宽度抖动→popper 重定位）
    expect(wrap.className).toContain('absolute')
    // 无 opacity transition（修复 transition→位置重算）
    expect(wrap.className).not.toContain('opacity-0')
    document.body.innerHTML = ''
  })

  it('[HISTORICAL bug3] action 按钮 pointerup/click 不选中该项（三重 stop 防误选）', async () => {
    const { value } = mountSelect({ withAction: true })
    await open()
    const btn = document.body.querySelector<HTMLElement>('[data-testid="action-btn"]')!
    // reka SelectItem 靠 pointerup 触发选中；.stop 阻止冒泡 → 不应选中
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(value.value, '点 action 按钮不应选中该项').toBe('')
    document.body.innerHTML = ''
  })

  it('对照：点击不带 action 的选项正常选中（证明 pointerup→select 通路工作，仅 .stop 守护 action）', async () => {
    const { value } = mountSelect({ withAction: false })
    await open()
    // 找到 SelectItem 根元素（reka 渲染 role=option）
    const item = document.body.querySelector<HTMLElement>('[role="option"]')!
    expect(item).not.toBeNull()
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await flushPromises()
    expect(value.value, '正常点击应选中 a').toBe('a')
    document.body.innerHTML = ''
  })
})
