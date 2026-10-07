/**
 * dom-locator 单测（find-in-surface 设计留档 §3 第一期实现契约）。
 *
 * 覆盖：跨节点拼接命中 / 大小写不敏感 / data-find-skip 子树排除 / script 排除 /
 * 空 query / 无命中 / 多命中 / 命中不重叠。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/find/
 */
import { afterEach, describe, expect, it } from 'vitest'
import { locateInDom } from '@/composables/features/find/dom-locator'

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('locateInDom', () => {
  it('空 query 返回 []', () => {
    const host = mount('<p>hello</p>')
    expect(locateInDom(host, '')).toEqual([])
  })

  it('无命中返回 []', () => {
    const host = mount('<p>hello world</p>')
    expect(locateInDom(host, 'xyz')).toEqual([])
  })

  it('单节点命中：大小写不敏感，range 覆盖命中区间', () => {
    const host = mount('<p>Hello World</p>')
    const ranges = locateInDom(host, 'WORLD')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('World')
  })

  it('跨节点拼接命中：命中跨越相邻文本节点（inline 标签切开）', () => {
    const host = mount('<p>Hello <b>World</b></p>')
    // "o Wor"：前半在 "Hello " 文本节点，后半在 <b> 内文本节点——单节点扫描必漏
    const ranges = locateInDom(host, 'o Wor')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('o Wor')
    expect(ranges[0].startContainer.nodeType).toBe(Node.TEXT_NODE)
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('P')
    expect(ranges[0].endContainer.parentElement?.tagName).toBe('B')
  })

  it('多命中：返回全部出现位置', () => {
    const host = mount('<p>ab cd ab</p>')
    const ranges = locateInDom(host, 'ab')
    expect(ranges).toHaveLength(2)
    expect(ranges.map((r) => r.toString())).toEqual(['ab', 'ab'])
  })

  it('命中不重叠："aaa" 搜 "aa" 报 1 个（步进命中长度）', () => {
    const host = mount('<p>aaa</p>')
    expect(locateInDom(host, 'aa')).toHaveLength(1)
  })

  it('data-find-skip 子树整体排除（终端等第一期排除区）', () => {
    const host = mount(
      '<div><span>needle here</span><div data-find-skip><span>needle</span></div></div>',
    )
    const ranges = locateInDom(host, 'needle')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('needle')
    // 剩下的那一个来自 skip 之外的 span
    expect(ranges[0].startContainer.parentElement?.closest('[data-find-skip]')).toBeNull()
  })

  it('script 内容排除', () => {
    const host = mount('<div><script>const needle = 1</script><span>needle</span></div>')
    const ranges = locateInDom(host, 'needle')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('SPAN')
  })
})
