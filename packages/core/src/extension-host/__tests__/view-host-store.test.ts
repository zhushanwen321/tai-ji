/**
 * view-host-store.test.ts —— ViewHostStore 单测（IF10 + ERR4 + clarify Q1 窄化）。
 *
 * 覆盖：widgetGui/widget 双源窄化（isGuiComponent 直存 / string 行包装 ansi-text）、
 * gui:null 清除语义（invalidate）、setView/getView、invalidate 单条/全清、
 * ERR4 session-destroyed cleanup、跨 session 分区隔离。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ViewHostStore } from '../view-host-store'
import { InternalEventBus } from '../internal-event-bus'
import { createSessionScopedMap } from '../utils/session-scoped-map'
import type { ViewCacheEntry } from '../view-host-store'

function makeStore() {
  const bus = new InternalEventBus()
  const sessionScoped = createSessionScopedMap(() => new Map<string, ViewCacheEntry>())
  const store = new ViewHostStore({ bus, sessionScoped })
  store.subscribe()
  return { bus, sessionScoped, store }
}

describe('ViewHostStore', () => {
  beforeEach(() => {
    // 无全局状态残留
  })

  describe('extension-widget 窄化（IF10 + clarify Q1）', () => {
    it('widgetGui（GuiComponent）→ getView 返回原 GuiComponent', () => {
      const { bus, store } = makeStore()
      bus.emit({
        kind: 'extension-widget',
        sessionId: 's1',
        widget: { viewId: 'side', pluginId: 'tasks', guiTree: [{ type: 'card', props: { body: [] } }] },
      })
      const view = store.getView('s1', 'side')
      expect(view).toBeDefined()
      expect(view!.guiTree).toHaveLength(1)
      expect(view!.guiTree[0]).toMatchObject({ type: 'card', props: { body: [] } })
    })

    it('meta（v1.1 widget 宿主元数据）合法（title: string）→ 缓存透传', () => {
      const { bus, store } = makeStore()
      const meta = { title: 'Todo', status: 'running', progress: { current: 1, total: 3 } }
      bus.emit({
        kind: 'extension-widget',
        sessionId: 's1',
        widget: { viewId: 'todo', pluginId: '', guiTree: [{ type: 'list-tree', props: { items: [] } }], meta },
      })
      const view = store.getView('s1', 'todo')
      expect(view!.meta).toEqual(meta)
    })

    it.each([
      ['undefined（v1 旧 wire 无 meta）', undefined],
      ['null', null],
      ['非对象（字符串）', 'Todo'],
      ['缺 title 字符串', { status: 'running' }],
    ])('meta %s → 缓存条目无 meta 键', (_label, meta) => {
      const { bus, store } = makeStore()
      bus.emit({
        kind: 'extension-widget',
        sessionId: 's1',
        widget: { viewId: 'w', pluginId: '', guiTree: [{ type: 'ansi-text', props: { lines: [] } }], meta },
      })
      const view = store.getView('s1', 'w')
      expect(view!.meta).toBeUndefined()
    })

    it('widget（string 行）→ 窄化为 ansi-text GuiComponent', () => {
      const { bus, store } = makeStore()
      bus.emit({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'terminal', pluginId: '', guiTree: ['line1', 'line2'] } })
      const view = store.getView('s1', 'terminal')
      expect(view).toBeDefined()
      expect(view!.guiTree).toHaveLength(2)
      expect(view!.guiTree[0]).toEqual({ type: 'ansi-text', props: { lines: ['line1'] } })
      expect(view!.guiTree[1]).toEqual({ type: 'ansi-text', props: { lines: ['line2'] } })
    })

    it('widgetGui gui:null → invalidate 该 viewId（清除语义）', () => {
      const { bus, store } = makeStore()
      bus.emit({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', pluginId: 'tasks', guiTree: [{ type: 'card', props: { body: [] } }] } })
      expect(store.getView('s1', 'side')).toBeDefined()

      bus.emit({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', pluginId: 'tasks', guiTree: [null] } })
      expect(store.getView('s1', 'side')).toBeUndefined()
    })

    it('非法对象项丢弃，合法项保留', () => {
      const { bus, store } = makeStore()
      bus.emit({
        kind: 'extension-widget',
        sessionId: 's1',
        widget: { viewId: 'mixed', pluginId: '', guiTree: [{ type: 'card', props: { body: [] } }, { bad: true }, 'txt'] },
      })
      const view = store.getView('s1', 'mixed')
      expect(view).toBeDefined()
      expect(view!.guiTree).toHaveLength(2)
      expect(view!.guiTree[0]).toMatchObject({ type: 'card' })
      expect(view!.guiTree[1]).toMatchObject({ type: 'ansi-text' })
    })
  })

  describe('setView / getView / invalidate（IF10）', () => {
    it('setView 手动注入 → getView 返回', () => {
      const { store } = makeStore()
      store.setView('s1', 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      expect(store.getView('s1', 'v1')).toBeDefined()
      expect(store.getView('s1', 'v1')!.pluginId).toBe('p1')
    })

    it('invalidate(sessionId, viewId) 单条清除', () => {
      const { store } = makeStore()
      store.setView('s1', 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.setView('s1', 'v2', { viewId: 'v2', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.invalidate('s1', 'v1')
      expect(store.getView('s1', 'v1')).toBeUndefined()
      expect(store.getView('s1', 'v2')).toBeDefined()
    })

    it('invalidate(sessionId) 无 viewId 清空该 session 全部 view', () => {
      const { store } = makeStore()
      store.setView('s1', 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.setView('s1', 'v2', { viewId: 'v2', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.invalidate('s1')
      expect(store.getView('s1', 'v1')).toBeUndefined()
      expect(store.getView('s1', 'v2')).toBeUndefined()
    })
  })

  describe('ERR4: session-destroyed cleanup', () => {
    it('session-destroyed → 分区清空 + getView undefined', () => {
      const { bus, sessionScoped, store } = makeStore()
      store.setView('s1', 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })

      bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
      expect(sessionScoped.has('s1')).toBe(false)
      expect(store.getView('s1', 'v1')).toBeUndefined()
    })
  })

  describe('跨 session 分区隔离', () => {
    it("'s1'/'s2' 同 viewId 各存各的", () => {
      const { store } = makeStore()
      store.setView('s1', 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.setView('s2', 'v1', { viewId: 'v1', pluginId: 'p2', guiTree: [], updatedAt: 2 })
      expect(store.getView('s1', 'v1')!.pluginId).toBe('p1')
      expect(store.getView('s2', 'v1')!.pluginId).toBe('p2')
    })
  })
})
