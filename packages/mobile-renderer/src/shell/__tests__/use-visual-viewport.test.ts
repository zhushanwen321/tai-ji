// useVisualViewport 单测（remote-use-mobile-v2 §6.16 验收条款 5：visualViewport 高度切换，
// 注入假 viewport 对象驱动——系统对象注入可测形态，零真实 viewport 依赖）。
import { describe, expect, it, beforeEach } from 'vitest'
import {
  SHELL_VIEWPORT_HEIGHT_VAR,
  useVisualViewport,
  type VisualViewportLike,
} from '../use-visual-viewport'

/** 假 viewport：监听器可枚举 + 手动派生事件（resize/scroll），height 可改写模拟键盘弹起 */
class FakeViewport implements VisualViewportLike {
  height = 800
  private readonly listeners = new Map<string, Set<() => void>>()

  addEventListener(type: 'resize' | 'scroll', listener: () => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: 'resize' | 'scroll'): void {
    this.listeners.get(type)?.forEach((listener) => listener())
  }

  listenerCount(type: 'resize' | 'scroll'): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

function rootVar(): string {
  return document.documentElement.style.getPropertyValue(SHELL_VIEWPORT_HEIGHT_VAR)
}

describe('useVisualViewport 高度接管（§6.16）', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty(SHELL_VIEWPORT_HEIGHT_VAR)
  })

  it('启用即写入初值（挂载时高度即时正确，不等首个事件）', () => {
    const vp = new FakeViewport()
    const cleanup = useVisualViewport(vp)
    expect(rootVar()).toBe('800px')
    cleanup()
  })

  it('resize 事件 → 变量跟随（键盘弹起 height 收缩场景）', () => {
    const vp = new FakeViewport()
    const cleanup = useVisualViewport(vp)
    vp.height = 412
    vp.emit('resize')
    expect(rootVar()).toBe('412px')
    cleanup()
  })

  it('scroll 事件同样驱动更新（iOS 地址栏收缩可视区变化的另一事件源）', () => {
    const vp = new FakeViewport()
    const cleanup = useVisualViewport(vp)
    vp.height = 700
    vp.emit('scroll')
    expect(rootVar()).toBe('700px')
    cleanup()
  })

  it('cleanup 解绑监听：事件不再更新变量，且变量被清除（卸载不留壳外残留）', () => {
    const vp = new FakeViewport()
    const cleanup = useVisualViewport(vp)
    expect(vp.listenerCount('resize')).toBe(1)
    expect(vp.listenerCount('scroll')).toBe(1)
    cleanup()
    expect(vp.listenerCount('resize')).toBe(0)
    expect(vp.listenerCount('scroll')).toBe(0)
    vp.height = 300
    vp.emit('resize')
    expect(rootVar()).toBe('')
  })

  it('viewport 不可用（缺省且 window.visualViewport 为 null）→ 不接管、不抛错、零监听', () => {
    // happy-dom 的 window.visualViewport 为 undefined——缺省路径即注入 null 等价形态
    const cleanup = useVisualViewport(null)
    expect(rootVar()).toBe('')
    expect(() => cleanup()).not.toThrow()
  })
})
