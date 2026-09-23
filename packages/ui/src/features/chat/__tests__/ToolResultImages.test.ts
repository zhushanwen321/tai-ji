/**
 * ToolResultImages 渲染测试（D6-⑨ / u7-memory-governance）。
 *
 * 覆盖（验收：图片消息路径引用渲染 + 占位文案 DOM 断言）：
 * - live 写盘路径：port 返回 path → img 渲染 local-file:// 路径引用（base64 不进 src）
 * - 帽满占位：port 返回 quota-full → placeholder 元素 + 设计措辞文案（i18n key 渲染链）
 * - 无 port（mock/headless 宿主）→ fallback badge 降级
 * - hydrate 编排已记账（内容 hash 命中）→ 直接渲染，不再触发 port
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ImageCacheWriteResult } from '@taiji/shared'
import { ToolResultImages } from '@taiji/ui'
import {
  collectImagesFromMessages,
  persistImagesNewestFirst,
  setImageCacheWritePort,
  _resetImageCacheForTest,
  type ImageCacheWritePort,
} from '@taiji/core/domain/chat'
import type { Message } from '@taiji/shared'

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
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(true))
    const src = wrapper.find('[data-testid="tool-image"]').attributes('src')
    expect(src).toBe('local-file:///' + encodeURIComponent('/data/cache/images/s1/abc.png'))
    expect(src).not.toContain(pngImg().data)
  })

  it('帽满占位：placeholder 元素 + 设计措辞文案（i18n key 渲染）', async () => {
    const port = makePort({ results: [{ status: 'quota-full' }], quotaFull: true })
    setImageCacheWritePort(port)
    const wrapper = mount(ToolResultImages, { props: { sessionId: 's2', images: [pngImg()] } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-placeholder"]').exists()).toBe(true))
    // setup 的 t() 返回 key 本身——key 渲染进 DOM 即组件 t() 渲染链验证；
    // 文案内容（设计原文措辞）由 locales 文件承载（见 zh-CN/panel.ts imagePlaceholder*）
    expect(wrapper.find('[data-testid="tool-image-placeholder"]').text()).toContain('panel.message.imagePlaceholder')
    expect(wrapper.find('[data-testid="tool-image-placeholder"]').attributes('title')).toContain('panel.message.imagePlaceholderDetail')
  })

  it('无 port（headless/mock 宿主）→ fallback badge，不抛错', async () => {
    const wrapper = mount(ToolResultImages, { props: { sessionId: 's3', images: [pngImg()] } })
    // resolveItem 是异步解析（pending 不出元素）——等微任务落地后断言
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-fallback"]').exists()).toBe(true))
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
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(true))
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
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(true))
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-placeholder"]').exists()).toBe(true))
    expect(calls).toBe(2)
  })

  it('sessionId 缺省（null）→ fallback badge 且不发起写盘（无 session 分区键无法落盘）', async () => {
    let calls = 0
    setImageCacheWritePort(() => {
      calls++
      return Promise.resolve({ results: [], quotaFull: false })
    })
    const wrapper = mount(ToolResultImages, { props: { sessionId: null, images: [pngImg()] } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-fallback"]').exists()).toBe(true))
    expect(calls).toBe(0)
  })

  it('img 加载失败（@error）→ 降级 badge（文件被清理/损坏的运行期降级）', async () => {
    setImageCacheWritePort(
      makePort({ results: [{ status: 'written', path: '/data/cache/images/s6/gone.png', bytes: 5 }], quotaFull: false }),
    )
    const wrapper = mount(ToolResultImages, { props: { sessionId: 's6', images: [pngImg()] } })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(true))
    await wrapper.find('[data-testid="tool-image"]').trigger('error')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tool-image-fallback"]').exists()).toBe(true))
    expect(wrapper.find('[data-testid="tool-image"]').exists()).toBe(false)
  })
})
