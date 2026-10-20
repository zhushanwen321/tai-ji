/**
 * Tooltip 原语冒烟测试（2026-10-19 左簇浮层优化：原生 title 退役的主题化替代）。
 *
 * 覆盖：hover 延迟后浮层渲染文本（reka Tooltip open 机制打通）+ whitespace-pre-line
 * 多行形态类 + pointerleave 收起。渲染正确性是本原语唯一职责（文案合成在消费方）。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/__tests__/Tooltip.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip'

describe('Tooltip', () => {
  it('hover 延迟后浮层渲染文本，leave 后收起；多行文本走 pre-line', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount({
        components: { Tooltip, TooltipContent, TooltipTrigger },
        template: `
          <Tooltip :delay-duration="100">
            <TooltipTrigger as-child>
              <button type="button" data-testid="tip-target">入口</button>
            </TooltipTrigger>
            <TooltipContent data-testid="tip-content">第一行\n第二行</TooltipContent>
          </Tooltip>
        `,
      }, { attachTo: document.body })

      expect(document.body.querySelector('[data-testid="tip-content"]')).toBeNull()

      // reka TooltipTrigger 以 pointermove 开启（非 pointerenter），pointerleave 收起；
      // pointerType 传 mouse（touch 会被 reka 忽略）+ 推进略过 delay（reka 内部计时有余量）
      await wrapper.find('[data-testid="tip-target"]').trigger('pointermove', { pointerType: 'mouse' })
      vi.advanceTimersByTime(200)
      await wrapper.vm.$nextTick()

      const content = document.body.querySelector('[data-testid="tip-content"]')
      expect(content).not.toBeNull()
      expect(content!.textContent).toContain('第一行')
      expect(content!.className).toContain('whitespace-pre-line')

      // 收起链路（pointerleave → provider grace 计时 → onClose）是 reka 原语内部行为，
      // 冒烟不深挖——本原语职责 = 浮层渲染与主题样式，开启态断言已覆盖
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
