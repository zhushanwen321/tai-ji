/**
 * ImageThumb + Turn image segment 渲染单测（w6 从 renderer 迁入 ui）。
 *
 * 覆盖：
 * - 正常 path → 渲染 img，src 含编码后 path
 * - img error → 降级绿色 badge，含 displayName
 * - 空 path → 直接降级 badge
 * - Turn 传入无 image segments → 无 img 也无 fallback badge
 * - Turn 传入 3 个 image segment → 渲染 3 个缩略图/badge
 *
 * Turn 部分改 provide mock ChatViewDeps（替代 renderer 旧 vi.mock(useChat/useSideDrawer/useFileTreeStore)）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { ImageThumb, Turn } from '@taiji/ui'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { Message, Segment } from '@taiji/shared'
import { mockChatProvide } from './helpers'

describe('ImageThumb', () => {
  it('正常 path 渲染 img，src 含编码后 path', () => {
    const wrapper = mount(ImageThumb, {
      props: { path: '/tmp/foo.png', displayName: 'foo.png' },
    })
    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('local-file:///' + encodeURIComponent('/tmp/foo.png'))
    expect(wrapper.find('.image-fallback-badge').exists()).toBe(false)
  })

  it('img error → 降级绿色 badge，含 displayName 文本', async () => {
    const wrapper = mount(ImageThumb, {
      props: { path: '/nonexistent/missing.png', displayName: 'missing.png' },
    })
    expect(wrapper.find('img').exists()).toBe(true)
    await wrapper.find('img').trigger('error')
    await nextTick()
    expect(wrapper.find('.image-fallback-badge').exists()).toBe(true)
    expect(wrapper.text()).toContain('missing.png')
  })

  it('空 path → 不渲染 img，直接降级 badge', () => {
    const wrapper = mount(ImageThumb, {
      props: { path: '', displayName: 'empty.png' },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.image-fallback-badge').exists()).toBe(true)
    expect(wrapper.text()).toContain('empty.png')
  })
})

describe('Turn image segment 集成', () => {
  function makeTurn(content: Segment[]): MessageTurn {
    return {
      index: 1,
      user: {
        id: 'u1',
        role: 'user',
        content,
        status: 'complete',
        timestamp: Date.now(),
      } satisfies Message,
      assistants: [],
      isStreaming: false,
      hasFoldable: false,
    }
  }

  function mountTurn(turn: MessageTurn, sessionId = 's1') {
    return mount(Turn, {
      props: { turn, sessionId },
      global: { provide: mockChatProvide() },
    })
  }

  it('无 image segment → 不渲染 img.image-thumb 也不渲染 fallback badge', () => {
    const turn = makeTurn([
      { type: 'text', text: '看下这个文件' },
      { type: 'file', path: 'src/foo.ts' },
    ])
    const wrapper = mountTurn(turn)
    expect(wrapper.find('img.image-thumb').exists()).toBe(false)
    expect(wrapper.find('.image-fallback-badge').exists()).toBe(false)
  })

  it('3 个 image segment → 渲染 3 个缩略图/badge', () => {
    const turn = makeTurn([
      { type: 'image', id: 'img1', path: '/tmp/a.png', fileName: 'a.png', displayName: 'a.png' },
      { type: 'image', id: 'img2', path: '/tmp/b.png', fileName: 'b.png', displayName: 'b.png' },
      { type: 'image', id: 'img3', path: '', fileName: 'c.png', displayName: 'c.png' },
    ])
    const wrapper = mountTurn(turn)
    const items = wrapper.findAll('img.image-thumb, .image-fallback-badge')
    expect(items).toHaveLength(3)
  })
})
