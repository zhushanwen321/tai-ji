import type { ChatViewDeps } from '@taiji/ui';
import type { IncrementalMarkdownCache } from '@taiji/ui';
import type { IncrementalMarkdownResult } from '@taiji/ui';
import type { MarkdownSegment } from '@taiji/ui';
import type { Message } from '@taiji/shared';
import type { VueWrapper } from '@vue/test-utils';
import HtmlPreviewInline from '../HtmlPreviewInline.vue';
import { createMockDeps, mockChatProvide } from './helpers';
import { _resetImageCacheForTest, collectImagesFromMessages, persistImagesNewestFirst, setImageCacheWritePort, type ImageCacheWritePort } from '@taiji/core/domain/chat';
import type { ImageCacheWriteResult } from '@taiji/shared';
import { MarkdownRenderer, ToolResultImages } from '@taiji/ui';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← HtmlPreviewInline.test.ts
// ======================================================================

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

/**
 * 源码态插槽桩（宿主 #source 插槽的测试替身）：markdown 槽参落在 data-content 上，
 * 断言「fence 包裹后的源码串」即断言容器交给宿主渲染通道的内容。
 */
const SOURCE_SLOT =
  '<template #source="params"><div data-testid="html-preview-source" :data-content="params.markdown" /></template>'

interface MountOpts {  // oe-exempt:20261027:test:
  /** 注入宿主 #source 插槽桩（源码态用例必传——插槽缺席时「源码」切换整组隐藏） */
  withSourceSlot?: boolean
}

function mountInline(props: Record<string, unknown>, overrides: Partial<ChatViewDeps> = {}, opts: MountOpts = {}): VueWrapper {
  return mount(HtmlPreviewInline, {
    props: props as never,
    global: {
      provide: mockChatProvide(overrides),
    },
    slots: opts.withSourceSlot ? { source: SOURCE_SLOT } : undefined,
  })
}

/** 挂载并触发进视口（懒挂载放行）+ flush 预检链 */
async function mountInView(props: Record<string, unknown>, overrides: Partial<ChatViewDeps> = {}, opts: MountOpts = {}): Promise<VueWrapper> {
  const wrapper = mountInline(props, overrides, opts)
  MockIntersectionObserver.instances[0]?.trigger(true)
  await flush()
  return wrapper
}

/**
 * 源码态用例骨架：servable 预检 + readArtifact 注入 + 源码插槽桩，挂载进视口后
 * 点「源码」切源码态（iframe 卸载、插槽桩接管渲染）。
 */
async function mountAndSwitchToSource(readArtifact: NonNullable<ChatViewDeps['readArtifact']>): Promise<VueWrapper> {
  const wrapper = await mountInView(
    { path: '/abs/report.html' },
    {
      probeArtifact: vi.fn().mockResolvedValue({ servable: true }),
      readArtifact,
    },
    { withSourceSlot: true },
  )
  // 懒加载不变量：源码读取发生在切「源码」时，不在容器挂载时预读
  expect(readArtifact).not.toHaveBeenCalled()
  const buttons = viewToggle(wrapper).findAll('button')
  await buttons[1].trigger('click')
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

  it('预检通道 reject（IPC 不可用）→ 跳过预检直接挂载（不固定在降级）', async () => {
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

describe('源码态（deps.readArtifact 注入 + 宿主 #source 插槽）', () => {
  it('切「源码」→ iframe 卸载 + 源码插槽收到 fence 包裹源码', async () => {
    const readArtifact = vi.fn().mockResolvedValue({ content: '<html><body>hi</body></html>' })
    const wrapper = await mountAndSwitchToSource(readArtifact)
    expect(readArtifact).toHaveBeenCalledWith('/abs/report.html')
    expect(frame(wrapper).exists()).toBe(false)
    // 源码插槽桩收到 fence 包裹：```html 开栅 + 原文 + 闭栅（shiki html 高亮通道）。
    const stub = wrapper.find('[data-testid="html-preview-source"]')
    expect(stub.exists()).toBe(true)
    expect(stub.attributes('data-content')).toBe('```html\n<html><body>hi</body></html>\n```')
  })

  it('源码含 ``` 行首反引号 → 开栅长度抬升（不被源码提前结束）', async () => {
    const readArtifact = vi.fn().mockResolvedValue({ content: 'intro\n```\ncode fence\n```' })
    const wrapper = await mountAndSwitchToSource(readArtifact)
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
      const wrapper = await mountAndSwitchToSource(readArtifact)
      expect(wrapper.find('[data-testid="html-preview-source-error"]').exists()).toBe(true)
      // 纯 Error（无结构化 reason 属性，非契约 reject）→ fallback 固定占位文案（不猜原因）
      expect(wrapper.find('[data-testid="html-preview-source-error"]').text()).toContain('panel.htmlPreview.sourceLoadFailed')
      await wrapper.find('[data-testid="html-preview-source-retry"]').trigger('click')
      await flush()
      expect(wrapper.find('[data-testid="html-preview-source"]').exists()).toBe(true)
      expect(readArtifact).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['not_found', 'panel.detail.htmlReasonNotFound'],
    ['is_dir', 'panel.detail.htmlReasonIsDir'],
    ['out_of_whitelist', 'panel.htmlPreview.outOfWhitelist'],
    ['read_failed', 'panel.htmlPreview.sourceLoadFailed'],
  ] as const)('reject 附结构化 reason=%s → 错误行显对应词条 %s', async (reason, key) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // deps 契约形态：reason 结构化属性附于 reject 的 Error（useChatViewDeps 实装形态）
      const readArtifact = vi.fn()
        .mockRejectedValue(Object.assign(new Error(`localFileRead failed: ${reason}`), { reason }))
      const wrapper = await mountAndSwitchToSource(readArtifact)
      const errorLine = wrapper.find('[data-testid="html-preview-source-error"]')
      expect(errorLine.exists()).toBe(true)
      // t() mock 返回 key：断言 key 字面量即断言映射到位（真文案由 locale 双侧承载）
      expect(errorLine.text()).toContain(key)
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
    const wrapper = await mountAndSwitchToSource(readArtifact)
    const buttons = viewToggle(wrapper).findAll('button')
    await buttons[0].trigger('click')
    await flush()
    expect(frame(wrapper).exists()).toBe(true)
    expect(frame(wrapper).attributes('src')).toBe('local-file:///abs/report.html?r=1')
  })
})

// ======================================================================
// ← ToolResultImages.test.ts
// ======================================================================

/**
 * 每用例新建 image 对象。core 的路径记账表是内容 hash 记账 Map（imageKey——键为图片
 * data 的 hash，非对象引用），对象身份不构成用例间隔离：相同内容的图会命中上一用例
 * 的 ready 记账（getCachedImagePath 命中即短路 port 调用）。隔离靠 beforeEach 的
 * _resetImageCacheForTest()（Map.clear() 清空记账表），新建对象只是保持各用例字面自洽。
 */
function pngImg(): { data: string; mimeType: string } {
  return { data: 'aGVsbG8=', mimeType: 'image/png' }
}

function makePort(result: ImageCacheWriteResult, spy?: (sid: string, images: Array<{ data: string; mimeType: string }>) => void): ImageCacheWritePort {
  return (sid, images) => {
    spy?.(sid, images)
    return Promise.resolve(result)
  }
}

beforeEach(() => {
  _resetImageCacheForTest()
})

describe('ToolResultImages', () => {
  it('写盘成功：img 渲染 local-file:// 路径引用（非 base64 data URI）', async () => {
    const port = makePort({ results: [{ status: 'written', path: '/data/cache/images/s1/abc.png', bytes: 5 }], quotaFull: false })
    setImageCacheWritePort(port)
    const wrapper = mount(ToolResultImages, { props: { sessionId: 's1', images: [pngImg()] } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(true), { interval: 1 })
    const src = wrapper.find('[data-testid="tool-image"]').attributes('src')
    expect(src).toBe('local-file:///' + encodeURIComponent('/data/cache/images/s1/abc.png'))
    expect(src).not.toContain(pngImg().data)
  })

  it('W4a：btw 线 session id（pi 真实 id）直通落盘键（旧 btw: 前缀 extract 分支已删）', async () => {
    const seen: string[] = []
    const port = makePort({ results: [{ status: 'written', path: '/data/cache/images/line-pi-1/abc.png', bytes: 5 }], quotaFull: false }, (sid) => seen.push(sid))
    setImageCacheWritePort(port)
    // 线 id 即 pi 真实 id（无冒号）——normalizeCacheSessionId 直通，落盘目录键 = 线 id 本身
    const wrapper = mount(ToolResultImages, { props: { sessionId: 'line-pi-1', images: [pngImg()] } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(true), { interval: 1 })
    expect(seen).toEqual(['line-pi-1']) // 落盘键 = 线 session id 原值（无 extract 翻译）
    const src = wrapper.find('[data-testid="tool-image"]').attributes('src')
    expect(src).toBe('local-file:///' + encodeURIComponent('/data/cache/images/line-pi-1/abc.png'))
  })

  it('帽满占位：placeholder 元素 + 设计措辞文案（i18n key 渲染）', async () => {
    const port = makePort({ results: [{ status: 'quota-full' }], quotaFull: true })
    setImageCacheWritePort(port)
    const wrapper = mount(ToolResultImages, { props: { sessionId: 's2', images: [pngImg()] } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-placeholder"]').exists()).toBe(true), { interval: 1 })
    // setup 的 t() 返回 key 本身——key 渲染进 DOM 即组件 t() 渲染链验证；
    // 文案内容（设计原文措辞）由 locales 文件承载（见 zh-CN/panel.ts imagePlaceholder*）
    expect(wrapper.find('[data-testid="tool-image-placeholder"]').text()).toContain('panel.message.imagePlaceholder')
    expect(wrapper.find('[data-testid="tool-image-placeholder"]').attributes('title')).toContain('panel.message.imagePlaceholderDetail')
  })

  it('无 port（headless/mock 宿主）→ fallback badge，不抛错', async () => {
    const wrapper = mount(ToolResultImages, { props: { sessionId: 's3', images: [pngImg()] } })
    // resolveItem 是异步解析（pending 不出元素）——等微任务落地后断言
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-fallback"]').exists()).toBe(true), { interval: 1 })
  })

  it('hydrate 编排已记账（内容 hash 命中）→ 直接 ready 渲染，零 port 触发', async () => {
    let portCalls = 0
    const port: ImageCacheWritePort = (_sid, images) => {
      portCalls++
      return Promise.resolve({ results: images.map((i) => ({ status: 'written' as const, path: `/cache/${i.data}.png`, bytes: 1 })), quotaFull: false })
    }
    setImageCacheWritePort(port)
    // hydrate 编排（useChat.hydrateHistory 挂点的等价调用）：消息序收集 + 反序落盘记账
    const messages: Message[] = [
      { id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: 0, toolCalls: [{ id: 't1', toolName: 'shot', input: {}, status: 'completed', startTime: 0, images: [pngImg()] }] },
    ]
    const collected = collectImagesFromMessages(messages)
    await persistImagesNewestFirst('s4', collected)
    expect(portCalls).toBe(1)
    // 组件挂载：同内容命中记账，不再触发 port
    setImageCacheWritePort((_sid, images) => {
      portCalls++
      return Promise.resolve({ results: images.map(() => ({ status: 'written' as const, path: '/x.png', bytes: 1 })), quotaFull: false })
    })
    const wrapper = mount(ToolResultImages, { props: { sessionId: 's4', images: collected } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(true), { interval: 1 })
    expect(portCalls).toBe(1)
  })

  it('多图：每张独立解析（1 成功 1 帽满占位）', async () => {
    // 组件逐图单张调用（组件挂载兜底路径）——第 1 次调用 written、第 2 次 quota-full
    let calls = 0
    const port: ImageCacheWritePort = (_sid, images) => {
      calls++
      const first = calls === 1
      return Promise.resolve({
        results: images.map(() => (first ? { status: 'written' as const, path: '/ok.png', bytes: 1 } : { status: 'quota-full' as const })),
        quotaFull: !first,
      })
    }
    setImageCacheWritePort(port)
    const wrapper = mount(ToolResultImages, { props: { sessionId: 's5', images: [pngImg(), { data: 'aGVsbG8y', mimeType: 'image/png' }] } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(true), { interval: 1 })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-placeholder"]').exists()).toBe(true), { interval: 1 })
    expect(calls).toBe(2)
  })

  it('sessionId 缺省（null）→ fallback badge 且不发起写盘（无 session 分区键无法落盘）', async () => {
    let calls = 0
    setImageCacheWritePort(() => {
      calls++
      return Promise.resolve({ results: [], quotaFull: false })
    })
    const wrapper = mount(ToolResultImages, { props: { sessionId: null, images: [pngImg()] } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-fallback"]').exists()).toBe(true), { interval: 1 })
    expect(calls).toBe(0)
  })

  it('img 加载失败（@error）→ 降级 badge（文件被清理/损坏的运行期降级）', async () => {
    setImageCacheWritePort(
      makePort({ results: [{ status: 'written', path: '/data/cache/images/s6/gone.png', bytes: 5 }], quotaFull: false }),
    )
    const wrapper = mount(ToolResultImages, { props: { sessionId: 's6', images: [pngImg()] } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(true), { interval: 1 })
    await wrapper.find('[data-testid="tool-image"]').trigger('error')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-fallback"]').exists()).toBe(true), { interval: 1 })
    expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(false)
  })
})

// ======================================================================
// ← MarkdownRenderer.test.ts
// ======================================================================

// ── rAF 手动队列（异步语义，见文件头注释）──
const rafQueue: FrameRequestCallback[] = []
const originalRAF = globalThis.requestAnimationFrame
const originalCAF = globalThis.cancelAnimationFrame
beforeEach(() => {
  rafQueue.length = 0
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF
  globalThis.cancelAnimationFrame = originalCAF
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 触发一帧：执行已排队的 rAF 回调 + 等 doRender 异步链落定 */
async function flushRaf(): Promise<void> {
  const cbs = [...rafQueue]
  rafQueue.length = 0
  for (const cb of cbs) cb(0)
  await nextTick()
  await nextTick()
  await nextTick()
}

/** 构造增量 mock 的段/缓存工厂（协议形状对齐 renderer renderIncremental 输出） */
function seg(type: MarkdownSegment['type'], content: string, segId: number, extra: Partial<MarkdownSegment> = {}): MarkdownSegment {
  return { type, content, segId, ...extra }
}
function emptyCache(nextSegId: number): IncrementalMarkdownCache {
  return { boundary: 0, prefixText: '', prefixSegments: [], nextSegId }
}
type IncResult = IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }
function incResult(prefix: MarkdownSegment[], tail: MarkdownSegment[], cache: IncrementalMarkdownCache): IncResult {
  return { prefixSegments: prefix, tailSegments: tail, stableBoundary: 0, mode: 'incremental', cache }
}

/**
 * finalize 感知 mock 骨架（各 fence 语言分流用例共用）：记录每帧 finalize 标志（`record`），
 * 段产出策略由 `segmentFor` 给定（finalize / 非 finalize 两分支）。
 */
function makeFinalizeAwareMock(
  record: (source: string, finalize: boolean) => void,
  segmentFor: (source: string, finalize: boolean) => IncResult,
) {
  return vi.fn(
    async (source: string, _cache: IncrementalMarkdownCache | null, _sid?: string, opts?: { finalizeOpenFence?: boolean }): Promise<IncResult> => {
      const finalize = opts?.finalizeOpenFence === true
      record(source, finalize)
      return segmentFor(source, finalize)
    },
  )
}

/** 流式占位用例挂载骨架：mountMd（streaming + 静默阈值）→ flushRaf，返回 wrapper。 */
async function mountStreamingFence(
  content: string,
  renderMarkdownIncremental: ChatViewDeps['renderMarkdownIncremental'],
  streamingFenceSilenceMs = 200,
) {
  const wrapper = mountMd(
    { content, streaming: true },
    { renderMarkdownIncremental, streamingFenceSilenceMs },
  )
  await flushRaf()
  return wrapper
}

function mountMd(props: Record<string, unknown>, depsOverrides: Partial<ChatViewDeps> = {}) {
  return mount(MarkdownRenderer, {
    props: props as never,
    global: {
      provide: mockChatProvide(depsOverrides),
      stubs: {
        MermaidRenderer: true,
        // props 声明使 findComponent().props('open'/'candidates') 可断言（③路歧义浮层联动）
        AmbiguousFilePopover: {
          name: 'AmbiguousFilePopover',
          props: ['open', 'basename', 'candidates', 'anchorEl'],
          emits: ['update:open', 'select'],
          render: () => null,
        },
      },
    },
  })
}

/** finalize 感知 mock：记录每次调用的 finalize 标志；finalize=true 出完整代码块，否则出占位段 */
function finalizeAwareMock() {
  const calls: { source: string; finalize: boolean }[] = []
  const renderMarkdownIncremental = makeFinalizeAwareMock(
    (source, finalize) => calls.push({ source, finalize }),
    (source, finalize) =>
      finalize
        ? incResult([], [seg('text', '<div class="md-codeblock">code</div>', 0)], emptyCache(1))
        : incResult([], [seg('streaming-fence', 'code', 0, { lang: 'ts' })], emptyCache(1)),
  )
  return { calls, renderMarkdownIncremental }
}

describe('W23 ①: 增量更新只重渲染尾段（前缀段 DOM 引用跨帧稳定）', () => {
  it('前缀段 DOM 节点引用恒等，尾段节点重建', async () => {
    const segA = seg('text', '<p>para one</p>', 0)
    let call = 0
    const renderMarkdownIncremental = vi.fn(async (): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
      call += 1
      if (call === 1) return incResult([], [segA, seg('text', '<p>tail v1</p>', 1)], emptyCache(2))
      // 第二帧：segA 晋升为前缀（引用恒等），尾段重建
      return incResult([segA], [seg('text', '<p>tail v2</p>', 2)], emptyCache(3))
    })
    const wrapper = mountMd(
      { content: 'para one\n\ntail v1', streaming: true },
      { renderMarkdownIncremental },
    )
    await flushRaf()
    const divsBefore = wrapper.findAll('.md-render > div')
    expect(divsBefore).toHaveLength(2)
    const prefixEl = divsBefore[0].element

    await wrapper.setProps({ content: 'para one\n\ntail v2' } as never)
    await flushRaf()
    const divsAfter = wrapper.findAll('.md-render > div')
    expect(divsAfter).toHaveLength(2)
    // 前缀段 DOM 引用恒等（v-for :key=segId 命中，子树不触碰）
    expect(divsAfter[0].element).toBe(prefixEl)
    expect(divsAfter[0].html()).toContain('para one')
    // 尾段内容更新
    expect(divsAfter[1].html()).toContain('tail v2')
    expect(renderMarkdownIncremental).toHaveBeenCalledTimes(2)
  })
})

describe('W23 ②: streaming-fence 占位渲染（R-20：语言名 + loader 行，不加载重库）', () => {
  it('代码 fence 占位：语言名可见，无 shiki 产物（占位段不渲染代码块）', async () => {
    const renderMarkdownIncremental = vi.fn(async () =>
      incResult(
        [seg('text', '<p>intro</p>', 0)],
        [seg('streaming-fence', 'const a = 1', 1, { lang: 'ts', mermaid: false })],
        emptyCache(2),
      ),
    )
    const wrapper = mountMd(
      { content: 'intro\n\n```ts\nconst a = 1', streaming: true },
      { renderMarkdownIncremental },
    )
    await flushRaf()

    const placeholder = wrapper.find('[data-testid="md-streaming-fence"]')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.find('[data-testid="md-streaming-fence-lang"]').text()).toBe('ts')
    // 占位期无代码块产物（shiki/mermaid 都不跑）
    expect(wrapper.find('.md-codeblock').exists()).toBe(false)
    expect(wrapper.find('pre.shiki').exists()).toBe(false)
  })

  it('mermaid fence 占位：语言名可见，不加载 mermaid（无 MermaidRenderer 挂载）', async () => {
    const renderMermaid = vi.fn().mockResolvedValue({ svg: '<svg/>' })
    const renderMarkdownIncremental = vi.fn(async () =>
      incResult(
        [],
        [seg('streaming-fence', 'graph LR\nA-->B', 0, { lang: 'mermaid', mermaid: true })],
        emptyCache(1),
      ),
    )
    const wrapper = mountMd(
      { content: '```mermaid\ngraph LR\nA-->B', streaming: true },
      { renderMarkdownIncremental, renderMermaid },
    )
    await flushRaf()

    const placeholder = wrapper.find('[data-testid="md-streaming-fence"]')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.find('[data-testid="md-streaming-fence-lang"]').text()).toBe('mermaid')
    // finalize 前不加载 mermaid（无组件挂载、无渲染调用）
    expect(wrapper.findComponent({ name: 'MermaidRenderer' }).exists()).toBe(false)
    expect(renderMermaid).not.toHaveBeenCalled()
  })
})

describe('W23 ③: 静默/complete 转完整渲染（finalizeOpenFence:true）', () => {
  it('token 静默 ≥ 阈值 → 定时器触发 finalize 完整渲染', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { calls, renderMarkdownIncremental } = finalizeAwareMock()
    const wrapper = mountMd(
      { content: '```ts\ncode', streaming: true },
      { renderMarkdownIncremental, streamingFenceSilenceMs: 200 },
    )
    await flushRaf()
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].finalize).toBe(false)

    // 静默 250ms ≥ 阈值 200ms → finalize 定时器触发
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    await nextTick()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[calls.length - 1].finalize).toBe(true)
    // 占位被完整代码块替换
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
    expect(wrapper.find('.md-codeblock').exists()).toBe(true)
  })

  it('streaming true→false（消息 complete）→ 立即 finalize，不等静默', async () => {
    const { calls, renderMarkdownIncremental } = finalizeAwareMock()
    const wrapper = mountMd(
      { content: '```ts\ncode', streaming: true },
      { renderMarkdownIncremental, streamingFenceSilenceMs: 200 },
    )
    await flushRaf()
    expect(calls[0].finalize).toBe(false)

    await wrapper.setProps({ streaming: false } as never)
    await flushRaf()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[calls.length - 1].finalize).toBe(true)
    expect(wrapper.find('.md-codeblock').exists()).toBe(true)
  })

  it('静默未达阈值（远大于观测窗）→ 静默路径不触发，仅 complete 触发 finalize', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { calls, renderMarkdownIncremental } = finalizeAwareMock()
    mountMd(
      { content: '```ts\ncode', streaming: true },
      { renderMarkdownIncremental, streamingFenceSilenceMs: 60_000 },
    )
    await flushRaf()
    await vi.advanceTimersByTimeAsync(500)
    // 静默路径未命中（阈值 60s >> 500ms）：仍只有首帧渲染，无 finalize
    expect(calls).toHaveLength(1)
    expect(calls[0].finalize).toBe(false)
  })
})

describe('W23 review Fix-1: finalize 粘滞（停顿后继续不回占位横跳）', () => {
  it('finalize 后新 token 到达 → 保持完整渲染不回占位（DOM 断言）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { calls, renderMarkdownIncremental } = finalizeAwareMock()
    const wrapper = mountMd(
      { content: '```ts\ncode', streaming: true },
      { renderMarkdownIncremental, streamingFenceSilenceMs: 200 },
    )
    await flushRaf()
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].finalize).toBe(false)

    // 静默 250ms ≥ 阈值 200ms → finalize 定时器触发 → 完整代码块（占位消失）
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    await nextTick()
    expect(calls[calls.length - 1].finalize).toBe(true)
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
    expect(wrapper.find('.md-codeblock').exists()).toBe(true)

    // 新 token 到达（silenceMs≈0 → 判定 false）→ 粘滞保持 finalize=true，占位不回归
    await wrapper.setProps({ content: '```ts\ncode more' } as never)
    await flushRaf()
    expect(calls[calls.length - 1].finalize).toBe(true)
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
    expect(wrapper.find('.md-codeblock').exists()).toBe(true)
  })

  it('finalize 后 content 被改写（非 append-only 延长）→ 粘滞解除，finalize 保持 false 回占位', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { calls, renderMarkdownIncremental } = finalizeAwareMock()
    const wrapper = mountMd(
      { content: '```ts\ncode', streaming: true },
      { renderMarkdownIncremental, streamingFenceSilenceMs: 200 },
    )
    await flushRaf()
    expect(calls[0].finalize).toBe(false)

    // 静默 ≥ 阈值 → finalize 转完整（记录粘滞快照 = 当帧 content）
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    await nextTick()
    expect(calls[calls.length - 1].finalize).toBe(true)
    expect(wrapper.find('.md-codeblock').exists()).toBe(true)

    // content 被改写（非快照的 append-only 延长）→ 前缀等价不成立 → 粘滞解除：
    // silenceMs≈0 判定 false 且无快照可维持 → finalize 保持 false，占位回归
    await wrapper.setProps({ content: '```mermaid\ngraph LR' } as never)
    await flushRaf()
    expect(calls[calls.length - 1].finalize).toBe(false)
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)
    expect(wrapper.find('.md-codeblock').exists()).toBe(false)
  })
})

describe('W23 review Fix-2: 占位段固定哨兵 key（spinner 动画不因重建重启）', () => {
  it('连续两帧占位渲染 → 占位 DOM 节点引用恒等（segId 每帧递增也复用节点）', async () => {
    // 协议层行为：streaming-fence 占位段 segId 每帧 nextSegId++ 重分配
    let nextId = 0
    const renderMarkdownIncremental = vi.fn(async () => {
      nextId += 1
      return incResult([], [seg('streaming-fence', 'code', nextId, { lang: 'ts' })], emptyCache(nextId + 1))
    })
    const wrapper = mountMd(
      { content: '```ts\ncode v1', streaming: true },
      { renderMarkdownIncremental },
    )
    await flushRaf()
    const el1 = wrapper.find('[data-testid="md-streaming-fence"]').element

    await wrapper.setProps({ content: '```ts\ncode v2' } as never)
    await flushRaf()
    expect(renderMarkdownIncremental).toHaveBeenCalledTimes(2)
    const el2 = wrapper.find('[data-testid="md-streaming-fence"]').element
    // 固定哨兵 key 'sf' → v-for 复用同一 DOM 节点（CSS 动画不中断）；segId key 会重建
    expect(el2).toBe(el1)
  })
})

describe('W23 review Fix-3/4: latest-wins 串行 + 卸载清理', () => {
  /** deferred 版增量 mock：首帧挂起（in-flight），后续帧立即返回 */
  function deferredMock() {
    const sources: string[] = []
    let resolveFirst: ((r: IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }) => void) | null = null
    const renderMarkdownIncremental = vi.fn(
      async (source: string): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
        sources.push(source)
        if (sources.length === 1) {
          return new Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }>((res) => {
            resolveFirst = res
          })
        }
        return incResult([], [seg('text', `<p>${source}</p>`, sources.length - 1)], emptyCache(sources.length))
      },
    )
    return {
      sources,
      /** 首帧挂起 promise 的 resolver（getter 惰性取值：mock 首次调用后才可用，不能解构） */
      get resolveFirst(): ((r: IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }) => void) | null {
        return resolveFirst
      },
      renderMarkdownIncremental,
    }
  }

  it('latest-wins：in-flight 期间新请求合并，完成后只跑最新一条', async () => {
    const mock = deferredMock()
    const wrapper = mountMd({ content: 'v1', streaming: true }, { renderMarkdownIncremental: mock.renderMarkdownIncremental })
    await flushRaf()
    // in-flight 期间连续两次变更 → 合并为最新（v2 被 v3 覆盖）
    await wrapper.setProps({ content: 'v2' } as never)
    await flushRaf()
    await wrapper.setProps({ content: 'v3' } as never)
    await flushRaf()
    expect(mock.renderMarkdownIncremental).toHaveBeenCalledTimes(1)

    // 首帧落定 → 只消费最新 queued，v2 丢弃
    mock.resolveFirst?.(incResult([], [seg('text', '<p>v1</p>', 0)], emptyCache(1)))
    await flushRaf()
    await flushRaf()
    expect(mock.sources).toEqual(['v1', 'v3'])
    expect(wrapper.text()).toContain('v3')
    expect(wrapper.text()).not.toContain('v2')
  })

  it('卸载后挂起的 rAF 不再渲染（disposed 短路入口）', async () => {
    const renderMarkdownIncremental = vi.fn(async () => incResult([], [], emptyCache(0)))
    const wrapper = mountMd({ content: 'hello', streaming: true }, { renderMarkdownIncremental })
    // immediate watch 已排队 rAF，未 flush 即卸载；测试 harness 的 cancelAnimationFrame 是 no-op，
    // 队列里回调仍会被 flushRaf 执行——disposed 短路必须拦下渲染
    wrapper.unmount()
    await flushRaf()
    expect(renderMarkdownIncremental).not.toHaveBeenCalled()
  })

  it('卸载后 in-flight 落定不消费 queued、不再渲染', async () => {
    const mock = deferredMock()
    const wrapper = mountMd({ content: 'v1', streaming: true }, { renderMarkdownIncremental: mock.renderMarkdownIncremental })
    await flushRaf()
    await wrapper.setProps({ content: 'v2' } as never)
    await flushRaf() // v2 进 queued
    wrapper.unmount()

    mock.resolveFirst?.(incResult([], [seg('text', '<p>v1</p>', 0)], emptyCache(1)))
    await flushRaf()
    await flushRaf()
    // queued 被丢弃（disposed 短路 finally 分支），v2 永不渲染
    expect(mock.sources).toEqual(['v1'])
  })

  it('卸载后 in-flight 落定不重挂静默 finalize 定时器', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const mock = deferredMock()
    const wrapper = mountMd(
      { content: '```ts\ncode', streaming: true },
      { renderMarkdownIncremental: mock.renderMarkdownIncremental, streamingFenceSilenceMs: 200 },
    )
    await flushRaf()
    wrapper.unmount()
    // 首帧结果带 streaming-fence 占位段：若 in-flight 落定后照常 arm 定时器 → 推进时间会触发
    // 第二次渲染（旧实现无 disposed 检查）。新实现短路，定时器不重挂。
    mock.resolveFirst?.(incResult([], [seg('streaming-fence', 'code', 0, { lang: 'ts' })], emptyCache(1)))
    await vi.advanceTimersByTimeAsync(500)
    expect(mock.renderMarkdownIncremental).toHaveBeenCalledTimes(1)
  })
})

describe('W23: 增量渲染失败降级（等价旧版兜底 + 缓存作废）', () => {
  it('renderMarkdownIncremental reject → 转义纯文本可见，缓存句柄作废后下次重建', async () => {
    let call = 0
    const renderMarkdownIncremental = vi.fn(
      async (_source: string, cache: IncrementalMarkdownCache | null): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
        call += 1
        if (call === 1) throw new Error('shiki load failed')
        // 第二次调用断言收到 null 缓存（第一次失败后作废）
        expect(cache).toBeNull()
        return incResult([], [seg('text', '<p>recovered</p>', 0)], emptyCache(1))
      },
    )
    const wrapper = mountMd(
      { content: '<script>alert(1)</script>', streaming: true },
      { renderMarkdownIncremental },
    )
    await flushRaf()
    // 降级：原文可见且转义（无真 <script> 节点）
    expect(wrapper.text()).toContain('<script>alert(1)</script>')
    expect(wrapper.find('script').exists()).toBe(false)

    await wrapper.setProps({ content: 'second message' } as never)
    await flushRaf()
    expect(renderMarkdownIncremental).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('recovered')
  })

  it('空内容：segments 清空且缓存作废（新消息从头渲染）', async () => {
    const renderMarkdownIncremental = vi.fn(
      async (source: string, cache: IncrementalMarkdownCache | null): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
        if (!source.trim()) return { prefixSegments: [], tailSegments: [], stableBoundary: 0, mode: 'incremental', cache: cache ?? emptyCache(0) }
        return incResult([], [seg('text', `<p>${source}</p>`, 0)], emptyCache(1))
      },
    )
    const wrapper = mountMd({ content: 'hello', streaming: true }, { renderMarkdownIncremental })
    await flushRaf()
    expect(wrapper.findAll('.md-render > div')).toHaveLength(1)

    await wrapper.setProps({ content: '' } as never)
    await flushRaf()
    expect(wrapper.findAll('.md-render > *')).toHaveLength(0)
    // 空内容路径作废缓存：下次渲染收到 null
    await wrapper.setProps({ content: 'next' } as never)
    await flushRaf()
    const lastCall = renderMarkdownIncremental.mock.calls[renderMarkdownIncremental.mock.calls.length - 1]
    expect(lastCall?.[1]).toBeNull()
  })
})

// ── ④路相对链接分流（设计 markdown-html-sanitize-render D4，U3）──
// 渲染含 <a href> 的 text 段，点击冒泡到 .md-render 根的 onClick 委托，断言分流与 openDrawer 参数。
describe('D4 ④路: 相对链接分流（preventDefault + resolve + openDrawer detail）', () => {
  /** 挂载含单个 <a href> 文档的 MarkdownRenderer，收集冒泡 click 事件供 defaultPrevented 断言。
   *  renderMarkdownIncremental 必填（D6 收敛后无全量回退路径）：桥接 renderMarkdown 输出为
   *  单帧增量返回，使 depsOverrides 里 renderMarkdown 喂的内容真实进渲染树。 */
  async function mountWithAnchor(href: string, props: Record<string, unknown> = {}, depsOverrides: Partial<ChatViewDeps> = {}) {
    const renderMarkdown = vi.fn().mockResolvedValue([
      { type: 'text', content: `<p><a href="${href}">doc link</a></p>` },
    ])
    const renderMarkdownIncremental = vi.fn(
      async (source: string, cache: IncrementalMarkdownCache | null): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
        const tailSegments = (await renderMarkdown(source)) as MarkdownSegment[]
        return { prefixSegments: [], tailSegments, stableBoundary: 0, mode: 'incremental', cache: cache ?? emptyCache(0) }
      },
    )
    const wrapper = mountMd({ content: 'x', ...props }, { renderMarkdown, renderMarkdownIncremental, ...depsOverrides })
    await flushRaf()
    const clicks: Event[] = []
    wrapper.element.addEventListener('click', (e: Event) => clicks.push(e))
    await wrapper.find('a').trigger('click')
    return { wrapper, clicks }
  }

  it('相对 href + resourceBaseDir → preventDefault + openDrawer("detail", path.resolve 后的绝对路径)', async () => {
    const openDrawer = vi.fn()
    const { clicks } = await mountWithAnchor('docs/x.md', { resourceBaseDir: '/home/proj' }, { openDrawer })
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(openDrawer).toHaveBeenCalledTimes(1)
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: '/home/proj/docs/x.md' })
  })

  it('相对 href 嵌套段（../ 穿越按 POSIX resolve）+ onFileClick 不被调用（设计只走 openDrawer）', async () => {
    const openDrawer = vi.fn()
    const onFileClick = vi.fn()
    const { clicks } = await mountWithAnchor('../sibling.md', { resourceBaseDir: '/home/proj/sub' }, { openDrawer, onFileClick })
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: '/home/proj/sibling.md' })
    expect(onFileClick).not.toHaveBeenCalled()
  })

  it('# 锚点不拦截（默认冒泡走外链闸）', async () => {
    const openDrawer = vi.fn()
    const { clicks } = await mountWithAnchor('#section', { resourceBaseDir: '/home/proj' }, { openDrawer })
    expect(clicks[0]?.defaultPrevented).toBe(false)
    expect(openDrawer).not.toHaveBeenCalled()
  })

  it('// 协议相对不拦截（远程，走外链闸）', async () => {
    const openDrawer = vi.fn()
    const { clicks } = await mountWithAnchor('//cdn.example.com/a', { resourceBaseDir: '/home/proj' }, { openDrawer })
    expect(clicks[0]?.defaultPrevented).toBe(false)
    expect(openDrawer).not.toHaveBeenCalled()
  })

  it('https: scheme 不拦截', async () => {
    const openDrawer = vi.fn()
    const { clicks } = await mountWithAnchor('https://example.com/x', { resourceBaseDir: '/home/proj' }, { openDrawer })
    expect(clicks[0]?.defaultPrevented).toBe(false)
    expect(openDrawer).not.toHaveBeenCalled()
  })

  it('data: / mailto: scheme 不拦截（SCHEME_RE 全族）', async () => {
    const openDrawer = vi.fn()
    const { clicks } = await mountWithAnchor('mailto:a@b.c', { resourceBaseDir: '/home/proj' }, { openDrawer })
    expect(clicks[0]?.defaultPrevented).toBe(false)
    expect(openDrawer).not.toHaveBeenCalled()
  })

  it('resourceBaseDir 缺失 → preventDefault + 无动作（死链无害，优于窗口导航走）', async () => {
    const openDrawer = vi.fn()
    const { clicks } = await mountWithAnchor('docs/x.md', {}, { openDrawer })
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(openDrawer).not.toHaveBeenCalled()
  })

  it('props 缺省 → deps.sessionCwdOf fallback 按 session cwd resolve（D4 双通道：对话流/命令文档零模板传 props 的消费方）', async () => {
    const openDrawer = vi.fn()
    const sessionCwdOf = vi.fn((sid: string) => (sid === 's1' ? '/home/proj' : undefined))
    const { clicks } = await mountWithAnchor('docs/x.md', { sessionId: 's1' }, { openDrawer, sessionCwdOf })
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(sessionCwdOf).toHaveBeenCalledWith('s1')
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: '/home/proj/docs/x.md' })
  })

  it('props 覆盖优先：props 有值时不咨询 deps.sessionCwdOf（drawer 文件目录语义不被 session cwd 抢占）', async () => {
    const openDrawer = vi.fn()
    const sessionCwdOf = vi.fn(() => '/home/session-cwd')
    const { clicks } = await mountWithAnchor('docs/x.md', { sessionId: 's1', resourceBaseDir: '/home/proj' }, { openDrawer, sessionCwdOf })
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(sessionCwdOf).not.toHaveBeenCalled()
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: '/home/proj/docs/x.md' })
  })

  it('sessionCwdOf 返回 undefined（未知 sid）→ preventDefault + 无动作（fallback 缺省同样死链无害）', async () => {
    const openDrawer = vi.fn()
    const sessionCwdOf = vi.fn(() => undefined)
    const { clicks } = await mountWithAnchor('docs/x.md', { sessionId: 'ghost' }, { openDrawer, sessionCwdOf })
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(openDrawer).not.toHaveBeenCalled()
  })
})

// ── ⑤路浮层浏览器分流（display-containers §7.4 URL 注入链，u-w2-browser-mount）──
// http(s) localhost/127.0.0.1 链接点击 → deps.openBrowser（浮层 BrowserPane）；
// 其余链接维持系统浏览器（默认冒泡 → setWindowOpenHandler，§11-3 判定规则）。
describe('⑤路: 浮层浏览器分流（localhost 链接 → openBrowser，其余维持系统浏览器）', () => {
  /** 挂载含单个 <a href> 文档的 MarkdownRenderer，收集冒泡 click 事件供 defaultPrevented 断言
   *  （桥接形态同 ④路 mountWithAnchor：renderMarkdownIncremental 必填，单帧增量返回）。
   *  注意 href 含 :// 时不能用属性插值裸插（避免模板解析歧义），用转义 attr 形态。 */
  async function mountWithLink(href: string, props: Record<string, unknown> = {}, depsOverrides: Partial<ChatViewDeps> = {}) {
    const renderMarkdown = vi.fn().mockResolvedValue([
      { type: 'text', content: `<p><a href="${href}">dev server</a></p>` },
    ])
    const renderMarkdownIncremental = vi.fn(
      async (source: string, cache: IncrementalMarkdownCache | null): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
        const tailSegments = (await renderMarkdown(source)) as MarkdownSegment[]
        return { prefixSegments: [], tailSegments, stableBoundary: 0, mode: 'incremental', cache: cache ?? emptyCache(0) }
      },
    )
    const wrapper = mountMd({ content: 'x', ...props }, { renderMarkdown, renderMarkdownIncremental, ...depsOverrides })
    await flushRaf()
    const clicks: Event[] = []
    wrapper.element.addEventListener('click', (e: Event) => clicks.push(e))
    await wrapper.find('a').trigger('click')
    return { wrapper, clicks }
  }

  it('localhost 链接 + 发起会话 → preventDefault + openBrowser(url, sessionId)（URL 注入链，用户可见：浮层开浏览器页）', async () => {
    const openBrowser = vi.fn()
    const { clicks } = await mountWithLink('http://localhost:1420/', { sessionId: 's1' }, { openBrowser })
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(openBrowser).toHaveBeenCalledTimes(1)
    expect(openBrowser).toHaveBeenCalledWith('http://localhost:1420/', 's1')
  })

  it('127.0.0.1 链接同进浮层（白名单双主机，§11-3）', async () => {
    const openBrowser = vi.fn()
    const { clicks } = await mountWithLink('http://127.0.0.1:5173/dev', { sessionId: 's1' }, { openBrowser })
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(openBrowser).toHaveBeenCalledWith('http://127.0.0.1:5173/dev', 's1')
  })

  it('非 localhost http(s) 链接不进浮层（维持系统浏览器：不 preventDefault、不调 openBrowser）', async () => {
    const openBrowser = vi.fn()
    const { clicks } = await mountWithLink('https://example.com/docs', { sessionId: 's1' }, { openBrowser })
    expect(clicks[0]?.defaultPrevented).toBe(false)
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it('localhost 链接但无发起会话（sessionId 缺省宿主）→ 回落系统浏览器（不进浮层）', async () => {
    const openBrowser = vi.fn()
    const { clicks } = await mountWithLink('http://localhost:1420/', {}, { openBrowser })
    expect(clicks[0]?.defaultPrevented).toBe(false)
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it('相对链接仍走 ④路 openDrawer，不误入浮层（④⑤路分流共存回归锚）', async () => {
    const openBrowser = vi.fn()
    const openDrawer = vi.fn()
    const { clicks } = await mountWithLink('docs/x.md', { sessionId: 's1', resourceBaseDir: '/home/proj' }, { openBrowser, openDrawer })
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(openBrowser).not.toHaveBeenCalled()
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: '/home/proj/docs/x.md' })
  })
})

// ── ①②③路事件委托路由（复制按钮 / 文件路径 / 歧义 basename——D4 ④路之外的三路
//    存量行为；因 onClick 重构拆具名函数而成为本 diff 新增行，此处钉住用户可见行为）──
describe('①②③路: v-html 点击委托路由（copy / filepath / ambiguous）', () => {
  /** 挂载渲染任意 html text 段并收集冒泡 click 事件（供 defaultPrevented 断言）。
   *  renderMarkdownIncremental 必填（D6 收敛后无全量回退路径）：桥接 renderMarkdown 输出为
   *  单帧增量返回，使 depsOverrides 里 renderMarkdown 喂的内容真实进渲染树。 */
  async function mountWithHtml(html: string, props: Record<string, unknown> = {}, depsOverrides: Partial<ChatViewDeps> = {}) {
    const renderMarkdown = vi.fn().mockResolvedValue([{ type: 'text', content: html }])
    const renderMarkdownIncremental = vi.fn(
      async (source: string, cache: IncrementalMarkdownCache | null): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
        const tailSegments = (await renderMarkdown(source)) as MarkdownSegment[]
        return { prefixSegments: [], tailSegments, stableBoundary: 0, mode: 'incremental', cache: cache ?? emptyCache(0) }
      },
    )
    const wrapper = mountMd({ content: 'x', ...props }, { renderMarkdown, renderMarkdownIncremental, ...depsOverrides })
    await flushRaf()
    const clicks: Event[] = []
    wrapper.element.addEventListener('click', (e: Event) => clicks.push(e))
    return { wrapper, clicks }
  }

  /** stub navigator.clipboard（测试环境无真实剪贴板） */
  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return writeText
  }

  it('① 复制按钮 data-code 合法 → preventDefault + 剪贴板写入 + is-copied 反馈态', async () => {
    const writeText = stubClipboard()
    const { wrapper, clicks } = await mountWithHtml('<button class="md-codeblock__copy" data-code="Y29kZQ==">copy</button>')
    await wrapper.find('button.md-codeblock__copy').trigger('click')
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(writeText).toHaveBeenCalledWith('code')
    expect(wrapper.find('button.md-codeblock__copy').classes()).toContain('is-copied')
  })

  it('① base64 解码失败 → 不写剪贴板但反馈态保留（反馈态是唯一出口）', async () => {
    const writeText = stubClipboard()
    const { wrapper, clicks } = await mountWithHtml('<button class="md-codeblock__copy" data-code="!!illegal!!">copy</button>')
    await wrapper.find('button.md-codeblock__copy').trigger('click')
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
    expect(wrapper.find('button.md-codeblock__copy').classes()).toContain('is-copied')
  })

  it('② .md-filepath 带 data-path → onFileClick + openDrawer("detail")（base64 解码路径）', async () => {
    const onFileClick = vi.fn()
    const openDrawer = vi.fn()
    const b64 = btoa('/docs/readme.md')
    const { wrapper, clicks } = await mountWithHtml(`<a class="md-filepath" data-path="${b64}">/docs/readme.md</a>`, {}, { onFileClick, openDrawer })
    await wrapper.find('a.md-filepath').trigger('click')
    expect(clicks[0]?.defaultPrevented).toBe(true)
    expect(onFileClick).toHaveBeenCalledWith('/docs/readme.md')
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: '/docs/readme.md' })
  })

  it('② data-path 缺失 → fallback textContent 仍打开（sanitize 降级路径的兜底）', async () => {
    const onFileClick = vi.fn()
    const openDrawer = vi.fn()
    const { wrapper } = await mountWithHtml('<a class="md-filepath">src/a.ts</a>', {}, { onFileClick, openDrawer })
    await wrapper.find('a.md-filepath').trigger('click')
    expect(onFileClick).toHaveBeenCalledWith('src/a.ts')
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: 'src/a.ts' })
  })

  it('③ .md-ambiguous → preventDefault + 浮层 open + 经 deps 加载候选并按 basename 过滤', async () => {
    const loadFileCandidates = vi.fn().mockResolvedValue([
      { path: 'a/foo.ts', name: 'foo.ts', type: 'file' },
      { path: 'b/foo.ts', name: 'foo.ts', type: 'file' },
      { path: 'c/bar.ts', name: 'bar.ts', type: 'file' },
    ])
    const { wrapper, clicks } = await mountWithHtml('<a class="md-ambiguous">foo.ts</a>', { sessionId: 's1' }, { loadFileCandidates })
    await wrapper.find('a.md-ambiguous').trigger('click')
    expect(clicks[0]?.defaultPrevented).toBe(true)
    await nextTick()
    await nextTick()
    expect(loadFileCandidates).toHaveBeenCalledWith('s1', 'foo.ts')
    const popover = wrapper.findComponent({ name: 'AmbiguousFilePopover' })
    expect(popover.props('open')).toBe(true)
    expect(popover.props('basename')).toBe('foo.ts')
    expect(popover.props('candidates')).toHaveLength(2)
  })

  it('③ 浮层 select → onFileClick + openDrawer("detail") + 浮层关闭', async () => {
    const onFileClick = vi.fn()
    const openDrawer = vi.fn()
    const loadFileCandidates = vi.fn().mockResolvedValue([{ path: 'a/foo.ts', name: 'foo.ts', type: 'file' }])
    const { wrapper } = await mountWithHtml('<a class="md-ambiguous">foo.ts</a>', { sessionId: 's1' }, { onFileClick, openDrawer, loadFileCandidates })
    await wrapper.find('a.md-ambiguous').trigger('click')
    await nextTick()
    const popover = wrapper.findComponent({ name: 'AmbiguousFilePopover' })
    popover.vm.$emit('select', 'a/foo.ts')
    await nextTick()
    expect(onFileClick).toHaveBeenCalledWith('a/foo.ts')
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: 'a/foo.ts' })
    expect(wrapper.findComponent({ name: 'AmbiguousFilePopover' }).props('open')).toBe(false)
  })
})

describe('chat-html-support §6.3 D3: html-preview 段 finalize 分流（静默不提前 finalize）', () => {
  /** html-preview 感知 mock：finalize 或 fence 已收尾（content 尾行为闭行）→ html-preview 段；
   *  否则 streaming-fence 占位（lang=html-preview）。记录每帧 finalize 标志。 */
  function htmlPreviewMock() {
    const calls: boolean[] = []
    const isClosed = (s: string): boolean => s.trimEnd().endsWith('```')
    const renderMarkdownIncremental = makeFinalizeAwareMock(
      (_source, finalize) => calls.push(finalize),
      (source, finalize) => {
        if (finalize || isClosed(source)) {
          return incResult([], [seg('html-preview', '/abs/report.html', 0)], emptyCache(1))
        }
        return incResult([], [seg('streaming-fence', '/abs/report.html', 0, { lang: 'html-preview' })], emptyCache(1))
      },
    )
    return { calls, renderMarkdownIncremental }
  }

  it('静默 ≥200ms 不提前 finalize（不挂静默定时器），fence 收尾后一次成型', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { calls, renderMarkdownIncremental } = htmlPreviewMock()
    const wrapper = await mountStreamingFence('```html-preview\n/abs/report.html', renderMarkdownIncremental)
    // 首帧：占位（lang=html-preview）、无卡片
    expect(calls).toEqual([false])
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="html-preview-inline"]').exists()).toBe(false)

    // 静默远超阈值：不挂定时器 → 无第二次渲染、占位保持（半截路径不产假降级卡片）
    await vi.advanceTimersByTimeAsync(1000)
    await nextTick()
    expect(calls).toEqual([false])
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="html-preview-inline"]').exists()).toBe(false)

    // fence 收尾标记到达 → 一次成型成卡片
    await wrapper.setProps({ content: '```html-preview\n/abs/report.html\n```' } as never)
    await flushRaf()
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="html-preview-inline"]').exists()).toBe(true)
  })

  it('mermaid fence 静默提前 finalize 保留不变（部分图形提前渲染有价值）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls: boolean[] = []
    const renderMarkdownIncremental = makeFinalizeAwareMock(
      (_source, finalize) => calls.push(finalize),
      (_source, finalize) =>
        finalize
          ? incResult([], [seg('mermaid', 'graph LR', 0)], emptyCache(1))
          : incResult([], [seg('streaming-fence', 'graph LR', 0, { lang: 'mermaid' })], emptyCache(1)),
    )
    const wrapper = await mountStreamingFence('```mermaid\ngraph LR', renderMarkdownIncremental)
    expect(calls).toEqual([false])
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    await nextTick()
    expect(calls[calls.length - 1]).toBe(true)
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
  })

  it('首现竞态兜底：静默条件在 html-preview fence 新开帧命中 → 撤回 finalize 重渲染为占位', async () => {
    // 阈值 0 强制静默条件恒真，模拟「本轮才新开的 fence + 上一帧 openFenceLang 未知」的误 finalize 帧
    const { calls, renderMarkdownIncremental } = htmlPreviewMock()
    const wrapper = await mountStreamingFence('```html-preview\n/abs/report.html', renderMarkdownIncremental, 0)
    // 首帧 finalize=true 落了 html-preview 段 → 检出后撤回重渲染为占位（calls=[true,false]）
    expect(calls).toEqual([true, false])
    expect(wrapper.find('[data-testid="html-preview-inline"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)
  })
})
