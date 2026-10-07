/**
 * highlight-painter 单测（find-in-surface 设计留档 §3 契约）。
 *
 * happy-dom 无 CSS.highlights / Highlight → 测试注入最小 mock（Map + 记录构造参数的
 * 可构造类），painter 对 API 形状的消费面即被逐条断言。覆盖：paint/clear、activeIndex
 * 无效时只画 find-hits、失效 range（startContainer 离开文档）防御跳过、API 缺席时静默。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { clearHits, paintHits } from '@/composables/features/find/highlight-painter'

/** CSS.highlights 注册表的测试读点（painter 写入的最小 mock） */
function registry(): Map<string, unknown> {
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS
  return css!.highlights as Map<string, unknown>
}

/** Highlight 构造参数记录（断言 painter 传入了哪些 range） */
class FakeHighlight {
  static lastArgs: unknown[] = []
  constructor(...ranges: unknown[]) {
    FakeHighlight.lastArgs = ranges
  }
}

function installHighlightApi(): void {
  ;(globalThis as { CSS?: unknown }).CSS = { highlights: new Map() }
  ;(globalThis as { Highlight?: unknown }).Highlight = FakeHighlight
}

function makeRange(live: boolean): Range {
  const host = document.createElement('span')
  host.textContent = 'needle'
  document.body.appendChild(host)
  const range = document.createRange()
  range.selectNodeContents(host)
  if (!live) host.remove() // startContainer 离开文档 = 失效 range（重渲染替换后的快照残留）
  return range
}

afterEach(() => {
  delete (globalThis as { CSS?: unknown }).CSS
  delete (globalThis as { Highlight?: unknown }).Highlight
  document.body.innerHTML = ''
})

describe('paintHits', () => {
  it('正常绘制：find-hits 收非 active 命中，find-active 收 active 命中', () => {
    installHighlightApi()
    const r1 = makeRange(true)
    const r2 = makeRange(true)
    paintHits([r1, r2], 1)
    expect(registry().get('find-hits')).toBeInstanceOf(FakeHighlight)
    expect(registry().get('find-active')).toBeInstanceOf(FakeHighlight)
  })

  it('activeIndex -1：只画 find-hits，且清掉残留的 find-active', () => {
    installHighlightApi()
    const r1 = makeRange(true)
    registry().set('find-active', new FakeHighlight())
    paintHits([r1], -1)
    expect(registry().has('find-active')).toBe(false)
    expect(registry().has('find-hits')).toBe(true)
  })

  it('activeIndex 越界：等同无效，不画 find-active', () => {
    installHighlightApi()
    const r1 = makeRange(true)
    paintHits([r1], 5)
    expect(registry().has('find-active')).toBe(false)
  })

  it('失效 range 防御：startContainer 不在文档中的命中被跳过不画', () => {
    installHighlightApi()
    const live = makeRange(true)
    const dead = makeRange(false)
    paintHits([dead, live], -1)
    expect(registry().get('find-hits')).toBeInstanceOf(FakeHighlight)
    // find-hits 的 Highlight 只收到 1 个 live range
    expect(FakeHighlight.lastArgs).toEqual([live])
  })

  it('active 命中失效：不画 find-active，其余命中照画', () => {
    installHighlightApi()
    const live = makeRange(true)
    const dead = makeRange(false)
    paintHits([live, dead], 1)
    expect(registry().has('find-active')).toBe(false)
    expect(registry().has('find-hits')).toBe(true)
  })

  it('CSS.highlights API 不存在（旧环境）：静默 no-op 不抛错', () => {
    delete (globalThis as { CSS?: unknown }).CSS
    expect(() => paintHits([makeRange(true)], 0)).not.toThrow()
    expect(() => clearHits()).not.toThrow()
  })
})

describe('clearHits', () => {
  it('清除 find-hits 与 find-active 两个注册键', () => {
    installHighlightApi()
    registry().set('find-hits', new FakeHighlight())
    registry().set('find-active', new FakeHighlight())
    clearHits()
    expect(registry().size).toBe(0)
  })
})
