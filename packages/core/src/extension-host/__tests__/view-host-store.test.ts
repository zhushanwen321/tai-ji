/**
 * view-host-store.test.ts —— ViewHostStore 单测（IF10 + ERR4 + clarify Q1 窄化 + U2 scope 分区）。
 *
 * 覆盖：widgetGui/widget 双源窄化（isGuiComponent 直存 / string 行包装 ansi-text）、
 * gui:null 清除语义（invalidate）、setView/getView、invalidate 单条/全清、
 * ERR4 session-destroyed cleanup、跨 session 分区隔离、全局域分区（U2：mountId 归属，
 * 插件维度并入分区键——双插件同挂载位互不覆盖 S25）、归属缺失防御丢弃。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

const SESSION_SCOPE = { kind: 'session' as const, sessionId: 's1' }

describe('ViewHostStore', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('extension-widget 窄化（IF10 + clarify Q1）', () => {
    it('widgetGui（GuiComponent）→ getView 返回原 GuiComponent', () => {
      const { bus, store } = makeStore()
      bus.emit({
        kind: 'extension-widget',
        sessionId: 's1',
        widget: { viewId: 'side', pluginId: 'tasks', guiTree: [{ type: 'card', props: { body: [] } }] },
      })
      const view = store.getView(SESSION_SCOPE, 'side')
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
      const view = store.getView(SESSION_SCOPE, 'todo')
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
      const view = store.getView(SESSION_SCOPE, 'w')
      expect(view!.meta).toBeUndefined()
    })

    it('widget（string 行）→ 窄化为 ansi-text GuiComponent', () => {
      const { bus, store } = makeStore()
      bus.emit({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'terminal', pluginId: '', guiTree: ['line1', 'line2'] } })
      const view = store.getView(SESSION_SCOPE, 'terminal')
      expect(view).toBeDefined()
      expect(view!.guiTree).toHaveLength(2)
      expect(view!.guiTree[0]).toEqual({ type: 'ansi-text', props: { lines: ['line1'] } })
      expect(view!.guiTree[1]).toEqual({ type: 'ansi-text', props: { lines: ['line2'] } })
    })

    it('widgetGui gui:null → invalidate 该 viewId（清除语义）', () => {
      const { bus, store } = makeStore()
      bus.emit({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', pluginId: 'tasks', guiTree: [{ type: 'card', props: { body: [] } }] } })
      expect(store.getView(SESSION_SCOPE, 'side')).toBeDefined()

      bus.emit({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', pluginId: 'tasks', guiTree: [null] } })
      expect(store.getView(SESSION_SCOPE, 'side')).toBeUndefined()
    })

    it('非法对象项丢弃，合法项保留', () => {
      const { bus, store } = makeStore()
      bus.emit({
        kind: 'extension-widget',
        sessionId: 's1',
        widget: { viewId: 'mixed', pluginId: '', guiTree: [{ type: 'card', props: { body: [] } }, { bad: true }, 'txt'] },
      })
      const view = store.getView(SESSION_SCOPE, 'mixed')
      expect(view).toBeDefined()
      expect(view!.guiTree).toHaveLength(2)
      expect(view!.guiTree[0]).toMatchObject({ type: 'card' })
      expect(view!.guiTree[1]).toMatchObject({ type: 'ansi-text' })
    })

    it('归属缺失（U2：sessionId/mountId 二选一皆无）→ 防御丢弃 + warn 留痕', () => {
      const { bus, store } = makeStore()
      bus.emit({ kind: 'extension-widget', widget: { viewId: 'ghost', pluginId: 'p', guiTree: [{ type: 'card', props: { body: [] } }] } })
      expect(store.getView(SESSION_SCOPE, 'ghost')).toBeUndefined()
      expect(store.getViewIds(SESSION_SCOPE)).toHaveLength(0)
    })
  })

  describe('全局域分区（U2：mountId 归属，插件维度并入键）', () => {
    const AUTHORIZE = { kind: 'global' as const, mountId: 'provider.authorize', pluginId: 'plug-a' }

    it('mountId 事件 → 全局域分区；pluginId 取 widget.pluginId', () => {
      const { bus, store } = makeStore()
      bus.emit({ kind: 'extension-widget', mountId: 'provider.authorize', widget: { viewId: 'flow', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['auth'] } }], generation: 1 } })
      const view = store.getView(AUTHORIZE, 'flow')
      expect(view).toBeDefined()
      expect(view!.generation).toBe(1)
      // 同挂载位其他插件分区不可见（S25 前置）
      expect(store.getView({ ...AUTHORIZE, pluginId: 'plug-b' }, 'flow')).toBeUndefined()
    })

    it('S25：双插件同挂载位交替推树互不覆盖', () => {
      const { bus, store } = makeStore()
      bus.emit({ kind: 'extension-widget', mountId: 'provider.authorize', widget: { viewId: 'flow', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['A1'] } }] } })
      bus.emit({ kind: 'extension-widget', mountId: 'provider.authorize', widget: { viewId: 'flow', pluginId: 'plug-b', guiTree: [{ type: 'ansi-text', props: { lines: ['B1'] } }] } })
      // A 重推（更新自己分区）
      bus.emit({ kind: 'extension-widget', mountId: 'provider.authorize', widget: { viewId: 'flow', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['A2'] } }] } })

      expect(store.getView({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' }, 'flow')!.guiTree[0]).toMatchObject({ props: { lines: ['A2'] } })
      expect(store.getView({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-b' }, 'flow')!.guiTree[0]).toMatchObject({ props: { lines: ['B1'] } })
    })

    it('gui:null 清除语义作用于全局域分区', () => {
      const { bus, store } = makeStore()
      bus.emit({ kind: 'extension-widget', mountId: 'provider.detail-extra', widget: { viewId: 'extra', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }] } })
      bus.emit({ kind: 'extension-widget', mountId: 'provider.detail-extra', widget: { viewId: 'extra', pluginId: 'plug-a', guiTree: [null] } })
      expect(store.getView({ kind: 'global', mountId: 'provider.detail-extra', pluginId: 'plug-a' }, 'extra')).toBeUndefined()
    })

    it('invalidate(scope) 全清只影响该 scope 分区', () => {
      const { store } = makeStore()
      store.setView(AUTHORIZE, 'v1', { viewId: 'v1', pluginId: 'plug-a', guiTree: [], updatedAt: 1 })
      store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.invalidate(AUTHORIZE)
      expect(store.getView(AUTHORIZE, 'v1')).toBeUndefined()
      expect(store.getView(SESSION_SCOPE, 'v1')).toBeDefined()
    })
  })

  describe('setView / getView / invalidate（IF10）', () => {
    it('setView 手动注入 → getView 返回', () => {
      const { store } = makeStore()
      store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      expect(store.getView(SESSION_SCOPE, 'v1')).toBeDefined()
      expect(store.getView(SESSION_SCOPE, 'v1')!.pluginId).toBe('p1')
    })

    it('invalidate(scope, viewId) 单条清除', () => {
      const { store } = makeStore()
      store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.setView(SESSION_SCOPE, 'v2', { viewId: 'v2', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.invalidate(SESSION_SCOPE, 'v1')
      expect(store.getView(SESSION_SCOPE, 'v1')).toBeUndefined()
      expect(store.getView(SESSION_SCOPE, 'v2')).toBeDefined()
    })

    it('invalidate(scope) 无 viewId 清空该 session 全部 view', () => {
      const { store } = makeStore()
      store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.setView(SESSION_SCOPE, 'v2', { viewId: 'v2', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.invalidate(SESSION_SCOPE)
      expect(store.getView(SESSION_SCOPE, 'v1')).toBeUndefined()
      expect(store.getView(SESSION_SCOPE, 'v2')).toBeUndefined()
    })
  })

  describe('ERR4: session-destroyed cleanup', () => {
    it('session-destroyed → 会话域分区清空 + getView undefined（全局域分区不受影响）', () => {
      const { bus, sessionScoped, store } = makeStore()
      store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.setView({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' }, 'flow', { viewId: 'flow', pluginId: 'plug-a', guiTree: [], updatedAt: 1 })

      bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
      expect(sessionScoped.has('session:s1')).toBe(false)
      expect(store.getView(SESSION_SCOPE, 'v1')).toBeUndefined()
      expect(store.getView({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' }, 'flow')).toBeDefined()
    })
  })

  describe('跨 session 分区隔离', () => {
    it("'s1'/'s2' 同 viewId 各存各的", () => {
      const { store } = makeStore()
      store.setView(SESSION_SCOPE, 'v1', { viewId: 'v1', pluginId: 'p1', guiTree: [], updatedAt: 1 })
      store.setView({ kind: 'session', sessionId: 's2' }, 'v1', { viewId: 'v1', pluginId: 'p2', guiTree: [], updatedAt: 2 })
      expect(store.getView(SESSION_SCOPE, 'v1')!.pluginId).toBe('p1')
      expect(store.getView({ kind: 'session', sessionId: 's2' }, 'v1')!.pluginId).toBe('p2')
    })
  })
})
