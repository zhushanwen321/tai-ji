// @vitest-environment happy-dom

/**
 * HoverCardContent 组件单测 —— fallthrough attrs 转发守卫（MF-1-15）。
 *
 * 守护契约：本封装模板单根是 HoverCardPortal（Teleport），Vue 对 Teleport 根不继承
 * fallthrough attrs——组件声明 inheritAttrs=false 并把 $attrs 显式合并进内部 reka
 * HoverCardContent 后，消费方直挂的 data-testid 必须落到真正的浮层 DOM。
 * 回归场景 = GenStatsTriggers.vue:47 的直挂形态（data-testid="genstats-ttft-popover"）：
 * 修复前该 testid 在 Portal 边界被静默丢弃，浮层 DOM 上查不到。
 *
 * 挂载形态：reka HoverCardContent 的 popper 定位依赖 HoverCardTrigger anchor——
 * 无 Trigger 时 content 不挂载（探针核实），故 harness 恒含 Trigger + 受控 open。
 *
 * 断言通道：浮层经 Teleport 渲染到 body（脱离组件根子树），wrapper.find 搜不到——
 * 统一走 document.querySelector + DOMWrapper（Teleport 断言的标准形态，
 * 先例 = plan-comment-popover.test.ts）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/hover-card-content.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { HoverCardRoot, HoverCardTrigger } from 'reka-ui'

import HoverCardContent from '@/components/ui/hover-card/HoverCardContent.vue'

let wrapper: VueWrapper | null = null

afterEach(() => {
  // 先 unmount 再留 body 给下一用例（Teleport fragment 被 Vue 持有，禁强拆 body.innerHTML）
  wrapper?.unmount()
  wrapper = null
})

describe('HoverCardContent fallthrough attrs（MF-1-15）', () => {
  it('消费方直挂 data-testid 落到 Teleport 后的浮层 DOM（GenStatsTriggers ttft 回归场景）', async () => {
    wrapper = mount(
      {
        components: { HoverCardRoot, HoverCardTrigger, HoverCardContent },
        template: `
          <HoverCardRoot :open="true">
            <HoverCardTrigger>anchor</HoverCardTrigger>
            <HoverCardContent data-testid="genstats-ttft-popover">content</HoverCardContent>
          </HoverCardRoot>
        `,
      },
      { attachTo: document.body },
    )
    await wrapper.vm.$nextTick()

    const floater = document.querySelector('[data-testid="genstats-ttft-popover"]')
    expect(floater, 'data-testid must survive the Portal boundary onto the floater DOM').toBeTruthy()
    expect(new DOMWrapper(floater!).classes()).toContain('rounded-lg')
  })
})
