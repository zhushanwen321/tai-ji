/**
 * AnsiText 组件测试（W3 · v6 新建）。
 * v6：use_classes=true + 16 fg class 映射 + bg 丢弃 + XSS 转义 + 降级回退。
 * 增量渲染：追加分支（前缀增长复用解析器实例 + DOM 只增不重建）/
 *           重建分支（换内容新建实例隔离颜色状态）；三分支用例见「增量渲染」组。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/AnsiText.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h, ref } from 'vue'
import { AnsiUp } from 'ansi_up'
import AnsiText from '../primitives/AnsiText.vue'

const ESC = String.fromCharCode(27)

/** ANSI fg 码 30-37（normal 8 色）+ 90-97（bright 8 色）→ ansi_up class 名映射 */
const FG_CASES: Array<{ code: number; cls: string }> = [
  { code: 30, cls: 'ansi-black-fg' },
  { code: 31, cls: 'ansi-red-fg' },
  { code: 32, cls: 'ansi-green-fg' },
  { code: 33, cls: 'ansi-yellow-fg' },
  { code: 34, cls: 'ansi-blue-fg' },
  { code: 35, cls: 'ansi-magenta-fg' },
  { code: 36, cls: 'ansi-cyan-fg' },
  { code: 37, cls: 'ansi-white-fg' },
  { code: 90, cls: 'ansi-bright-black-fg' },
  { code: 91, cls: 'ansi-bright-red-fg' },
  { code: 92, cls: 'ansi-bright-green-fg' },
  { code: 93, cls: 'ansi-bright-yellow-fg' },
  { code: 94, cls: 'ansi-bright-blue-fg' },
  { code: 95, cls: 'ansi-bright-magenta-fg' },
  { code: 96, cls: 'ansi-bright-cyan-fg' },
  { code: 97, cls: 'ansi-bright-white-fg' },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AnsiText', () => {
  it('16 fg class 输出：use_classes=true 时 16 色 ANSI → 对应 ansi-{color}-fg class', () => {
    for (const { code, cls } of FG_CASES) {
      const wrapper = mount(AnsiText, { props: { content: `${ESC}[${code}mX${ESC}[0m` } })
      const html = wrapper.find('[data-testid="ansi-text"]').html()
      expect(html, `code ${code} 应输出 ${cls}`).toContain(cls)
    }
  })

  it('bg class 输出存在但无样式（ansi_up 输出 -bg class，CSS 不定义故丢弃）', () => {
    // ESC[41m = red bg
    const wrapper = mount(AnsiText, { props: { content: `${ESC}[41mX${ESC}[0m` } })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    // ansi_up 正常输出 ansi-red-bg class
    expect(html).toContain('ansi-red-bg')
    // bg span 不应有内联 style（CSS 不定义 -bg 规则，ansi_up use_classes 不输出内联色）
    expect(html).not.toContain('style')
    expect(html).not.toContain('background')
    expect(html).not.toContain('color:')
  })

  it('escape_html 默认 true：XSS 输入被转义（<script> → &lt;script&gt;）', () => {
    const wrapper = mount(AnsiText, { props: { content: '<script>alert(1)</scr' + 'ipt>' } })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('降级回退：ansi_to_html 抛错时 catch 返回原 content 纯文本', () => {
    const spy = vi.spyOn(AnsiUp.prototype, 'ansi_to_html').mockImplementation(() => {
      throw new Error('parse fail')
    })
    const content = 'raw-fallback-text'
    const wrapper = mount(AnsiText, { props: { content } })
    const el = wrapper.find('[data-testid="ansi-text"]')
    // catch 分支：v-html 注入原 content 文本
    expect(el.text()).toContain(content)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('纯文本无 ANSI：原样输出无 span 着色', () => {
    const wrapper = mount(AnsiText, { props: { content: 'hello world' } })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    expect(html).toContain('hello world')
    // 纯文本无 ANSI 着色 span（ansi_up 不生成 class="ansi-* 着色 span）
    expect(html).not.toContain('class="ansi-')
  })

  // 增量渲染三分支（续喂 + 追加 / 重建）。辅助：本地 ref 驱动 AnsiText，
  // 避免 setProps 的 .vue shim 类型问题；返回容器元素 getter 与内容 ref。
  function mountDriven(initial: string) {
    const content = ref(initial)
    const wrapper = mount({
      setup() {
        return () => h(AnsiText, { content: content.value })
      },
    })
    const el = () => wrapper.find('[data-testid="ansi-text"]').element as HTMLElement
    return { content, el }
  }

  it('纯追加：前缀增长只追加节点，已有 DOM 节点原样保留（不重建）', async () => {
    const { content, el } = mountDriven(`${ESC}[31mred`)
    const first = el().children[0]
    expect(el().childElementCount).toBeGreaterThan(0)
    content.value = `${ESC}[31mred tail text`
    await flushPromises()
    expect(el().textContent).toContain('red tail text')
    // 旧节点引用恒等 = 走了追加分支（重建分支会整体替换出全新节点）
    expect(el().children[0]).toBe(first)
  })

  it('追加时颜色状态延续：未 reset 的 fg 状态跨段持续（复用实例续喂语义）', async () => {
    const { content, el } = mountDriven(`${ESC}[31mred`)
    content.value = `${ESC}[31mred plain-continues`
    await flushPromises()
    // 增量段在 red 状态内（无 reset），续喂后仍着 red（若重建实例只喂 delta 会丢失状态漏染）
    const redSpans = [...el().querySelectorAll('.ansi-red-fg')]
    expect(redSpans.length).toBeGreaterThan(0)
    expect(redSpans.at(-1)?.textContent).toContain('plain-continues')
  })

  // 整条替换（非前缀关系）→ 重建分支新建实例：颜色状态隔离，不串色。
  // 即原 MF-2 回归的语义反转：串色防护针对「换内容」，「同段增长」反而必须复用状态。
  it('整条替换为不同文本：重建实例，颜色状态隔离（无串色）', async () => {
    const { content, el } = mountDriven(`${ESC}[31mred${ESC}`)
    const first = el().children[0]
    expect(el().innerHTML).toContain('ansi-red-fg')
    content.value = 'plain'
    await flushPromises()
    const html = el().innerHTML
    expect(html, '整条替换后纯文本不应串色为 red').not.toContain('ansi-red-fg')
    expect(html).toContain('plain')
    // 节点被整体替换 = 走了重建分支（新建 AnsiUp 隔离旧状态）
    expect(el().children[0]).not.toBe(first)
  })

  it('前缀收缩（如流式尾窗头删）：触发重建，旧节点替换且内容更新', async () => {
    const full = `${ESC}[31mhead-${'x'.repeat(50)}`
    const { content, el } = mountDriven(full)
    const first = el().children[0]
    content.value = full.slice(20) // 头删：既非前缀增长也非整条同文，只能重建
    await flushPromises()
    expect(el().children[0]).not.toBe(first)
    expect(el().textContent).not.toContain('head-')
    expect(el().textContent!.length).toBeGreaterThan(0)
  })

  // MF-1 回归：catch 降级路径经命令式 DOM 注入渲染，含 HTML payload 时必须转义防 XSS
  it('catch 降级路径 XSS 防护：ansi_to_html 抛错且 content 含 <script> 时转义', () => {
    const spy = vi.spyOn(AnsiUp.prototype, 'ansi_to_html').mockImplementation(() => {
      throw new Error('parse fail')
    })
    const wrapper = mount(AnsiText, {
      props: { content: '<script>alert(1)</scr' + 'ipt>' },
    })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    // 转义后注入，不含可执行的 <script> 标签
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    spy.mockRestore()
  })
})
