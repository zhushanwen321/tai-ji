/**
 * MermaidRenderer 组件单测（W5，对话流 markdown 渲染增强）。
 *
 * 覆盖：
 *  - U14 mount dark 主题 → mermaid.initialize/render 调用 + SVG 注入 DOM
 *  - U15 暗→亮主题切换 → 重新 initialize + render
 *  - U16 全屏 Dialog 内 zoom-in → zoomLabel 增大
 *  - U17 全屏 Dialog 内 fit → 缩放适配
 *  - 渲染失败 → 显示「渲染失败」+ 源码（U12 的组件级验证）
 *
 * [w6 chat-ui-and-shell T7] ui 包 MermaidRenderer 经 deps.renderMermaid inject 消费
 * （原 mock '@/composables/logic/mermaid' 失效）；主题读取改 ui 包自持 getCurrentTheme
 * （纯 DOM 读取），测试直接控制 <html data-theme> 属性。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/mermaid.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { MermaidRenderer } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

// renderMermaid 经 deps 注入：mock 返回可控 svg
const mockRenderMermaid = vi.fn()

beforeEach(() => {
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
})

const SAMPLE_SVG = '<svg viewBox="0 0 100 50"><rect width="100" height="50"/></svg>'

function mountMermaid(source: string) {
  return mount(MermaidRenderer, {
    props: { source },
    global: { provide: mockChatProvide({ renderMermaid: mockRenderMermaid }) },
  })
}

describe('MermaidRenderer（W5）', () => {
  beforeEach(() => {
    mockRenderMermaid.mockReset()
    mockRenderMermaid.mockResolvedValue({ svg: SAMPLE_SVG })
  })

  it('U14: dark 主题挂载 → renderMermaid 调用 + SVG 注入 DOM', async () => {
    const wrapper = mountMermaid('graph TD;A-->B')
    await nextTick()
    await nextTick() // 等 doRender 的 await resolve
    expect(mockRenderMermaid).toHaveBeenCalledWith('graph TD;A-->B', 'dark')
    // SVG 注入 inline 容器（.md-mermaid__inline）
    expect(wrapper.find('.md-mermaid__inline').html()).toContain('<svg')
  })

  it('U15: 主题切换 → 重新 renderMermaid（新主题）', async () => {
    const wrapper = mountMermaid('graph TD;A-->B')
    await nextTick()
    await nextTick()
    expect(mockRenderMermaid).toHaveBeenLastCalledWith(expect.any(String), 'dark')
    // 模拟主题切到 light：设置 <html data-theme>（ui getCurrentTheme 纯 DOM 读取）
    document.documentElement.setAttribute('data-theme', 'light')
    await nextTick()
    await nextTick()
    expect(mockRenderMermaid).toHaveBeenLastCalledWith(expect.any(String), 'light')
    document.documentElement.removeAttribute('data-theme')
  })

  it('U12: 渲染失败 → 显示「渲染失败」+ 源码可复制', async () => {
    mockRenderMermaid.mockRejectedValue(new Error('parse error'))
    const wrapper = mountMermaid('invalid mermaid')
    await nextTick()
    await nextTick()
    expect(wrapper.find('.md-mermaid__error').exists()).toBe(true)
    // 错误态文案取自 i18n key panel.mermaid.renderFailed = '图表渲染失败'
    expect(wrapper.text()).toContain('图表渲染失败')
    // 「查看源码」按钮存在（默认折叠，源码未展开时不可见）
    const toggleBtn = wrapper.findAll('button').find((b) => b.text().includes('查看源码'))
    expect(toggleBtn).toBeDefined()
    // 点开折叠看源码
    await toggleBtn!.trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('invalid mermaid')
  })

  it('U16: 全屏 Dialog 打开 + zoom-in → zoomLabel 增大', async () => {
    const wrapper = mountMermaid('graph TD;A-->B')
    await nextTick()
    await nextTick()
    // 点 inline 图打开全屏
    await wrapper.find('.md-mermaid__inline').trigger('click')
    await nextTick()
    await nextTick()
    // Dialog 经 DialogPortal teleport 到 body → 用 document.body 查找
    const body = document.body
    const labelEl = body.querySelector('.font-mono.text-\\[length\\:var\\(--text-xs\\)\\]') as HTMLElement
    expect(labelEl).toBeTruthy()
    const before = parseInt(labelEl.textContent ?? '0', 10)
    // 点 zoom-in（title="放大"）
    const zoomInBtn = Array.from(body.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '放大',
    ) as HTMLButtonElement
    expect(zoomInBtn).toBeTruthy()
    zoomInBtn.click()
    await nextTick()
    const after = parseInt(labelEl.textContent ?? '0', 10)
    expect(after).toBeGreaterThan(before)
  })

  it('U17: 全屏 fit → zoomLabel 回到适配值', async () => {
    const wrapper = mountMermaid('graph TD;A-->B')
    await nextTick()
    await nextTick()
    await wrapper.find('.md-mermaid__inline').trigger('click')
    await nextTick()
    await nextTick()
    const body = document.body
    const labelEl = body.querySelector('.font-mono.text-\\[length\\:var\\(--text-xs\\)\\]') as HTMLElement
    // 先 zoom-in 放大
    const zoomInBtn = Array.from(body.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '放大',
    ) as HTMLButtonElement
    zoomInBtn.click()
    await nextTick()
    const zoomed = parseInt(labelEl.textContent ?? '0', 10)
    // 点 fit 适配
    const fitBtn = Array.from(body.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '适应窗口',
    ) as HTMLButtonElement
    fitBtn.click()
    await nextTick()
    const fitVal = parseInt(labelEl.textContent ?? '0', 10)
    expect(fitVal).toBeLessThanOrEqual(zoomed)
  })
})
