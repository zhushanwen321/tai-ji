/**
 * AmbiguousFilePopover 行为级测试（Gate A 回流缺口 3：D2 改动无行为覆盖）。
 *
 * 覆盖 window capture 键盘导航的 D2 双保险面：
 * - IME 组合态（compositionstart 置位 composingRef / e.isComposing:true 双路）Enter/Tab
 *   → 放行：不 emit select、不 preventDefault（组合中 Enter 是确认候选词）
 * - 非组合态 Enter / Tab → emit select(activeIndex 项) + preventDefault + stopPropagation
 *   （capture 选中后必须截断传播，防 target 阶段双触发）
 * - Esc → update:open(false) 关闭回归
 * - ArrowDown/Up 循环导航回归（不选中）
 *
 * 真实 DOM 派发（蓝本 renderer composer-keydown.test.ts）：事件 dispatch 到 body 内
 * 目标元素（bubbles: true），组件 window capture 监听命中；stopPropagation 断言用
 * 目标元素上的 bubble 监听 spy（capture 截断后不可达）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/ambiguous-file-popover.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AmbiguousFilePopover from '../AmbiguousFilePopover.vue'
import type { FileNode } from '@taiji/shared'

function makeNode(path: string): FileNode {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { path, name, type: 'file' }
}

const CANDIDATES = [makeNode('docs/design.md'), makeNode('src/design.md')]

function mountPopover() {
  return mount(AmbiguousFilePopover, {
    props: { open: true, basename: 'design.md', candidates: CANDIDATES, anchorEl: null },
  })
}

/** 在 body 目标元素上真实派发 keydown（bubbles 冒泡到 window capture）。
 * 返回 { ev, targetSpy }：targetSpy = 目标元素 bubble 监听（stopPropagation 生效时不可达） */
function pressKey(key: string, opts: { isComposing?: boolean } = {}) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const targetSpy = vi.fn()
  target.addEventListener('keydown', targetSpy)
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  if (opts.isComposing) Object.defineProperty(ev, 'isComposing', { value: true })
  target.dispatchEvent(ev)
  target.remove()
  return { ev, targetSpy }
}

describe('AmbiguousFilePopover 键盘导航（window capture）', () => {
  it('非组合态 Enter → emit select(首项) + preventDefault + stopPropagation 截断 target 传播', () => {
    const wrapper = mountPopover()
    const { ev, targetSpy } = pressKey('Enter')
    expect(ev.defaultPrevented).toBe(true)
    expect(targetSpy).not.toHaveBeenCalled()
    expect(wrapper.emitted('select')).toEqual([['docs/design.md']])
    wrapper.unmount()
  })

  it('非组合态 Tab → 同 Enter：emit select + preventDefault + stopPropagation', () => {
    const wrapper = mountPopover()
    const { ev, targetSpy } = pressKey('Tab')
    expect(ev.defaultPrevented).toBe(true)
    expect(targetSpy).not.toHaveBeenCalled()
    expect(wrapper.emitted('select')).toEqual([['docs/design.md']])
    wrapper.unmount()
  })

  it('e.isComposing:true 的 Enter → 放行：不 select 不 preventDefault 不截断', () => {
    const wrapper = mountPopover()
    const { ev, targetSpy } = pressKey('Enter', { isComposing: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(targetSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('select')).toBeUndefined()
    wrapper.unmount()
  })

  it('compositionstart 置位组合态：Enter/Tab 放行，compositionend 后恢复选中', () => {
    const wrapper = mountPopover()
    window.dispatchEvent(new CompositionEvent('compositionstart'))
    const during = pressKey('Tab')
    expect(during.ev.defaultPrevented).toBe(false)
    expect(during.targetSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('select')).toBeUndefined()

    window.dispatchEvent(new CompositionEvent('compositionend'))
    const after = pressKey('Tab')
    expect(after.ev.defaultPrevented).toBe(true)
    expect(after.targetSpy).not.toHaveBeenCalled()
    expect(wrapper.emitted('select')).toEqual([['docs/design.md']])
    wrapper.unmount()
  })

  it('Esc → 关闭浮层（update:open false）+ preventDefault，不 emit select', () => {
    const wrapper = mountPopover()
    const { ev } = pressKey('Escape')
    expect(ev.defaultPrevented).toBe(true)
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    expect(wrapper.emitted('select')).toBeUndefined()
    wrapper.unmount()
  })

  it('ArrowDown/ArrowUp 循环导航后 Enter 选中高亮项；Arrow 键不 emit select', () => {
    const wrapper = mountPopover()
    pressKey('ArrowDown')
    expect(wrapper.emitted('select')).toBeUndefined()
    const { ev } = pressKey('Enter')
    expect(ev.defaultPrevented).toBe(true)
    expect(wrapper.emitted('select')).toEqual([['src/design.md']])
    wrapper.unmount()
  })

  it('组件卸载后 window 监听移除：Enter 不再触发 select', () => {
    const wrapper = mountPopover()
    wrapper.unmount()
    const { ev } = pressKey('Enter')
    expect(ev.defaultPrevented).toBe(false)
  })
})
