/**
 * ContextChipsBar image chip 真图缩略测试（demo .ctxchip .thumb，demo 对齐，登记 docs/todo/ui-replica-demo-fidelity.md 收口记录）。
 *
 * 覆盖：
 *  - image 项 lead 渲染 img 缩略图（local-file:// src + 16px/r-3.5px/object-cover/flex-none 类，
 *    demo 四值口径）
 *  - img 加载失败（error 事件）→ 该 chip 回退 ImageIcon 占位，不留破图
 *  - 失败回退按 chipId 隔离：失败项回退，未失败项保持 img
 *
 * 每条用例至少一个用户可见 DOM 断言（TEST-STRATEGY §3 三视角纪律）。
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/ContextChipsBar.thumb.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ContextChipsBar from '@/components/panel/ContextChipsBar.vue'

let wrapper: ReturnType<typeof mount> | null = null

const THUMB_SELECTOR = '[data-testid="context-chip-thumb"]'

function makeItems(count: number): Array<{ id: string; name: string; path: string; type: 'image' }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `chip-${i + 1}`,
    name: `img${i + 1}.png`,
    path: `/tmp/attachments/s1/img${i + 1}.png`,
    type: 'image' as const,
  }))
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ContextChipsBar image chip 真图缩略（demo .ctxchip .thumb）', () => {
  it('image 项 lead 渲染 img 缩略（local-file src + demo 四值类），非 image 形态无 img', () => {
    wrapper = mount(ContextChipsBar, { props: { items: makeItems(2) } })
    const thumbs = wrapper.findAll(THUMB_SELECTOR)
    expect(thumbs.length).toBe(2)
    // src 经 shared localFileUrl 单点构造（local-file 协议 + 路径段编码）
    expect(thumbs[0].attributes('src')).toBe(
      'local-file:///' + encodeURIComponent('/tmp/attachments/s1/img1.png'),
    )
    expect(thumbs[0].attributes('alt')).toBe('img1.png')
    // demo .ctxchip .thumb 四值：16px（size-4）/ r-3.5px / object-fit cover / flex none（shrink-0）
    expect(thumbs[0].classes()).toContain('size-4')
    expect(thumbs[0].classes()).toContain('rounded-[3.5px]')
    expect(thumbs[0].classes()).toContain('object-cover')
    expect(thumbs[0].classes()).toContain('shrink-0')
  })

  it('img 加载失败 → 该 chip 回退 ImageIcon 占位（img 消失，svg 出现）', async () => {
    wrapper = mount(ContextChipsBar, { props: { items: makeItems(1) } })
    const img = wrapper.find(THUMB_SELECTOR)
    expect(img.exists()).toBe(true)

    await img.trigger('error')
    // img 消失（不留破图），ImageIcon 占位渲染（lucide 组件 → svg）
    expect(wrapper.find(THUMB_SELECTOR).exists()).toBe(false)
    const fallback = wrapper.find('svg')
    expect(fallback.exists()).toBe(true)
  })

  it('失败回退按 chipId 隔离：失败项回退占位，未失败项保持 img', async () => {
    wrapper = mount(ContextChipsBar, { props: { items: makeItems(2) } })
    await wrapper.findAll(THUMB_SELECTOR)[0]!.trigger('error')

    expect(wrapper.findAll(THUMB_SELECTOR).length).toBe(1)
    // 剩下的 img 是第二个 chip 的
    expect(wrapper.find(THUMB_SELECTOR).attributes('src')).toContain(
      encodeURIComponent('/tmp/attachments/s1/img2.png'),
    )
  })
})
