/**
 * Button 图标尺寸覆盖契约（mount 级，用户可见 DOM 断言）。
 *
 * 背景：Button 基类的图标默认尺寸曾用 [&_svg]:size-4 后代选择器（特异性 0,1,1），
 * 会压制使用方在 svg 上写的单点尺寸类 size-[Npx]（0,1,0），逼使用方全仓散布
 * !size-[Npx] important 绕过。2026-10 用户裁决改为零特异性形态
 * （[:where(&_svg)]:size-4 → 生成 :where(.cls svg)，特异性 0,0,0）后：
 *  - 使用方普通尺寸类结构性恒赢（无需 important）；
 *  - 未显式指定尺寸的图标仍走默认 1rem（rem 随根字号缩放语义保留）。
 *
 * jsdom 不应用 Tailwind CSS，computed 尺寸真机探针另测（.tmp/ui-replica/）；本文件锁
 * DOM 契约 = 组装结果含使用方类、不产生 important、默认规则类在钮上。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/button-icon-size.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import { Button } from '@/components/ui/button'

describe('Button 图标尺寸覆盖（零特异性基类）', () => {
  it('使用方 svg 普通尺寸类 size-[17px] 原样保留在图标上，组装不产生 important', () => {
    const wrapper = mount(Button, {
      slots: { default: () => h('svg', { class: 'size-[17px]', 'data-testid': 'probe-icon' }) },
    })
    const icon = wrapper.find('[data-testid=probe-icon]')
    // 用户可见断言：图标自己的普通尺寸类不被吞（覆盖默认 1rem 的载体在）
    expect(icon.classes()).toContain('size-[17px]')
    // 基类零特异性默认规则在钮上（未指定尺寸的图标仍 1rem）
    expect(wrapper.find('button').classes()).toContain('[:where(&_svg)]:size-4')
    // 组装结果全链无 important 尺寸（历史 !size-[Npx] 绕过形态已清零）
    for (const el of wrapper.findAll('*')) {
      for (const cls of el.classes()) {
        expect(cls).not.toContain('!size')
      }
    }
  })

  it('未显式指定尺寸的图标不携带尺寸类，仅由基类默认规则接管', () => {
    const wrapper = mount(Button, {
      slots: { default: () => h('svg', { 'data-testid': 'bare-icon' }) },
    })
    const icon = wrapper.find('[data-testid=bare-icon]')
    expect(icon.classes()).not.toContain('size-4')
    // 钮上默认规则在（真机 computed = 1rem 由该类承载）
    expect(wrapper.find('button').classes()).toContain('[:where(&_svg)]:size-4')
  })
})
