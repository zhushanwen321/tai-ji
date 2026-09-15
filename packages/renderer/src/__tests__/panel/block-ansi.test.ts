/**
 * Block.vue ANSI 兜底渲染测试（W4）。
 *
 * 验证：
 * - outputRaw 存在时用 AnsiText 渲染（含 ansi_up 着色 span）
 * - outputRaw 不存在时回退纯文本 result
 * - details.__gui__ 存在时优先用 GuiComponentRenderer 渲染（审计项 C）
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/block-ansi.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { Block } from '@taiji/ui'
import type { ToolCall } from '@taiji/shared'

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    toolName: 'bash',
    input: { command: 'echo hello' },
    output: 'hello',
    status: 'completed',
    startTime: Date.now(),
    ...over,
  }
}

/** Tool 默认收起，需点击 header 展开。返回展开后的 wrapper。 */
async function mountExpanded(tool: ToolCall) {
  const wrapper = mount(Block, {
    props: { type: 'toolCall', tool },
  })
  // tool 详情默认收起（toolCollapsed=true），点击 header 展开
  const header = wrapper.find('.cursor-pointer')
  expect(header.exists()).toBe(true)
  await header.trigger('click')
  return wrapper
}

describe('Block ANSI 兜底渲染', () => {
  it('E1: outputRaw 含 ANSI → 用 AnsiText 渲染（data-testid="ansi-text" 存在）', async () => {
    const tool = makeTool({
      output: 'hello',
      outputRaw: '\x1b[32mhello\x1b[0m',
    })
    const wrapper = await mountExpanded(tool)

    // AnsiText 组件渲染了 data-testid="ansi-text"
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
  })

  it('outputRaw 不存在 → 回退纯文本 span（无 AnsiText）', async () => {
    const tool = makeTool({
      output: 'plain result',
    })
    const wrapper = await mountExpanded(tool)

    // 无 AnsiText
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
    // 有纯文本 result
    expect(wrapper.text()).toContain('plain result')
  })

  it('details.__gui__ 存在 → 优先用 GuiComponentRenderer 渲染 card（data-testid="gui-card" 存在）', async () => {
    const tool = makeTool({
      toolName: 'read',
      output: 'done',
      details: {
        __gui__: {
          v: 1,
          component: {
            type: 'card',
            props: { variant: 'default', body: [] },
          },
        },
      },
    })
    const wrapper = await mountExpanded(tool)

    // GuiComponentRenderer 渲染（容器 testid 存在）
    expect(wrapper.find('[data-testid="gui-component-renderer"]').exists()).toBe(true)
    // card 已实现，GuiComponentRenderer 路由到 Card 组件（gui-card testid 存在）
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(true)
  })
})
