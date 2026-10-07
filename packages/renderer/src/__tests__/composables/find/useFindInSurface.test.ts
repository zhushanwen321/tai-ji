/**
 * useFindInSurface 状态流转单测（find-in-surface 设计留档 §3 单例契约）。
 *
 * 模块级单例 → 用例间经 close() 复位（幂等，等价 reset）。DOM 交互点（elementFromPoint
 * 悬停归属 / 表面根查询）用 spy + 真实 DOM 节点验证，不 mock 域逻辑。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/find/
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFindInSurface } from '@/composables/features/find/useFindInSurface'

const find = useFindInSurface()

function mountSurface(kind: string): HTMLElement {
  const host = document.createElement('div')
  host.setAttribute('data-find-surface', kind)
  host.innerHTML = '<p>foo bar foo</p>'
  document.body.appendChild(host)
  return host
}

function mockElementFromPoint(el: Element | null): void {
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(el as HTMLElement | null)
}

/** 模拟指针移动（悬停归属的数据源 = window pointermove 坐标） */
function movePointer(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }))
}

beforeEach(() => {
  find.close()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('open / close / search 状态流转', () => {
  it('open：置 isOpen + surfaceKind，重置旧现场（query/命中）', () => {
    mountSurface('right-drawer')
    find.open('right-drawer')
    find.query.value = 'foo'
    find.search()
    expect(find.hitCount.value).toBe(2)

    find.open('bottom-drawer')
    expect(find.isOpen.value).toBe(true)
    expect(find.surfaceKind.value).toBe('bottom-drawer')
    expect(find.query.value).toBe('')
    expect(find.hitCount.value).toBe(0)
  })

  it('同 kind 重复 open：保留现场（query 不清）', () => {
    mountSurface('right-drawer')
    find.open('right-drawer')
    find.query.value = 'foo'
    find.search()
    find.open('right-drawer')
    expect(find.query.value).toBe('foo')
    expect(find.hitCount.value).toBe(2)
  })

  it('search：命中计数 + activeIndex 落 0', () => {
    mountSurface('right-drawer')
    find.open('right-drawer')
    find.query.value = 'foo'
    find.search()
    expect(find.hitCount.value).toBe(2)
    expect(find.activeIndex.value).toBe(0)
  })

  it('search：空 query → 0 命中', () => {
    mountSurface('right-drawer')
    find.open('right-drawer')
    find.search()
    expect(find.hitCount.value).toBe(0)
    expect(find.activeIndex.value).toBe(-1)
  })

  it('search：表面根元素不在文档（表面已关）→ 清结果不报错', () => {
    find.open('right-drawer')
    find.query.value = 'foo'
    expect(() => find.search()).not.toThrow()
    expect(find.hitCount.value).toBe(0)
  })

  it('next/prev：循环导航（尾→首 / 首→尾）', () => {
    mountSurface('right-drawer')
    find.open('right-drawer')
    find.query.value = 'foo'
    find.search()
    expect(find.activeIndex.value).toBe(0)
    find.next()
    expect(find.activeIndex.value).toBe(1)
    find.next()
    expect(find.activeIndex.value, '尾部 next 回绕到首').toBe(0)
    find.prev()
    expect(find.activeIndex.value, '首部 prev 回绕到尾').toBe(1)
  })

  it('close：全清（isOpen/query/命中/高亮归属），且幂等', () => {
    mountSurface('right-drawer')
    find.open('right-drawer')
    find.query.value = 'foo'
    find.search()
    find.close()
    expect(find.isOpen.value).toBe(false)
    expect(find.surfaceKind.value).toBe('')
    expect(find.query.value).toBe('')
    expect(find.hitCount.value).toBe(0)
    expect(find.activeIndex.value).toBe(-1)
    expect(() => find.close()).not.toThrow()
  })
})

describe('openFindAtPointer 归属判定', () => {
  it('悬停优先：指针在 bottom-drawer 表面内 → 开 bottom-drawer（即使 overlay 也在文档）', () => {
    const overlayEl = mountSurface('overlay')
    const bottomEl = mountSurface('bottom-drawer')
    mockElementFromPoint(bottomEl.querySelector('p')!)
    movePointer(10, 10)
    find.openFindAtPointer()
    expect(find.surfaceKind.value).toBe('bottom-drawer')
    expect(overlayEl.isConnected).toBe(true)
  })

  it('回退栈序：悬停不在任何可搜表面 → overlay > bottom-drawer > right-drawer 取第一个在文档的', () => {
    mockElementFromPoint(document.createElement('div'))
    movePointer(10, 10)
    find.openFindAtPointer()
    expect(find.surfaceKind.value).toBe('') // 三个表面都不在文档 → 不动作

    mountSurface('right-drawer')
    find.close()
    find.openFindAtPointer()
    expect(find.surfaceKind.value, '只有 right-drawer → 回退开它').toBe('right-drawer')

    mountSurface('bottom-drawer')
    find.close()
    find.openFindAtPointer()
    expect(find.surfaceKind.value, 'bottom-drawer 优先于 right-drawer').toBe('bottom-drawer')

    mountSurface('overlay')
    find.close()
    find.openFindAtPointer()
    expect(find.surfaceKind.value, 'overlay 最高优先').toBe('overlay')
  })

  it('focusTick：每次触发自增（FindBar 据此聚焦输入框）', () => {
    mountSurface('right-drawer')
    mockElementFromPoint(null)
    movePointer(1, 2)
    const before = find.focusTick.value
    find.openFindAtPointer()
    expect(find.focusTick.value).toBe(before + 1)
    find.openFindAtPointer()
    expect(find.focusTick.value).toBe(before + 2)
  })
})
