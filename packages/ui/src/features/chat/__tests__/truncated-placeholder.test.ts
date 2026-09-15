/**
 * [u4d-truncated-ui] D3 push 截断占位文案渲染降级测试（crash-resilience §3.3 D3 代价 C /
 * 场景 T3 失败路径：「renderer 收到截断占位时正常渲染降级提示，不抛错不白屏」）。
 *
 * 必测④（DOM 断言）：占位文案 content（u4a push 截断形态 [{type:'text',text:'内容过大…'}]
 * 经 reducer 归一后的字符串，core 侧归一断言见 core __tests__/apply-entry.test.ts u4d
 * describe）走既有 markdown/text 渲染链路正常渲染为文本消息，无特殊处理需求、不抛错。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/truncated-placeholder.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { Block } from '@taiji/ui'

/** u4a push 截断占位文案（契约保持式截断的 block 级替换产物） */
const PLACEHOLDER = '内容过大（32.0 MB）已在传输层截断，完整内容见 session 文件：/tmp/sessions/abc.jsonl'

function mountPlaceholderBlock(content: string, role: 'assistant' | 'user' = 'assistant') {
  return mount(Block, {
    props: {
      type: 'text',
      content,
      // role 维度在本测试中仅用于区分断言标注（Block 对两种来源的 text 分支同一渲染链路）
      'data-role': role,
    },
    global: {
      // 渲染 content 的 stub：wrapper.text() 才能断言正文（stubs: true 会吞掉 content）
      stubs: {
        MarkdownRenderer: {
          props: ['content', 'variant'],
          template: '<div class="stub-md">{{ content }}</div>',
        },
      },
    },
  })
}

describe('截断占位文案渲染降级（必测④）', () => {
  it('assistant 占位文案 → 走 markdown/text 渲染链路正常显示占位文本，不抛错', () => {
    const wrapper = mountPlaceholderBlock(PLACEHOLDER)
    // 用户可见 DOM：占位文案完整可见（降级提示不丢内容）
    expect(wrapper.text()).toContain('内容过大（32.0 MB）已在传输层截断')
    expect(wrapper.text()).toContain('/tmp/sessions/abc.jsonl')
  })

  it('占位文案含 markdown 特殊字符形态（路径/括号/换行）→ 渲染不抛错，内容不静默消失', () => {
    const tricky = `内容过大（8.1 MB）已在传输层截断，完整内容见 session 文件：/tmp/a_b.jsonl\n*未解析的 *markdown* 片段*\n<tool_call>{"x":1}</tool_call>`
    const wrapper = mountPlaceholderBlock(tricky)
    expect(wrapper.text()).toContain('内容过大（8.1 MB）已在传输层截断')
  })
})
