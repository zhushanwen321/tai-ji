// @vitest-environment happy-dom

/**
 * SelectContent 组件单测 —— fallthrough attrs 转发检查（MF-1-15）。
 *
 * 守护契约：本封装模板单根是 SelectPortal（Teleport），Vue 对 Teleport 根不继承
 * fallthrough attrs——组件声明 inheritAttrs=false 并把 $attrs 显式合并进内部 reka
 * SelectContent 后，消费方直挂的 data-testid 必须落到真正的浮层 DOM（PopoverContent
 * 已从根源修复的同形契约；修复前 testid 在 Portal 边界被静默丢弃）。
 *
 * 断言通道：浮层经 Teleport 渲染到 body（脱离组件根子树），wrapper.find 搜不到——
 * 统一走 document.querySelector + DOMWrapper（Teleport 断言的标准形态，
 * 先例 = plan-comment-popover.test.ts / reka-select.ts helper）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/select-content.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { SelectRoot, SelectTrigger } from 'reka-ui'

import { SelectContent } from '@/components/ui/select'
import { SelectItem } from '@/components/ui/select'

let wrapper: VueWrapper | null = null

afterEach(() => {
  // 先 unmount 再留 body 给下一用例（Teleport fragment 被 Vue 持有，禁强拆 body.innerHTML）
  wrapper?.unmount()
  wrapper = null
})

describe('SelectContent fallthrough attrs（MF-1-15）', () => {
  it('消费方直挂 data-testid 落到 Teleport 后的浮层 DOM', async () => {
    wrapper = mount(
      {
        components: { SelectRoot, SelectTrigger, SelectContent, SelectItem },
        template: `
          <SelectRoot :open="true">
            <SelectTrigger aria-label="pick">trigger</SelectTrigger>
            <SelectContent data-testid="select-content-under-test">
              <SelectItem value="a">Alpha</SelectItem>
            </SelectContent>
          </SelectRoot>
        `,
      },
      { attachTo: document.body },
    )
    await wrapper.vm.$nextTick()

    const floater = document.querySelector('[data-testid="select-content-under-test"]')
    expect(floater, 'data-testid must survive the Portal boundary onto the floater DOM').toBeTruthy()
    expect(new DOMWrapper(floater!).classes()).toContain('rounded-md')
  })
})
