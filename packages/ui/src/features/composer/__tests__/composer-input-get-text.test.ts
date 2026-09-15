/**
 * ComposerInput.getText 单测 —— contenteditable 文本提取（换行保留 + chip 过滤）。
 *
 * 重点回归：Shift+Enter 产生的 <br> 必须提取为 \n，否则发送文本丢失软换行，
 * 用户气泡无法保留换行（whitespace-pre-wrap 容器内 <p>...</p> 里的 \n 不再可见）。
 *
 * mock 策略：happy-dom 支持 TreeWalker + createTreeWalker。直接 mount ui ComposerInput，
 * 设 [role="textbox"] 的 innerHTML 构造 contenteditable DOM，调 vm.getText() 断言。
 * deps（pasteImage/renderIcon/t）经 ComposerInputDeps provide 注入（W4 迁移：ui 包
 * 零 renderer import，deps 注入契约见 composer-input-deps.ts）。
 *
 * [W4 迁移] 自 renderer __tests__/panel/composer-input-get-text.test.ts 迁入 ui 包
 * features/composer/__tests__/（ComposerInput 组件新家）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'
import ComposerInput from '../ComposerInput.vue'
import { ComposerInputDepsKey } from '../composer-input-deps'
import type { ComposerInputDeps } from '../composer-input-deps'

function provideDeps(wrapper: ReturnType<typeof mount>): void {
  // ui 包测试直接经 global.provide 注入（无需真实 IPC/i18n）
}

beforeEach(() => {
  vi.restoreAllMocks()
})

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => ({ kind: 'text', text: '[图片粘贴：需桌面环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

describe('ComposerInput.getText（换行保留 + chip × 过滤）', () => {
  /**
   * 构造 contenteditable 内容：直接写 innerHTML 到 [role="textbox"] div。
   * 返回该 div 的 element（调用方需要时可进一步断言 DOM 结构）。
   */
  function setup(html: string): ReturnType<typeof mount> {
    const wrapper = mount(ComposerInput, {
      global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
    })
    const div = wrapper.find('[role="textbox"]')
    ;(div.element as HTMLDivElement).innerHTML = html
    return wrapper
  }

  /** expose 方法在 vm 上运行时可用，TS 类型需断言（defineExpose 不产生公开类型） */
  function getText(wrapper: ReturnType<typeof mount>): string {
    return (wrapper.vm as unknown as { getText: () => string }).getText()
  }

  it('纯文本：原样返回', () => {
    const wrapper = setup('hello world')
    expect(getText(wrapper)).toBe('hello world')
  })

  it('<br> 保留为 \\n（Shift+Enter 产生的换行不丢失）', () => {
    const wrapper = setup('line1<br>line2')
    expect(getText(wrapper)).toBe('line1\nline2')
  })

  it('多个 <br> 保留多个 \\n', () => {
    const wrapper = setup('a<br><br>b')
    expect(getText(wrapper)).toBe('a\n\nb')
  })

  it('末尾 <br> 保留（用户敲 Shift+Enter 后未输文字，发送时换行应可见）', () => {
    const wrapper = setup('text<br>')
    expect(getText(wrapper)).toBe('text\n')
  })

  it('slash-chip 读入（命令段归位为发送文本前缀，D4-b/D4-c）', () => {
    // 命令 chip 产 slash 段（name 走 dataset.chipName），getText 经 segmentsToText 归位
    // 提首——产物以 /goal 开头，与发送时 composer 扁平化一致
    const wrapper = setup('<span class="slash-chip" data-chip-type="slash" data-chip-name="goal"><span class="chip-label">/goal</span></span> do something')
    expect(getText(wrapper)).toBe('/goal do something')
  })

  it('chip × 按钮文本不混入发送内容', () => {
    // × 按钮在 chip 内，其 "×" 文本必须被 TreeWalker 跳过
    const wrapper = setup('<span class="slash-chip" data-chip-type="slash" data-chip-name="goal"><span class="chip-label">/goal</span><span class="chip-x">×</span></span>')
    expect(getText(wrapper)).toBe('/goal')
  })

  it('chip + 后续 <br> 换行：命令名 + 软换行 + 后续文本（slash→text 边界空格规则，偏差 #4）', () => {
    const wrapper = setup('<span class="slash-chip" data-chip-type="slash" data-chip-name="goal"><span class="chip-label">/goal</span><span class="chip-x">×</span></span><br>详细描述')
    // 归位后 slash 段在前，紧跟的 text 段以 \n 开头不属「自带前导空格」→ needsBoundarySpace 补一格
    expect(getText(wrapper)).toBe('/goal \n详细描述')
  })

  it('nbsp 转普通空格，零宽空格过滤', () => {
    // chip 后插的零宽空格（\u200B）作光标锚点，发送时必须过滤
    // nbsp（\u00A0）转普通空格，与 textarea 行为对齐
    const wrapper = setup('a\u00A0b\u200Bc')
    expect(getText(wrapper)).toBe('a bc')
  })
})
