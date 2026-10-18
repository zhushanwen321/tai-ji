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
import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import Select from '../Select.vue'
import SelectTrigger from '../SelectTrigger.vue'
import SelectContent from '../SelectContent.vue'
import SelectItem from '../SelectItem.vue'
import SelectValue from '../SelectValue.vue'

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
