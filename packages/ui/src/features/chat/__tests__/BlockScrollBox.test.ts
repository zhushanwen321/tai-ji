/**
 * BlockScrollBox.vue 组件测试（system-notice-rendering-upgrade U7 / §3.3 D6 + G5）。
 *
 * 覆盖（jsdom 行为层，DOM 环境 = happy-dom）：
 * - 限高 style：视口 max-height = var(--block-scroll-max-height)，展开全部后解除
 * - 内容不超限高：信息条整条不渲染（展开按钮是唯一入口，也随之不渲染）
 * - 渐隐 class 切换：mock 滚动几何 + scroll 事件 → 上/下渐隐条按滚动方向切 opacity class
 * - 渐隐底色上下文：surface prop → 根 --block-scroll-fade-bg（thinking/画布底 vs bash 凹槽底）
 * - 行区间信息条：行高实测路径（computed line-height）与无布局引擎降级路径（字号 × leading-snug）
 * - 展开切换：按钮文案（展开全部/收起 + 方向箭头）+ aria-expanded + 展开态信息条保留
 * - streaming 吸底：内容增长且未上滚 → 贴底；用户上滚后停吸、回底恢复；展开态不吸底
 *
 * 环境说明：happy-dom 无布局引擎（scrollHeight/clientHeight 恒 0），几何值全部经
 * Object.defineProperty mock（getter 可变形态）；行高由 slot 内容内联 style 提供
 * （getComputedStyle 读得到），降级路径用 font-size + line-height normal。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/BlockScrollBox.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// vue-i18n 的 useI18n 覆盖为自包含 t（vitest.setup.ts 默认 mock 直接回 key——
// 本用例要断言展开/收起与行区间文案，故给真实文案字典 + 命名参数插值；对齐 Turn.test.ts 覆盖范式）
vi.mock('vue-i18n', () => {
  const messages: Record<string, string> = {
    'panel.message.blockScrollExpandAll': '展开全部',
    'panel.message.collapse': '收起',
    'panel.message.blockScrollLines': '{from}–{to} / {total} 行',
  }
  const t = (key: string, named?: Record<string, unknown>): string => {
    let text = messages[key] ?? key
    if (named) {
      for (const [name, value] of Object.entries(named)) {
        text = text.replace(`{${name}}`, String(value))
      }
    }
    return text
  }
  return { useI18n: () => ({ t }) }
})

import { mount } from '@vue/test-utils'
import BlockScrollBox from '../BlockScrollBox.vue'

/** 内容行高（px）：信息条行区间断言的实测路径（slot 内容内联 line-height） */
const CONTENT_LINE_HEIGHT = 20
/** 降级路径字号（px）：line-height 为 normal 时按 字号 × leading-snug(1.375) = 19.25px 估算 */
const FALLBACK_FONT_SIZE = 14

const VIEWPORT_SEL = '[data-testid="block-scroll-viewport"]'
const FADE_TOP_SEL = '[data-testid="block-scroll-fade-top"]'
const FADE_BOTTOM_SEL = '[data-testid="block-scroll-fade-bottom"]'
const INFO_SEL = '[data-testid="block-scroll-info"]'
const RANGE_SEL = '[data-testid="block-scroll-range"]'
const TOGGLE_SEL = '[data-testid="block-scroll-toggle"]'
const LABEL_SEL = '[data-testid="block-scroll-toggle-label"]'
const CONTENT_SEL = '[data-testid="block-scroll-content"]'

interface ScrollMetrics {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

interface BoxHarness {
  wrapper: ReturnType<typeof mountBox>
  viewport: HTMLElement
  metrics: ScrollMetrics
  /** 排空 MutationObserver 回调（微任务） */
  flush: () => Promise<void>
  /** 模拟滚动到指定位置（派发 scroll 事件 → 组件重测） */
  scrollTo: (top: number) => Promise<void>
  /** 模拟内容增长（不改几何值，只触发观测回调） */
  appendContent: () => void
}

/** 滚动几何 mock（getter 形态：mock 对象持续可变，支撑「增长后 scrollHeight 变化」用例） */
function mockScrollMetrics(el: HTMLElement): ScrollMetrics {
  const metrics: ScrollMetrics = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 }
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value
    },
  })
  return metrics
}

/**
 * 挂载：slot 内容带内联行高（实测路径）或字号（降级路径）。
 * attachTo body：getComputedStyle 需要有文档上下文（同 WidgetArea.test.ts 范式）。
 */
function mountBox(options: { surface?: 'canvas' | 'recessed'; lineHeight?: number; fontSize?: number } = {}) {
  const style = options.lineHeight !== undefined
    ? `line-height: ${options.lineHeight}px`
    : `font-size: ${options.fontSize ?? FALLBACK_FONT_SIZE}px`
  return mount(BlockScrollBox, {
    attachTo: document.body,
    props: options.surface ? { surface: options.surface } : {},
    slots: { default: `<div data-testid="block-scroll-content" style="${style}">content</div>` },
  })
}

function setupBox(options: { surface?: 'canvas' | 'recessed'; lineHeight?: number; fontSize?: number } = {}): BoxHarness {
  const wrapper = mountBox(options)
  const viewport = wrapper.get(VIEWPORT_SEL).element as HTMLElement
  const metrics = mockScrollMetrics(viewport)
  return {
    wrapper,
    viewport,
    metrics,
    flush: () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve()
        }, 0)
      }),
    scrollTo: async (top: number) => {
      metrics.scrollTop = top
      await wrapper.get(VIEWPORT_SEL).trigger('scroll')
    },
    appendContent: () => {
      wrapper.get(CONTENT_SEL).element.appendChild(document.createTextNode(' more'))
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

/** 渐隐条是否显形（scroll 事件切 opacity class：opacity-100 = 该方向可滚） */
function fadeVisible(box: BoxHarness, sel: string): boolean {
  return box.wrapper.get(sel).classes().includes('opacity-100')
}

describe('BlockScrollBox 限高与信息条渲染', () => {
  it('限高 style：视口 max-height = var(--block-scroll-max-height)；展开全部后解除（maxHeight none）', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    // 未展开：限高走 token（真值源 renderer style.css / mobile tokens.css 镜像）
    expect(box.viewport.style.maxHeight).toBe('var(--block-scroll-max-height)')

    // 造溢出 → 信息条可见 → 点展开全部
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(0)
    expect(box.wrapper.find(INFO_SEL).exists()).toBe(true)

    await box.wrapper.get(TOGGLE_SEL).trigger('click')
    expect(box.viewport.style.maxHeight).toBe('none')

    // 收起回滚限高
    await box.wrapper.get(TOGGLE_SEL).trigger('click')
    expect(box.viewport.style.maxHeight).toBe('var(--block-scroll-max-height)')
    box.wrapper.unmount()
  })

  it('内容不超限高：信息条整条不渲染（展开按钮一并缺席），两侧渐隐条均不显形', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 200
    box.metrics.clientHeight = 240 // 240px 限高内容装得下
    await box.scrollTo(0)
    expect(box.wrapper.find(INFO_SEL).exists()).toBe(false)
    expect(box.wrapper.find(TOGGLE_SEL).exists()).toBe(false)
    expect(fadeVisible(box, FADE_TOP_SEL)).toBe(false)
    expect(fadeVisible(box, FADE_BOTTOM_SEL)).toBe(false)
    box.wrapper.unmount()
  })

  it('溢出：信息条渲染，渐隐 class 随滚动方向切换（顶部→仅下渐隐 / 中部→上下都有 / 底部→仅上渐隐）', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(0)
    expect(box.wrapper.find(INFO_SEL).exists()).toBe(true)
    expect(fadeVisible(box, FADE_BOTTOM_SEL)).toBe(true)
    expect(fadeVisible(box, FADE_TOP_SEL)).toBe(false)

    await box.scrollTo(80) // 中部
    expect(fadeVisible(box, FADE_TOP_SEL)).toBe(true)
    expect(fadeVisible(box, FADE_BOTTOM_SEL)).toBe(true)

    await box.scrollTo(160) // 底部（scrollHeight - clientHeight）
    expect(fadeVisible(box, FADE_TOP_SEL)).toBe(true)
    expect(fadeVisible(box, FADE_BOTTOM_SEL)).toBe(false)
    box.wrapper.unmount()
  })

  it('渐隐底色上下文：surface prop → 根 --block-scroll-fade-bg（默认画布底 / recessed = 凹槽底）', () => {
    const canvasBox = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    expect(canvasBox.wrapper.element.style.getPropertyValue('--block-scroll-fade-bg')).toBe('var(--bg)')
    canvasBox.wrapper.unmount()

    const recessedBox = setupBox({ surface: 'recessed', lineHeight: CONTENT_LINE_HEIGHT })
    expect(recessedBox.wrapper.element.style.getPropertyValue('--block-scroll-fade-bg')).toBe('var(--bg-input)')
    recessedBox.wrapper.unmount()
  })
})

describe('BlockScrollBox 行区间信息条', () => {
  it('行高实测路径（20px）：内容 400px / 视口 240px → 1–12 / 20 行；滚到底 → 9–20 / 20 行', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(0)
    expect(box.wrapper.get(RANGE_SEL).text()).toBe('1–12 / 20 行')

    await box.scrollTo(160)
    expect(box.wrapper.get(RANGE_SEL).text()).toBe('9–20 / 20 行')
    box.wrapper.unmount()
  })

  it('行高降级路径（line-height normal + 字号 14px → 字号 × leading-snug 估算）：500px 内容 → 1–12 / 26 行', async () => {
    const box = setupBox({ fontSize: FALLBACK_FONT_SIZE })
    box.metrics.scrollHeight = 500
    box.metrics.clientHeight = 240
    await box.scrollTo(0)
    // 14 × 1.375 = 19.25px → round(500 / 19.25) = 26 行（若误用 16px 默认字号会得 23 行）
    expect(box.wrapper.get(RANGE_SEL).text()).toBe('1–12 / 26 行')
    box.wrapper.unmount()
  })
})

describe('BlockScrollBox 展开全部切换', () => {
  it('按钮文案与 aria：展开 ↓ → 收起 ↑（aria-expanded 同步），展开态信息条保留', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(0)

    const toggle = box.wrapper.get(TOGGLE_SEL)
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(box.wrapper.get(LABEL_SEL).text()).toBe('展开全部')
    expect(toggle.text()).toContain('↓')

    await toggle.trigger('click')
    expect(box.wrapper.get(TOGGLE_SEL).attributes('aria-expanded')).toBe('true')
    expect(box.wrapper.get(LABEL_SEL).text()).toBe('收起')
    expect(box.wrapper.get(TOGGLE_SEL).text()).toContain('↑')
    // 展开态信息条保留（收起按钮是其唯一入口）
    expect(box.wrapper.find(INFO_SEL).exists()).toBe(true)
    box.wrapper.unmount()
  })
})

describe('BlockScrollBox streaming 吸底', () => {
  it('内容增长且未上滚 → 贴底；用户上滚后停吸；回底恢复吸底', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 100
    box.metrics.clientHeight = 240
    await box.scrollTo(0) // 内容未超限高 = 贴底态

    // ① 增长 → 吸底
    box.metrics.scrollHeight = 400
    box.appendContent()
    await box.flush()
    expect(box.viewport.scrollTop).toBe(400)

    // ② 用户上滚 → 停吸（新内容不再把视口拉走）
    await box.scrollTo(0)
    box.metrics.scrollHeight = 500
    box.appendContent()
    await box.flush()
    expect(box.viewport.scrollTop).toBe(0)

    // ③ 回底 → 恢复吸底
    await box.scrollTo(260) // 500 - 240
    box.metrics.scrollHeight = 600
    box.appendContent()
    await box.flush()
    expect(box.viewport.scrollTop).toBe(600)
    box.wrapper.unmount()
  })

  it('展开全部态不吸底（内容已全量可见，视口位置不动）', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(160) // 贴底
    await box.wrapper.get(TOGGLE_SEL).trigger('click') // 展开全部

    box.metrics.scrollHeight = 500
    box.appendContent()
    await box.flush()
    expect(box.viewport.scrollTop).toBe(160)
    box.wrapper.unmount()
  })
})
