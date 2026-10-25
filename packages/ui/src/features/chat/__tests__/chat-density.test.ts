/**
 * ChatView density 维度测试（remote-use-mobile-v2 §6.2，全项目 P0 红线的机器证明）。
 *
 * 覆盖：
 * 1. 桌面快照断言（additive-only 红线）：density 缺省（deps 不含 density 字段 = desktop）
 *    时 chat 组件产出类名与现状逐字一致——对比基线 =
 *    __fixtures__/chat-desktop-default.html（改动前捕获，normalized：模板注释剥离 +
 *    标签间纯空白折叠，两步变换零渲染语义）。
 * 2. 移动档（§6.2 五项）：正文 16px/1.62、用户气泡 82% + 右下角 6px、思考块收起一行、
 *    工具行 13px（trace 容器档）、展开输出 220px 内滚（BlockScrollBox）。
 *
 * 三视角：构建者 = deps 契约字段；使用者 = 桌面/移动两档的类名 DOM 断言（类名即
 * 用户可见样式载体）；观察者 = 桌面快照整树形态。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/chat-density.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { ChatView } from '@taiji/ui'
import type { Message } from '@taiji/shared'
import { mockChatProvide } from './helpers'
import ThinkingRow from '../ThinkingRow.vue'
import BlockScrollBox from '../BlockScrollBox.vue'

const FIXTURE_DIR = join(__dirname, '__fixtures__')

/** user + assistant（thinking + bash 工具 + 正文）代表样本：覆盖 §6.2 点名的四类组件 */
function sampleMessages(): Message[] {
  return [
    { id: 'u1', role: 'user', content: '帮我看下这个仓库的结构', status: 'complete', timestamp: 1700000000000 } as unknown as Message,
    {
      id: 'a1',
      role: 'assistant',
      content: '仓库结构如下',
      status: 'complete',
      timestamp: 1700000001000,
      thinking: [{ id: 'th1', content: '用户想了解仓库结构，我先看一下目录。', collapsed: true }],
      toolCalls: [{ id: 'tc1', toolName: 'bash', input: { command: 'ls -la' }, status: 'completed', startTime: 1700000000500, endTime: 1700000000900, output: 'src\nREADME.md' }],
    } as unknown as Message,
  ]
}

function mountChatView(density?: 'desktop' | 'mobile') {
  return mount(ChatView, {
    props: { messages: sampleMessages(), sessionId: 's1', isSessionActive: false },
    global: { provide: mockChatProvide(density ? { density } : {}) },
  })
}

/** 与基线同口径的归一化：模板注释剥离（零渲染语义）+ 标签间纯空白折叠 */
function normalizeRenderedHtml(html: string): string {
  return html
    .replace(/<!--.*?-->/gs, '')
    .replace(/>\s+</g, '><')
}

describe('ChatView density（remote-use-mobile-v2 §6.2）', () => {
  it('桌面快照：density 缺省（不传 = desktop）时产出与现状基线逐字一致（additive-only 红线）', () => {
    const wrapper = mountChatView()
    const baseline = readFileSync(join(FIXTURE_DIR, 'chat-desktop-default.html'), 'utf-8')
    expect(normalizeRenderedHtml(wrapper.html())).toBe(baseline)
  })

  it('桌面快照：显式 density=desktop 与缺省产出一致（显式值不引入第二形态）', () => {
    const wrapper = mountChatView('desktop')
    const baseline = readFileSync(join(FIXTURE_DIR, 'chat-desktop-default.html'), 'utf-8')
    expect(normalizeRenderedHtml(wrapper.html())).toBe(baseline)
  })

  it('移动档：trace 容器行主体字号 13px（--m-text-sub 工具行密度档），desktop 维持 --text-md', () => {
    const desktop = mountChatView()
    const mobile = mountChatView('mobile')
    const desktopTrace = desktop.find('[data-testid="turn-1"] .trace')
    const mobileTrace = mobile.find('[data-testid="turn-1"] .trace')
    expect(desktopTrace.classes()).toContain('text-[length:var(--text-md)]')
    expect(desktopTrace.classes()).not.toContain('text-[length:var(--m-text-sub)]')
    expect(mobileTrace.classes()).toContain('text-[length:var(--m-text-sub)]')
    expect(mobileTrace.classes()).not.toContain('text-[length:var(--text-md)]')
  })

  it('移动档：正文块 16px/1.62（--m-text-body / --m-leading-body），desktop 维持 --text-md/1.8', () => {
    const desktop = mountChatView()
    const mobile = mountChatView('mobile')
    const desktopText = desktop.find('[data-testid="block-text"]')
    const mobileText = mobile.find('[data-testid="block-text"]')
    expect(desktopText.classes()).toContain('text-[length:var(--text-md)]')
    expect(desktopText.classes()).toContain('leading-[1.8]')
    expect(mobileText.classes()).toContain('text-[length:var(--m-text-body)]')
    expect(mobileText.classes()).toContain('leading-[var(--m-leading-body)]')
    expect(mobileText.classes()).not.toContain('text-[length:var(--text-md)]')
  })

  it('移动档：用户气泡最大宽 82% + 右下角 6px（rounded-br-sm），desktop 维持 min(72%,64ch)', () => {
    const desktop = mountChatView()
    const mobile = mountChatView('mobile')
    const desktopBubble = desktop.find('.user-bubble-md')
    const mobileBubble = mobile.find('.user-bubble-md')
    expect(desktopBubble.exists()).toBe(true)
    expect(desktopBubble.classes()).toContain('max-w-[min(72%,64ch)]')
    expect(desktopBubble.classes()).not.toContain('rounded-br-sm')
    expect(mobileBubble.exists()).toBe(true)
    expect(mobileBubble.classes()).toContain('max-w-[82%]')
    expect(mobileBubble.classes()).toContain('rounded-br-sm')
    expect(mobileBubble.classes()).not.toContain('max-w-[min(72%,64ch)]')
  })

  it('移动档：思考块 working 态恒收起一行（不进尾行视口），desktop 维持尾行视口', () => {
    const content = `${'A'.repeat(70)}\nTAILMARKER-LINE`
    const desktop = mount(ThinkingRow, {
      props: { content, working: true, thinkingId: 'th-d' },
      global: { provide: mockChatProvide() },
    })
    const mobile = mount(ThinkingRow, {
      props: { content, working: true, thinkingId: 'th-m' },
      global: { provide: mockChatProvide({ density: 'mobile' }) },
    })
    // desktop：working 态渲染单行尾行视口（h-[1lh] 唯一载体），60 字符预览分支不渲染
    expect(desktop.find('[class*="h-[1lh]"]').exists()).toBe(true)
    expect(desktop.find('span.truncate').exists()).toBe(false)
    // mobile：无尾行视口，回到 60 字符头部预览（思考块默认收起一行，§5.1「思考块收起为一行」）
    expect(mobile.find('[class*="h-[1lh]"]').exists()).toBe(false)
    const preview = mobile.find('span.truncate')
    expect(preview.exists()).toBe(true)
    expect(preview.text()).toContain('…')
    expect(preview.text()).not.toContain('TAILMARKER-LINE')
  })

  it('移动档：展开输出限高 220px（--m-scroll-expand），desktop 维持 --block-scroll-max-height', () => {
    const desktop = mount(BlockScrollBox, { global: { provide: mockChatProvide() } })
    const mobile = mount(BlockScrollBox, { global: { provide: mockChatProvide({ density: 'mobile' }) } })
    expect(desktop.find('[data-testid="block-scroll-viewport"]').attributes('style')).toContain('var(--block-scroll-max-height)')
    expect(mobile.find('[data-testid="block-scroll-viewport"]').attributes('style')).toContain('var(--m-scroll-expand)')
  })
})
