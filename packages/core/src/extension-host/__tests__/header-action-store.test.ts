/**
 * header-action-store.test.ts —— HeaderActionStore 单测（AP-1）。
 *
 * 覆盖：plugin:headerActionUpdate 帧消费写入、per-session 分区写读互不串（场景 9 徽标隔离）、
 * set 覆盖幂等、session-destroyed → clearForSession（幂等）、clearForPlugin 跨会话清理
 * （其他插件保留、空分区整体移除、幂等 no-op）、onChange 响应式粘合（ViewHostStore 同范式）。
 */
import { describe, it, expect, vi } from 'vitest'
import { HeaderActionStore } from '../header-action-store'
import { InternalEventBus } from '../internal-event-bus'
import { createSessionScopedMap } from '../utils/session-scoped-map'
import type { HeaderActionEntry } from '../header-action-store'

function makeStore() {
  const bus = new InternalEventBus()
  const sessionScoped = createSessionScopedMap(() => new Map<string, HeaderActionEntry>())
  const store = new HeaderActionStore({ bus, sessionScoped })
  store.subscribe()
  return { bus, sessionScoped, store }
}

describe('HeaderActionStore', () => {
  describe('plugin:headerActionUpdate 帧消费（AP-1）', () => {
    it('帧 → set 写入，get 读回全字段', () => {
      const { bus, store } = makeStore()
      bus.emit({
        kind: 'plugin:headerActionUpdate',
        headerAction: { pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1', badge: '3', tooltip: '3 启用', disabled: false },
      })
      expect(store.get('s1', 'scheduler-manager.open')).toMatchObject({
        headerActionId: 'scheduler-manager.open',
        pluginId: 'scheduler-manager',
        badge: '3',
        tooltip: '3 启用',
        disabled: false,
      })
    })

    it('可选字段缺省 → 条目对应键 undefined', () => {
      const { bus, store } = makeStore()
      bus.emit({ kind: 'plugin:headerActionUpdate', headerAction: { pluginId: 'p1', headerActionId: 'a1', sessionId: 's1' } })
      const entry = store.get('s1', 'a1')
      expect(entry).toBeDefined()
      expect(entry!.badge).toBeUndefined()
      expect(entry!.tooltip).toBeUndefined()
      expect(entry!.disabled).toBeUndefined()
    })
  })

  describe('per-session 分区写读', () => {
    it("s1/s2 同 headerActionId 各存各的（多会话徽标互不串，场景 9）", () => {
      const { store } = makeStore()
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      store.set('s2', 'a1', { pluginId: 'p1', badge: '7' })
      expect(store.get('s1', 'a1')!.badge).toBe('3')
      expect(store.get('s2', 'a1')!.badge).toBe('7')
    })

    it('同 session 不同 headerActionId 互不影响', () => {
      const { store } = makeStore()
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      store.set('s1', 'a2', { pluginId: 'p1', disabled: true })
      expect(store.get('s1', 'a1')!.badge).toBe('3')
      expect(store.get('s1', 'a1')!.disabled).toBeUndefined()
      expect(store.get('s1', 'a2')!.disabled).toBe(true)
    })

    it('set 覆盖语义：同 (sessionId, headerActionId) 二次写入以最新为准（幂等收敛）', () => {
      const { store } = makeStore()
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      store.set('s1', 'a1', { pluginId: 'p1', badge: '2' })
      expect(store.get('s1', 'a1')!.badge).toBe('2')
    })

    it('未写入的键 get 返回 undefined（声明侧静态形状不在本 store）', () => {
      const { store } = makeStore()
      expect(store.get('s1', 'nope')).toBeUndefined()
      expect(store.get('s1', 'a1')).toBeUndefined()
    })
  })

  describe('session-destroyed → clearForSession（ERR4 同族）', () => {
    it('事件触发分区清空', () => {
      const { bus, sessionScoped, store } = makeStore()
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
      expect(sessionScoped.has('s1')).toBe(false)
      expect(store.get('s1', 'a1')).toBeUndefined()
    })

    it('clearForSession 幂等（二次调用不抛、其他分区不受扰）', () => {
      const { bus, store } = makeStore()
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      store.set('s2', 'a1', { pluginId: 'p1', badge: '7' })
      bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
      bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
      expect(store.get('s1', 'a1')).toBeUndefined()
      expect(store.get('s2', 'a1')!.badge).toBe('7')
    })
  })

  describe('clearForPlugin（AP-1 生命周期：崩溃/禁用/卸载）', () => {
    it('跨会话清该插件条目，其他插件保留', () => {
      const { store } = makeStore()
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      store.set('s1', 'a2', { pluginId: 'p2', badge: '1' })
      store.set('s2', 'a1', { pluginId: 'p1', badge: '7' })
      store.clearForPlugin('p1')
      expect(store.get('s1', 'a1')).toBeUndefined()
      expect(store.get('s2', 'a1')).toBeUndefined()
      expect(store.get('s1', 'a2')!.badge).toBe('1')
    })

    it('清空后变空的分区整体移除（不留空 Map）', () => {
      const { sessionScoped, store } = makeStore()
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      store.clearForPlugin('p1')
      expect(sessionScoped.has('s1')).toBe(false)
    })

    it('幂等：无匹配条目 / 重复调用 no-op', () => {
      const { store } = makeStore()
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      store.clearForPlugin('pX')
      store.clearForPlugin('pX')
      expect(store.get('s1', 'a1')!.badge).toBe('3')
      store.clearForPlugin('p1')
      store.clearForPlugin('p1')
      expect(store.get('s1', 'a1')).toBeUndefined()
    })
  })

  describe('onChange 响应式粘合（ViewHostStore 同范式）', () => {
    it('set / clearForSession / clearForPlugin 触发监听；unsubscribe 后不再触发', () => {
      const { store } = makeStore()
      const fn = vi.fn()
      const unsub = store.onChange(fn)
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      store.clearForSession('s1')
      store.clearForPlugin('p1')
      expect(fn).toHaveBeenCalledTimes(3)
      unsub()
      store.set('s1', 'a1', { pluginId: 'p1', badge: '3' })
      expect(fn).toHaveBeenCalledTimes(3)
    })
  })
})
