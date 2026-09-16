/**
 * PrimitiveRouter 容器路由 + container-registry 注册表测试。
 *
 * 覆盖：
 * - getPrimitiveContainer 未注册（barrel 未加载）返回 undefined（container-registry.ts:32）
 * - PrimitiveRouter 渲染 card/columns/group 时经 getPrimitiveContainer 查表：
 *   未注册 → 回退 AnsiText（降级 SSOT，不静默空白）；barrel 加载注册后 → 路由到真实容器组件
 *
 * 顺序约束 [重要]：本文件不得静态 import primitives barrel（../primitives/index）——
 * barrel 加载即调用 registerPrimitiveContainers 填充模块级 Map，会让「未注册回退」用例
 * 失真。注册用例放在文件末尾、用动态 import() 触发注册（同文件内 vitest 顺序执行，
 * 模块状态共享，回退用例必须先跑）。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/PrimitiveRouter.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PrimitiveRouter from '../primitives/PrimitiveRouter.vue'
import { getPrimitiveContainer } from '../primitives/container-registry'
import type { GuiComponent } from '@zhushanwen/extension-protocol'

describe('container-registry：barrel 未加载（独立使用场景）', () => {
  it('getPrimitiveContainer 对三种容器类型均返回 undefined', () => {
    expect(getPrimitiveContainer('card')).toBeUndefined()
    expect(getPrimitiveContainer('columns')).toBeUndefined()
    expect(getPrimitiveContainer('group')).toBeUndefined()
  })
})

describe('PrimitiveRouter：容器未注册时回退 AnsiText', () => {
  // 三种容器类型走同一行查表路径（getPrimitiveContainer(type) ?? AnsiText），此处用 card
  // 代表断言渲染结果；columns/group 的未注册态在上方 registry 用例按类型断言。
  // 注：回退时容器原 props 透传 AnsiText（content 缺失），Vue 会 warn Missing required
  // prop——这是该边缘路径（绕过 barrel 独立使用）的生产形态，测试只断言可见降级不抛错。
  it('card 降级 AnsiText（可见降级，不静默空白、不抛错）', () => {
    const component: GuiComponent = { type: 'card', props: { header: 'H', body: [] } }
    const wrapper = mount(PrimitiveRouter, { props: { component } })
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="gui-columns"]').exists()).toBe(false)
  })

  it('叶子原语不受容器注册表影响：stats-line 直接走 BUILTIN_MAP', () => {
    const component: GuiComponent = { type: 'stats-line', props: { items: [{ value: '42' }] } }
    const wrapper = mount(PrimitiveRouter, { props: { component } })
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })
})

describe('PrimitiveRouter：barrel 加载后容器注册命中', () => {
  it('动态 import barrel 后 card 路由到真实 Card 组件', async () => {
    await import('../primitives') // 触发 registerPrimitiveContainers（仅一次，幂等）

    // 注册表已填充：查表命中（container-registry.ts:32 的 get 路径）
    expect(getPrimitiveContainer('card')).toBeDefined()
    expect(getPrimitiveContainer('columns')).toBeDefined()
    expect(getPrimitiveContainer('group')).toBeDefined()

    const component: GuiComponent = { type: 'card', props: { variant: 'elevated', header: 'CI Pipeline', body: [] } }
    const wrapper = mount(PrimitiveRouter, { props: { component } })

    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('CI Pipeline')
  })
})
