/**
 * tray-order 排序纯函数测试（u-tray-widget；设计 docs/design/composer-task-tray.md §3.3 D6）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：known-order 优先 / 未知 key 按传入数组序追加 / 不改入参 / 输入缺失 known
 *   key 不产生幽灵条目；「当前插入序」契约用真 Map 的 delete+set 序列钉死（invalidate →
 *   重注册落尾部；D6 明确不新增 seq 字段）
 * - 使用者（黑盒）：DOM 视角——排序结果即用户看到的按钮顺序（本文件末尾的渲染栈用例）；
 *   完整交互/DOM 断言在 tray-widget.test.ts
 * - 观察者（形态）：本文件为纯逻辑面，形态断言（按钮/面板/testid）归 tray-widget.test.ts
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/tray/tray-order.test.ts
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, reactive } from 'vue'
import { TRAY_WIDGET_KNOWN_ORDER, orderTrayWidgetIds } from '@/components/panel/tray/tray-order'

describe('orderTrayWidgetIds（D6：known-order + 当前插入序）', () => {
  it('known-order 优先：todo 恒在 goal 前，与传入数组序无关', () => {
    expect(orderTrayWidgetIds(['goal', 'todo'])).toEqual(['todo', 'goal'])
    expect(orderTrayWidgetIds(['todo', 'goal'])).toEqual(['todo', 'goal'])
    // 前置顺序来源是常量表（外部可读，作为宿主契约的单一登记处）
    expect(TRAY_WIDGET_KNOWN_ORDER).toEqual(['todo', 'goal'])
  })

  it('未知 key 按传入数组序追加在 known-order 之后', () => {
    expect(orderTrayWidgetIds(['custom-b', 'todo', 'custom-a', 'goal'])).toEqual([
      'todo',
      'goal',
      'custom-b',
      'custom-a',
    ])
  })

  it('known-order 缺失即跳过，不产生幽灵条目', () => {
    expect(orderTrayWidgetIds(['todo', 'only-custom'])).toEqual(['todo', 'only-custom'])
    expect(orderTrayWidgetIds(['only-custom'])).toEqual(['only-custom'])
    expect(orderTrayWidgetIds([])).toEqual([])
  })

  it('纯函数：不改入参、每次返回新数组', () => {
    const input = ['goal', 'todo', 'x']
    const out = orderTrayWidgetIds(input)
    expect(input).toEqual(['goal', 'todo', 'x'])
    expect(out).not.toBe(input)
    expect(orderTrayWidgetIds(input)).not.toBe(out)
  })

  it('「当前插入序」契约：invalidate 后重注册的未知 key 落尾部（Map delete+set 语义）', () => {
    // ViewHostStore 内部 Map 的插入序 = getViewIds 返回数组序（ECMAScript 规范语义）
    const views = new Map<string, number>()
    views.set('todo', 1)
    views.set('goal', 2)
    views.set('alpha', 3)
    views.set('beta', 4)
    const order = () => orderTrayWidgetIds([...views.keys()])
    expect(order()).toEqual(['todo', 'goal', 'alpha', 'beta'])

    // widget 清屏（setWidget(key, undefined) → invalidate → 删键）
    views.delete('alpha')
    expect(order()).toEqual(['todo', 'goal', 'beta'])

    // 重注册 = 新插入键 → 落到尾部（不回原位；宿主不新增 seq 字段）
    views.set('alpha', 5)
    expect(order()).toEqual(['todo', 'goal', 'beta', 'alpha'])
  })

  it('known-order 内的 key 不受重注册影响：清屏重注册后仍在最前位', () => {
    const views = new Map<string, number>()
    views.set('custom', 1)
    views.set('goal', 2)
    views.delete('goal')
    views.set('goal', 3)

    // goal 的 Map 位置已移到 custom 之后，但 known-order 把它拉回前置位
    expect([...views.keys()]).toEqual(['custom', 'goal'])
    expect(orderTrayWidgetIds([...views.keys()])).toEqual(['goal', 'custom'])
  })
})

// ── 使用者视角：排序结果 = 用户看到的按钮顺序（渲染栈最小复刻）──
describe('orderTrayWidgetIds 渲染栈（观察者视角：顺序即 DOM 顺序）', () => {
  it('响应式 viewIds 变化后，DOM 顺序随排序结果重算', async () => {
    const state = reactive({ viewIds: ['custom-b', 'goal', 'custom-a', 'todo'] })
    const host = defineComponent({
      setup() {
        const ordered = computed(() => orderTrayWidgetIds(state.viewIds))
        return () =>
          h(
            'div',
            { 'data-testid': 'tray-order-strip' },
            ordered.value.map((id) => h('span', { 'data-testid': 'tray-order-item', key: id }, id)),
          )
      },
    })
    const wrapper = mount(host)
    const readOrder = (): string[] =>
      wrapper.findAll('[data-testid="tray-order-item"]').map((n) => n.text())

    expect(readOrder()).toEqual(['todo', 'goal', 'custom-b', 'custom-a'])

    state.viewIds = ['goal', 'todo']
    await wrapper.vm.$nextTick()
    expect(readOrder()).toEqual(['todo', 'goal'])
  })
})
