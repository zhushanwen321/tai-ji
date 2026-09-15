/**
 * useSelectionRestore 单测 —— composer 选区保存/恢复工厂（selection-restore.ts）。
 *
 * 覆盖（轮 3-4 · RC-A-9 加固面）：
 * - 分支①：活选区两端均在编辑器内 → 采信活选区，savedRange 不覆盖（D1）
 * - 分支②：savedRange 为空 + 活选区跨边界/在编辑器外 → 回焦并清掉越界活选区
 *   （缺此步时下游 insertChipAtSelection 的 range.deleteContents() 会作用到编辑器外 DOM）
 * - 分支②：savedRange 为空 + 本就无活选区 → 仅回焦，不触碰选区（既有兜底语义保持）
 *
 * 独立成文件的原因：restoreSelection 的跨边界加固是本轮改动面，用例需要直接构造
 * 「anchor 在编辑器内、focus 在编辑器外」的 Selection；contenteditable.test.ts 走的是
 * useContenteditableInput 端到端链路，不复用其 setup 以免改动他人用例。
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/selection-restore.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSelectionRestore } from './selection-restore'

/** 建编辑器 div（挂 body）+ 一个编辑器外节点，返回操作句柄 */
function setup(initialText = 'AAA BBB CCC') {
  const el = document.createElement('div')
  el.textContent = initialText
  el.contentEditable = 'true'
  document.body.appendChild(el)
  const external = document.createElement('div')
  external.textContent = 'message body'
  document.body.appendChild(external)
  const api = useSelectionRestore(() => el)
  return {
    el,
    external,
    textNode: el.firstChild as Text,
    externalText: external.firstChild as Text,
    ...api,
    cleanup: () => {
      el.remove()
      external.remove()
    },
  }
}

describe('useSelectionRestore 跨边界活选区收敛（RC-A-9）', () => {
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    window.getSelection()?.removeAllRanges()
  })

  it('分支① 活选区两端均在编辑器内 → 采信活选区（savedRange 不覆盖）', () => {
    const c = setup()
    const sel = window.getSelection()
    const range = document.createRange()
    range.setStart(c.textNode, 4)
    range.collapse(true)
    sel?.addRange(range)

    c.restoreSelection()

    const after = window.getSelection()
    expect(after?.rangeCount).toBeGreaterThan(0)
    expect(c.el.contains(after?.anchorNode ?? null)).toBe(true)
    expect(after?.anchorOffset).toBe(4)
    c.cleanup()
  })

  it('分支② savedRange 为空 + 跨边界活选区 → 清掉越界选区（下游不会 deleteContents 到编辑器外）', () => {
    const c = setup()
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(c.textNode, 1)
    range.setEnd(c.externalText, 3)
    sel?.addRange(range)
    // 前置：跨边界选区已成立（focus 端在编辑器外）
    expect(sel?.focusNode).toBe(c.externalText)
    expect(c.el.contains(sel?.focusNode ?? null)).toBe(false)

    c.restoreSelection() // 未 saveSelection ⇒ savedRange 为空，走「仅回焦」分支

    const after = window.getSelection()
    // 加固前：range 原样留存 ⇒ rangeCount === 1 且 focusNode 仍在编辑器外（下游 deleteContents 越界）
    expect(after?.rangeCount).toBe(0)
    expect(after?.focusNode).toBe(null)
    c.cleanup()
  })

  it('分支② savedRange 为空 + 活选区整体在编辑器外 → 同样清掉', () => {
    const c = setup()
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(c.externalText, 0)
    range.setEnd(c.externalText, 5)
    sel?.addRange(range)

    c.restoreSelection()

    expect(window.getSelection()?.rangeCount).toBe(0)
    c.cleanup()
  })

  it('分支② savedRange 为空 + 无活选区 → 仅回焦，不触碰选区（既有兜底语义保持）', () => {
    const c = setup()
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const focusSpy = vi.spyOn(c.el, 'focus')
    const removeSpy = vi.spyOn(sel as Selection, 'removeAllRanges')

    c.restoreSelection()

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).not.toHaveBeenCalled()
    expect(window.getSelection()?.rangeCount).toBe(0)
    c.cleanup()
  })
})
