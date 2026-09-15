/**
 * overlay-lifecycle.test.ts —— OverlayLifecycle 单测（IF9 + ERR4 + clarify Q2）。
 *
 * 覆盖：ui-request 自动建分区（expanded 初始态）、transition 状态机迁移、非法迁移 no-op、
 * __global__ 分区（无 sessionId）、ERR4 session-destroyed cleanup、__global__ 不受影响、
 * 重复 ui-request 不重置。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { OverlayLifecycle, GLOBAL_OVERLAY_KEY } from '../overlay-lifecycle'
import { InternalEventBus } from '../internal-event-bus'
import { createSessionScopedMap } from '../utils/session-scoped-map'

function makeOverlay() {
  const bus = new InternalEventBus()
  const sessionScoped = createSessionScopedMap(() => new Map<string, 'expanded' | 'minimized' | 'restored'>())
  const overlay = new OverlayLifecycle({ bus, sessionScoped })
  overlay.subscribe()
  return { bus, sessionScoped, overlay }
}

describe('OverlayLifecycle', () => {
  beforeEach(() => {
    // 无全局状态残留
  })

  describe('ui-request 自动建分区（IF9）', () => {
    it('emit ui-request → getState==="expanded"（自动建分区）', () => {
      const { bus, overlay } = makeOverlay()
      bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm', title: '确认？' } })
      expect(overlay.getState('s1', 'r1')).toBe('expanded')
    })

    it('ui-request 重复到达已存在分区 → 状态不重置', () => {
      const { bus, overlay } = makeOverlay()
      bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
      overlay.transition('s1', 'r1', 'minimized')
      bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
      expect(overlay.getState('s1', 'r1')).toBe('minimized')
    })
  })

  describe('状态机迁移（IF9）', () => {
    it('transition expanded→minimized', () => {
      const { bus, overlay } = makeOverlay()
      bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
      overlay.transition('s1', 'r1', 'minimized')
      expect(overlay.getState('s1', 'r1')).toBe('minimized')
    })

    it('transition minimized→restored', () => {
      const { bus, overlay } = makeOverlay()
      bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
      overlay.transition('s1', 'r1', 'minimized')
      overlay.transition('s1', 'r1', 'restored')
      expect(overlay.getState('s1', 'r1')).toBe('restored')
    })

    it('非法迁移（restored→expanded 未定义）→ no-op 不抛错 + 状态不变', () => {
      const { bus, overlay } = makeOverlay()
      bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
      overlay.transition('s1', 'r1', 'minimized')
      overlay.transition('s1', 'r1', 'restored')
      expect(() => overlay.transition('s1', 'r1', 'expanded')).not.toThrow()
      expect(overlay.getState('s1', 'r1')).toBe('restored')
    })
  })

  describe('__global__ 分区（clarify Q2）', () => {
    it('ui-request 无 sessionId → getState("__global__", requestId)==="expanded"', () => {
      const { bus, overlay } = makeOverlay()
      bus.emit({ kind: 'ui-request', request: { requestId: 'r2', pluginId: 'tasks', kind: 'select', title: '选择' } })
      expect(overlay.getState(GLOBAL_OVERLAY_KEY, 'r2')).toBe('expanded')
    })

    it('transition 无 sessionId → 作用 __global__ 分区', () => {
      const { bus, overlay } = makeOverlay()
      bus.emit({ kind: 'ui-request', request: { requestId: 'r2', pluginId: 'tasks', kind: 'select' } })
      overlay.transition(undefined, 'r2', 'minimized')
      expect(overlay.getState(GLOBAL_OVERLAY_KEY, 'r2')).toBe('minimized')
    })
  })

  describe('ERR4: session-destroyed cleanup', () => {
    it('session-destroyed → 分区清空 + getState undefined', () => {
      const { bus, sessionScoped, overlay } = makeOverlay()
      bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
      expect(overlay.getState('s1', 'r1')).toBe('expanded')

      bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
      expect(sessionScoped.has('s1')).toBe(false)
      expect(overlay.getState('s1', 'r1')).toBeUndefined()
    })

    it('__global__ 分区不受 session-destroyed 影响', () => {
      const { bus, sessionScoped, overlay } = makeOverlay()
      bus.emit({ kind: 'ui-request', request: { requestId: 'r2', pluginId: 'tasks', kind: 'select' } })
      bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm' } })
      bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
      expect(sessionScoped.has(GLOBAL_OVERLAY_KEY)).toBe(true)
      expect(overlay.getState(GLOBAL_OVERLAY_KEY, 'r2')).toBe('expanded')
    })
  })

  describe('getState 边界', () => {
    it('分区或 requestId 不存在 → undefined', () => {
      const { overlay } = makeOverlay()
      expect(overlay.getState('nope', 'r1')).toBeUndefined()
      expect(overlay.getState('s1', 'nope')).toBeUndefined()
    })
  })
})
