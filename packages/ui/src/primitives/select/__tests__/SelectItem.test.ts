/**
 * Select 组件族合并测试产物（round5-g ui idx4）。
 *
 * 来源节（每来源文件包以基名命名的 describe）：
 *   SelectItem / SelectValue
 *
 * 同被测单元 = Select 组件族（reka Select 经 Portal teleport 到 body，两个成员都必须
 * 装配 Select+SelectContent(+SelectTrigger) 整树才能测）。零 vi.mock；mount attachTo
 * body + flushPromises 后 document.body.querySelector 查询，事件用原生 dispatchEvent。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/select/__tests__/SelectItem.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import Select from '../Select.vue'
import SelectTrigger from '../SelectTrigger.vue'
import SelectContent from '../SelectContent.vue'
import SelectItem from '../SelectItem.vue'
import SelectValue from '../SelectValue.vue'

describe('SelectItem', () => {
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
})

describe('SelectValue', () => {
/**
 * SelectValue 组件测试：truncate 收尾链 + title 反射（长选中值 hover 全名补偿）。
 *
 * 覆盖（机制见 SelectValue.vue 注释）：
 * 1. min-w-0 truncate 落在渲染 span（flex 收缩许可 + 省略号，长值不出触发器边界）
 * 2. 选中项渲染后 title = 全名；值变化跟随更新
 * 3. 无选中值（textContent 空）时 title 移除
 *
 * 测试模式同 SelectItem.test.ts：reka Select 经 Portal teleport 到 document.body，
 * mount attachTo body + flushPromises 后用 document.body.querySelector 查询。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/select/__tests__/SelectValue.test.ts
 */

const LONG_NAME = 'BigModel Individual Coding Plan · GLM-5.3-Flash'

/** 挂载 Select（强制 open）：trigger 内 SelectValue + 单个长名选项 */
function mountSelect(initial: string) {
  const v = ref(initial)
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
            default: () => [
              h(SelectTrigger, {}, { default: () => h(SelectValue) }),
              h(SelectContent, {}, {
                default: () =>
                  h(SelectItem, { value: 'glm' }, { default: () => LONG_NAME }),
              }),
            ],
          },
        )
    },
  })
  const wrapper = mount(Wrapper, { attachTo: document.body })
  return { wrapper, value: v }
}

describe('SelectValue', () => {
  it('min-w-0 truncate 落在渲染 span（SelectTrigger flex 行内的裁剪链前提）', async () => {
    mountSelect('')
    await flushPromises()
    const span = document.body.querySelector<HTMLElement>('span.min-w-0.truncate')
    expect(span, '截断 class 应落在 SelectValue 渲染的 span 上').not.toBeNull()
    document.body.innerHTML = ''
  })

  it('title 反射：选中后 title = 全名；无选中值时 title 移除（文本为空）', async () => {
    const { value } = mountSelect('')
    await flushPromises()
    const span = document.body.querySelector<HTMLElement>('span.min-w-0.truncate')!
    // slot 接管渲染：文本与 title 同源（selectedLabel），title 是 span 内层的载体
    const inner = span.querySelector<HTMLElement>(':scope > span')!
    expect(inner.getAttribute('title'), '无选中值不应设 title').toBeNull()

    value.value = 'glm'
    await flushPromises()
    expect(span.textContent, '选中项全名应渲染进 span').toBe(LONG_NAME)
    expect(inner.getAttribute('title'), 'title 应反射全名供 hover 查看').toBe(LONG_NAME)
    document.body.innerHTML = ''
  })

  it('title 跟随值变化更新（值清空 → 移除）', async () => {
    const { value } = mountSelect('glm')
    await flushPromises()
    const inner = document.body.querySelector<HTMLElement>('span.min-w-0.truncate > span')!
    expect(inner.getAttribute('title')).toBe(LONG_NAME)

    value.value = ''
    await flushPromises()
    expect(inner.getAttribute('title'), '值清空后 title 应移除').toBeNull()
    document.body.innerHTML = ''
  })
})
})
