/**
 * HtmlPreviewInline 内联预览容器测试（chat-html-support §6.3 D3，v16 形态变更；u7-inline）。
 *
 * 覆盖七组语义：
 * - 默认预览态挂载：servable → 头部条（文件名 + 大小）+ iframe（sandbox=allow-scripts、
 *   local-file src ?r=1）
 * - 预检降级三原因（not_found / is_dir / out_of_whitelist）+ 路径非法（空 / 多行）+
 *   路径无法解析：降级占位文案可见、无 iframe、无操作按钮
 * - 源码态切换与 readArtifact 注入：切「源码」→ iframe 卸载 + 嵌套 MarkdownRenderer 收到
 *   fence 包裹源码；readArtifact reject → 错误占位 + 重试；未 provide → 切换整组隐藏
 * - 刷新 ?r=n 递增：servable 重检 → ?r=2；文件已删（not_found）→ 刷新落降级占位
 * - 懒挂载（IntersectionObserver mock）：进视口前不挂 iframe、loading 占位；进视口后挂载；
 *   卸载时 disconnect
 * - 展开-收起高度切换：480 ⇄ 720（固定高度降级形态，无内容高度自适应）
 * - 路径解析矩阵（与 MarkdownRenderer ④路同传值矩阵）+ 预检 pending/reject 不挂死
 *
 * t() 走 ui 全局 setup 的 mock（返回 key）——断言用 key 字面量（真文案由 locale 双侧承载）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/HtmlPreviewInline.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import HtmlPreviewInline from '../HtmlPreviewInline.vue'
import { mockChatProvide } from './helpers'
import type { ChatViewDeps } from '@taiji/ui'

/** flush 异步链（watch immediate → runProbe → await probe → 状态写回） */
async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

/** IntersectionObserver mock（懒挂载驱动：用例手动 trigger(isIntersecting)） */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  callback: IntersectionObserverCallback
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb
    MockIntersectionObserver.instances.push(this)
  }
  trigger(isIntersecting: boolean): void {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

beforeEach(() => {
  MockIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mountInline(props: Record<string, unknown>, overrides: Partial<ChatViewDeps> = {}): VueWrapper {
  return mount(HtmlPreviewInline, {
    props: props as never,
    global: {
      provide: mockChatProvide(overrides),
      stubs: {
        MarkdownRenderer: {
          template: '<div data-testid="source-md-stub" :data-content="content ?? \'\'" />',
          props: ['content', 'sessionId'],
        },
      },
    },
  })
}

/** 挂载并触发进视口（懒挂载放行）+ flush 预检链 */
async function mountInView(props: Record<string, unknown>, overrides: Partial<ChatViewDeps> = {}): Promise<VueWrapper> {
  const wrapper = mountInline(props, overrides)
  MockIntersectionObserver.instances[0]?.trigger(true)
  await flush()
  return wrapper
}

const nameOf = (w: VueWrapper): string => w.find('[data-testid="html-preview-name"]').text()
const sizeOf = (w: VueWrapper): string => w.find('[data-testid="html-preview-size"]').text()
const metaOf = (w: VueWrapper): string => w.find('[data-testid="html-preview-meta"]').text()
const frame = (w: VueWrapper) => w.find('[data-testid="html-preview-frame"]')
const loading = (w: VueWrapper) => w.find('[data-testid="html-preview-loading"]')
const degraded = (w: VueWrapper) => w.find('[data-testid="html-preview-degraded"]')
const refreshBtn = (w: VueWrapper) => w.find('[data-testid="html-preview-refresh"]')
const expandBtn = (w: VueWrapper) => w.find('[data-testid="html-preview-expand"]')
const viewToggle = (w: VueWrapper) => w.find('[data-testid="html-preview-view-toggle"]')

describe('默认预览态挂载（servable → 头部条 + iframe）', () => {
  it('servable（带 size）→ 文件名 + 大小 + iframe（sandbox allow-scripts、?r=1）', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true, size: 2355 })
    const wrapper = await mountInView({ path: '/abs/report.html' }, { probeArtifact })
    expect(probeArtifact).toHaveBeenCalledWith('/abs/report.html')
    expect(nameOf(wrapper)).toBe('report.html')
    expect(sizeOf(wrapper)).toBe('2.3 KB')
    expect(frame(wrapper).exists()).toBe(true)
    expect(frame(wrapper).attributes('sandbox')).toBe('allow-scripts')
    expect(frame(wrapper).attributes('src')).toBe('local-file:///abs/report.html?r=1')
  })

  it('servable 无 size → 仅文件名（大小空缺），iframe 照常挂载', async () => {
    const wrapper = await mountInView({ path: '/abs/report.html' }, {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
    })
    expect(sizeOf(wrapper)).toBe('')
    expect(frame(wrapper).exists()).toBe(true)
  })

  it('文件名含空格/# → src 按段百分号编码（handler decodeURIComponent 成对）', async () => {
    const wrapper = await mountInView({ path: '/abs/my report#1.html' }, {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
    })
    expect(frame(wrapper).attributes('src')).toBe('local-file:///abs/my%20report%231.html?r=1')
  })
})

describe('预检降级三原因 + 路径非法 + 无法解析（降级占位：无 iframe 无操作）', () => {
  it.each([
    ['not_found', 'panel.htmlPreview.notFound'],
    ['is_dir', 'panel.htmlPreview.isDir'],
    ['out_of_whitelist', 'panel.htmlPreview.outOfWhitelist'],
  ] as const)('reason=%s → 降级占位 + 原因文案 + 无 iframe', async (reason, key) => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: false, reason })
    const wrapper = await mountInView({ path: '/abs/report.html' }, { probeArtifact })
    expect(degraded(wrapper).exists()).toBe(true)
    expect(metaOf(wrapper)).toBe(key)
    expect(nameOf(wrapper)).toBe('report.html')
    expect(frame(wrapper).exists()).toBe(false)
    expect(refreshBtn(wrapper).exists()).toBe(false)
    expect(expandBtn(wrapper).exists()).toBe(false)
  })

  it('空内容 → 「路径非法」且不调预检', async () => {
    const probeArtifact = vi.fn()
    const wrapper = await mountInView({ path: '\n  \n' }, { probeArtifact })
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.invalidPath')
    expect(probeArtifact).not.toHaveBeenCalled()
  })

  it('多行内容 → 「路径非法」', async () => {
    const wrapper = await mountInView({ path: '/a.html\n/b.html' })
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.invalidPath')
  })

  it('相对路径 + 基准与 session 语境皆缺 → 「无法解析路径」（不静默猜基准）', async () => {
    const wrapper = await mountInView({ path: 'sub/x.html' }, { sessionCwdOf: () => undefined })
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.unresolvedPath')
  })
})

describe('路径解析矩阵（resourceBaseDir 覆盖优先 / sessionCwdOf 兜底）', () => {
  it('绝对路径 → 直用（不查基准）', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true })
    const sessionCwdOf = vi.fn(() => '/cwd')
    await mountInView({ path: '/abs/x.html' }, { probeArtifact, sessionCwdOf })
    expect(probeArtifact).toHaveBeenCalledWith('/abs/x.html')
    expect(sessionCwdOf).not.toHaveBeenCalled()
  })

  it('`~` 家目录形态 → 直用（不拼 cwd，与 servable 入参域对齐）', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true })
    const sessionCwdOf = vi.fn(() => '/cwd')
    await mountInView({ path: '~/artifacts/x.html', sessionId: 's1' }, { probeArtifact, sessionCwdOf })
    expect(probeArtifact).toHaveBeenCalledWith('~/artifacts/x.html')
    expect(sessionCwdOf).not.toHaveBeenCalled()
  })

  it('相对路径 + resourceBaseDir 与 sessionCwdOf 皆在 → resourceBaseDir 优先', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true })
    await mountInView(
      { path: 'sub/x.html', resourceBaseDir: '/base', sessionId: 's1' },
      { probeArtifact, sessionCwdOf: () => '/cwd' },
    )
    expect(probeArtifact).toHaveBeenCalledWith('/base/sub/x.html')
  })

  it('相对路径 + 无 resourceBaseDir → sessionCwdOf 兜底', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true })
    await mountInView({ path: 'sub/x.html', sessionId: 's1' }, { probeArtifact, sessionCwdOf: () => '/cwd' })
    expect(probeArtifact).toHaveBeenCalledWith('/cwd/sub/x.html')
  })
})

describe('预检通道缺失 / pending（不挂死）', () => {
  it('deps.probeArtifact 未 provide → 跳过预检（无大小、iframe 直接挂载）', async () => {
    const wrapper = await mountInView({ path: '/abs/report.html' })
    expect(sizeOf(wrapper)).toBe('')
    expect(frame(wrapper).exists()).toBe(true)
    expect(frame(wrapper).attributes('src')).toBe('local-file:///abs/report.html?r=1')
  })

  it('预检 pending（never-resolving）→ 中性加载态（无 iframe，无墙钟超时，用例不阻塞）', async () => {
    const probeArtifact = vi.fn(() => new Promise<{ servable: boolean }>(() => {}))
    const wrapper = await mountInView({ path: '/abs/report.html' }, { probeArtifact })
    expect(loading(wrapper).exists()).toBe(true)
    expect(frame(wrapper).exists()).toBe(false)
  })

  it('预检通道 reject（IPC 不可用）→ 跳过预检直接挂载（不钉死在降级）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const wrapper = await mountInView({ path: '/abs/report.html' }, {
        probeArtifact: vi.fn().mockRejectedValue(new Error('localFileServable unavailable')),
      })
      expect(frame(wrapper).exists()).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('懒挂载（IntersectionObserver threshold 0.1）', () => {
  it('进视口前 → loading 占位、无 iframe；进视口后 → iframe 挂载', async () => {
    const wrapper = mountInline({ path: '/abs/report.html' }, {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true, size: 2355 }),
    })
    await flush()
    // 预检已过但未进视口 → 不设 src
    expect(sizeOf(wrapper)).toBe('2.3 KB')
    expect(frame(wrapper).exists()).toBe(false)
    expect(loading(wrapper).exists()).toBe(true)

    MockIntersectionObserver.instances[0]?.trigger(true)
    await flush()
    expect(frame(wrapper).exists()).toBe(true)
    expect(frame(wrapper).attributes('src')).toBe('local-file:///abs/report.html?r=1')
  })

  it('挂载后离视口不卸载（observer 首次相交即断开）', async () => {
    const wrapper = await mountInView({ path: '/abs/report.html' }, {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
    })
    const io = MockIntersectionObserver.instances[0]
    expect(io?.disconnect).toHaveBeenCalled()
    MockIntersectionObserver.instances[0]?.trigger(false)
    await flush()
    expect(frame(wrapper).exists()).toBe(true)
  })

  it('组件卸载 → observer disconnect（不残留观测）', () => {
    const wrapper = mountInline({ path: '/abs/report.html' })
    const io = MockIntersectionObserver.instances[0]
    wrapper.unmount()
    expect(io?.disconnect).toHaveBeenCalled()
  })
})

describe('刷新 ?r=n 递增（servable 重检；文件已删 → 降级占位）', () => {
  it('点刷新 → 重走预检 + revision 递增（?r=2）', async () => {
    const probeArtifact = vi.fn().mockResolvedValue({ servable: true, size: 10 })
    const wrapper = await mountInView({ path: '/abs/report.html' }, { probeArtifact })
    expect(frame(wrapper).attributes('src')).toBe('local-file:///abs/report.html?r=1')
    await refreshBtn(wrapper).trigger('click')
    await flush()
    expect(probeArtifact).toHaveBeenCalledTimes(2)
    expect(frame(wrapper).attributes('src')).toBe('local-file:///abs/report.html?r=2')
  })

  it('改写后文件被删（not_found）→ 刷新落降级占位、iframe 卸载', async () => {
    const probeArtifact = vi.fn()
      .mockResolvedValueOnce({ servable: true, size: 10 })
      .mockResolvedValueOnce({ servable: false, reason: 'not_found' })
    const wrapper = await mountInView({ path: '/abs/report.html' }, { probeArtifact })
    expect(frame(wrapper).exists()).toBe(true)
    await refreshBtn(wrapper).trigger('click')
    await flush()
    expect(degraded(wrapper).exists()).toBe(true)
    expect(metaOf(wrapper)).toBe('panel.htmlPreview.notFound')
    expect(frame(wrapper).exists()).toBe(false)
  })
})

describe('展开-收起高度切换（固定高度降级形态：480 ⇄ 720）', () => {
  it('默认 480px；点「展开」→ 720px；再点「收起」→ 480px', async () => {
    const wrapper = await mountInView({ path: '/abs/report.html' }, {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
    })
    expect(frame(wrapper).classes()).toContain('h-[480px]')
    await expandBtn(wrapper).trigger('click')
    expect(frame(wrapper).classes()).toContain('h-[720px]')
    expect(frame(wrapper).classes()).not.toContain('h-[480px]')
    await expandBtn(wrapper).trigger('click')
    expect(frame(wrapper).classes()).toContain('h-[480px]')
  })
})

describe('源码态（deps.readArtifact 注入）', () => {
  it('切「源码」→ iframe 卸载 + 嵌套 MarkdownRenderer 收到 fence 包裹源码', async () => {
    const readArtifact = vi.fn().mockResolvedValue({ content: '<html><body>hi</body></html>' })
    const wrapper = await mountInView({ path: '/abs/report.html' }, {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
      readArtifact,
    })
    expect(readArtifact).not.toHaveBeenCalled()
    const buttons = viewToggle(wrapper).findAll('button')
    await buttons[1].trigger('click')
    await flush()
    expect(readArtifact).toHaveBeenCalledWith('/abs/report.html')
    expect(frame(wrapper).exists()).toBe(false)
    // 嵌套 MarkdownRenderer（stub）收到 fence 包裹：```html 开栅 + 原文 + 闭栅（shiki html 高亮通道）。
    // 使用点 data-testid 落在 stub 根元素（VTU 透传属性覆盖 stub 模板自身属性）
    const stub = wrapper.find('[data-testid="html-preview-source"]')
    expect(stub.exists()).toBe(true)
    expect(stub.attributes('data-content')).toBe('```html\n<html><body>hi</body></html>\n```')
  })

  it('源码含 ``` 行首反引号 → 开栅长度抬升（不被源码提前闭合）', async () => {
    const readArtifact = vi.fn().mockResolvedValue({ content: 'intro\n```\ncode fence\n```' })
    const wrapper = await mountInView({ path: '/abs/report.html' }, {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
      readArtifact,
    })
    const buttons = viewToggle(wrapper).findAll('button')
    await buttons[1].trigger('click')
    await flush()
    const content = wrapper.find('[data-testid="html-preview-source"]').attributes('data-content') ?? ''
    expect(content.startsWith('````html\n')).toBe(true)
    expect(content.endsWith('\n````')).toBe(true)
  })

  it('readArtifact reject → 错误占位 + 重试；重试成功回源码态', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const readArtifact = vi.fn()
        .mockRejectedValueOnce(new Error('localFileRead failed: not_found'))
        .mockResolvedValueOnce({ content: '<html>ok</html>' })
      const wrapper = await mountInView({ path: '/abs/report.html' }, {
        probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
        readArtifact,
      })
      const buttons = viewToggle(wrapper).findAll('button')
      await buttons[1].trigger('click')
      await flush()
      expect(wrapper.find('[data-testid="html-preview-source-error"]').exists()).toBe(true)
      await wrapper.find('[data-testid="html-preview-source-retry"]').trigger('click')
      await flush()
      expect(wrapper.find('[data-testid="html-preview-source"]').exists()).toBe(true)
      expect(readArtifact).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('deps.readArtifact 未 provide → 切换整组隐藏（容器只有预览态，mock 壳不碎）', async () => {
    const wrapper = await mountInView({ path: '/abs/report.html' }, {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
    })
    expect(viewToggle(wrapper).exists()).toBe(false)
    expect(frame(wrapper).exists()).toBe(true)
  })

  it('切回「预览」→ iframe 重新挂载（src 保持既有 revision）', async () => {
    const readArtifact = vi.fn().mockResolvedValue({ content: '<html>x</html>' })
    const wrapper = await mountInView({ path: '/abs/report.html' }, {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
      readArtifact,
    })
    const buttons = viewToggle(wrapper).findAll('button')
    await buttons[1].trigger('click')
    await flush()
    await buttons[0].trigger('click')
    await flush()
    expect(frame(wrapper).exists()).toBe(true)
    expect(frame(wrapper).attributes('src')).toBe('local-file:///abs/report.html?r=1')
  })
})
