// TokenInputView 组件测试（remote-use U1.3 独立交付组件；App.vue 接线归 U1.4c）。
//
// 哑组件契约：渲染锚点 testid + submit 事件（trim 后上抛；空值不发）。
// 重试编排（adoptManualToken → 抑制位 reset → 重连）在 bootstrap.submitRemoteToken，
// 组件零 core import——本文件只测组件自身行为。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/token-input-view.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TokenInputView from '../shell/TokenInputView.vue'

describe('TokenInputView（D4/D8 恢复入口）', () => {
  it('渲染视图锚点 / 标题 / 输入框 / 提交按钮', () => {
    const wrapper = mount(TokenInputView)
    expect(wrapper.find('[data-testid="token-input-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-input-title"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-submit"]').exists()).toBe(true)
  })

  it('空 token 提交不发 submit 事件；输入后提交 emit("submit", trim 后 token)', async () => {
    const wrapper = mount(TokenInputView)
    await wrapper.find('[data-testid="token-submit"]').trigger('click')
    expect(wrapper.emitted('submit')).toBeUndefined()

    await wrapper.find('[data-testid="token-input"]').setValue('  tok-abc  ')
    await wrapper.find('[data-testid="token-submit"]').trigger('click')
    expect(wrapper.emitted('submit')?.[0]).toEqual(['tok-abc'])
  })

  it('输入框 Enter 键提交（粘贴 token 后回车的典型路径）', async () => {
    const wrapper = mount(TokenInputView)
    await wrapper.find('[data-testid="token-input"]').setValue('tok-enter')
    await wrapper.find('[data-testid="token-input"]').trigger('keyup.enter')
    expect(wrapper.emitted('submit')?.[0]).toEqual(['tok-enter'])
  })
})
