/**
 * message-bus-bridge.test.ts —— MessageBusBridge 单测（AC8/FR5/ERR2/dispose/窄化抽查）。
 *
 * 覆盖：AC8（9 个 plugin:* 每个 type 都 emit 对应 InternalEvent，无零订阅）、
 * FR5（5 个 extension:* 收敛，widget/widgetGui 双映射 + ui_request 归一）、
 * ERR2（未知 type + 4 种 payload 解析失败 → error 事件）、dispose 防泄漏、
 * 窄化映射抽查（scope/sessionId 保留、alignment 默认、widgetGui gui:null、editor 兜底）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageBusBridge, parseStatusBarUpdate } from '../message-bus-bridge'
import { InternalEventBus } from '../internal-event-bus'
import { MockMessageSource } from '../plugin-message-source'
import type { IncomingPluginMessage } from '../plugin-message-source'
import type { InternalEvent } from '../types'

function makeBridge() {
  const source = new MockMessageSource()
  const bus = new InternalEventBus()
  const bridge = new MessageBusBridge({ source, bus })
  return { source, bus, bridge }
}

/** emit 后收集 bus 上所有事件（spy on emit）。 */
function spyEmit(bus: InternalEventBus) {
  const emitted: InternalEvent[] = []
  const spy = vi.spyOn(bus, 'emit')
  spy.mockImplementation((e) => {
    emitted.push(e)
    return
  })
  return { emitted, spy }
}

describe('MessageBusBridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('AC8: 9 个 plugin:* 每个 type 都 emit 对应 InternalEvent（无零订阅）', () => {
    it('statusBarUpdate → plugin-status-bar-update', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({
        type: 'plugin:statusBarUpdate',
        payload: {
          items: [
            { id: 'sb1', pluginId: 'tasks', text: '3 tasks', priority: 100, scope: 'per-session', sessionId: 's1' },
          ],
        },
      })
      const e = emitted.find((x) => x.kind === 'plugin-status-bar-update')
      expect(e).toBeDefined()
      // item 级 sessionId 保留（IF8 分流），事件级 sessionId 来自 msg/payload 顶层（此处无，故 undefined）
      expect(e).toMatchObject({
        kind: 'plugin-status-bar-update',
        items: [{ id: 'sb1', pluginId: 'tasks', text: '3 tasks', alignment: 'left', priority: 100, scope: 'per-session', sessionId: 's1' }],
      })
      expect(emitted.some((x) => x.kind === 'error')).toBe(false)
    })

    it('statusSetUpdate → plugin-status-set-update（key→id、text→text、pluginId=""）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:statusSetUpdate', payload: { sessionId: 's1', key: 'session', text: 'ready', textRaw: 'ready' } })
      const e = emitted.find((x) => x.kind === 'plugin-status-set-update')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'plugin-status-set-update', sessionId: 's1', status: [{ id: 'session', pluginId: '', text: 'ready' }] })
    })

    it('permissionRequest → plugin-permission-request（permissions 数组完整透传、合成 requestId）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      // 多权限场景：runtime 一次可申请多个权限，数组必须完整透传（不收敛为单数）
      source.emit({ type: 'plugin:permissionRequest', payload: { pluginId: 'tasks', permissions: ['fs.write', 'shell.exec'] } })
      const e = emitted.find((x) => x.kind === 'plugin-permission-request')
      expect(e).toBeDefined()
      expect(e).toMatchObject({
        kind: 'plugin-permission-request',
        request: { pluginId: 'tasks', permissions: ['fs.write', 'shell.exec'], requestId: 'perm_tasks' },
      })
    })

    it('crashed → plugin-crashed', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:crashed', payload: { pluginId: 'tasks', workerId: 'w1', error: 'boom' } })
      const e = emitted.find((x) => x.kind === 'plugin-crashed')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'plugin-crashed', pluginId: 'tasks', error: 'boom' })
    })

    it('notification → plugin-notification', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:notification', payload: { pluginId: 'tasks', level: 'warn', message: 'low quota' } })
      const e = emitted.find((x) => x.kind === 'plugin-notification')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'plugin-notification', notification: { pluginId: 'tasks', level: 'warn', message: 'low quota' } })
    })

    it('config → plugin-config-changed', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:config', payload: { pluginId: 'tasks', config: { apiKey: 'x' } } })
      const e = emitted.find((x) => x.kind === 'plugin-config-changed')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'plugin-config-changed', pluginId: 'tasks', config: { apiKey: 'x' } })
    })

    it('messageDecoration → plugin-message-decoration', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:messageDecoration', payload: { messageId: 'm1', decoration: { bold: true } } })
      const e = emitted.find((x) => x.kind === 'plugin-message-decoration')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'plugin-message-decoration', decoration: { messageId: 'm1', decoration: { bold: true } } })
    })

    it('statusChange → plugin-status-change（newStatus 优先）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:statusChange', payload: { pluginId: 'tasks', oldStatus: 'active', newStatus: 'inactive' } })
      const e = emitted.find((x) => x.kind === 'plugin-status-change')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'plugin-status-change', pluginId: 'tasks', status: 'inactive' })
    })

    it('uiRequest → ui-request（kind=method）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:uiRequest', payload: { requestId: 'r1', pluginId: 'tasks', method: 'confirm', title: '确认？' } })
      const e = emitted.find((x) => x.kind === 'ui-request')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'ui-request', request: { requestId: 'r1', pluginId: 'tasks', kind: 'confirm', title: '确认？', method: 'confirm' } })
    })

    it('10 个 plugin:* 全部有 handler，无零订阅（kind 集合与 IF3 映射表逐一核对）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      const messages: IncomingPluginMessage[] = [
        { type: 'plugin:statusBarUpdate', payload: { items: [{ id: 'a', pluginId: 'p', text: 't', priority: 1 }] } },
        { type: 'plugin:statusSetUpdate', payload: { key: 'k', text: 't' } },
        { type: 'plugin:permissionRequest', payload: { pluginId: 'p', permissions: ['fs.write'] } },
        { type: 'plugin:crashed', payload: { pluginId: 'p', workerId: 'w', error: 'e' } },
        { type: 'plugin:notification', payload: { pluginId: 'p', message: 'm' } },
        { type: 'plugin:config', payload: { pluginId: 'p', config: {} } },
        { type: 'plugin:messageDecoration', payload: { messageId: 'm1' } },
        { type: 'plugin:statusChange', payload: { pluginId: 'p', oldStatus: 'active', newStatus: 'inactive' } },
        { type: 'plugin:uiRequest', payload: { requestId: 'r1', pluginId: 'p', method: 'input' } },
        // MF-1：plugin:viewUpdate 下行（runtime handleViewUpdate 广播形状）→ extension-widget
        { type: 'plugin:viewUpdate', payload: { sessionId: 's1', viewId: 'sidebar.tab', pluginId: 'p', guiTree: [{ type: 'ansi-text', props: { lines: ['hi'] } }], updatedAt: 1 } },
      ]
      for (const m of messages) source.emit(m)
      const expectedKinds = [
        'plugin-status-bar-update',
        'plugin-status-set-update',
        'plugin-permission-request',
        'plugin-crashed',
        'plugin-notification',
        'plugin-config-changed',
        'plugin-message-decoration',
        'plugin-status-change',
        'ui-request',
        'extension-widget',
      ]
      for (const kind of expectedKinds) {
        expect(emitted.some((x) => x.kind === kind), `expected ${kind} emitted`).toBe(true)
      }
      expect(emitted.some((x) => x.kind === 'error')).toBe(false)
      expect(emitted.length).toBe(10)
    })

    it('viewUpdate → extension-widget（sessionId 透传、viewId/pluginId/guiTree 直存，MF-1）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({
        type: 'plugin:viewUpdate',
        payload: { sessionId: 's1', viewId: 'sidebar.tab', pluginId: 'tasks', guiTree: [{ type: 'stats-line', props: { items: [] } }], updatedAt: 123 },
      })
      const e = emitted.find((x) => x.kind === 'extension-widget')
      expect(e).toBeDefined()
      expect(e).toMatchObject({
        kind: 'extension-widget',
        sessionId: 's1',
        widget: { viewId: 'sidebar.tab', pluginId: 'tasks', guiTree: [{ type: 'stats-line', props: { items: [] } }] },
      })
      // 非法形状（guiTree 非数组）→ error 事件（ERR2 不静默吞）
      source.emit({ type: 'plugin:viewUpdate', payload: { sessionId: 's1', viewId: 'v', pluginId: 'p', guiTree: 'nope' } })
      expect(emitted.some((x) => x.kind === 'error')).toBe(true)
    })
  })

  describe('FR5: 5 个 extension:* 收敛', () => {
    it('extension:widget → extension-widget（viewId=widgetKey、guiTree=lines）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'extension:widget', payload: { sessionId: 's1', widgetKey: 'terminal', lines: ['line1', 'line2'] } })
      const e = emitted.find((x) => x.kind === 'extension-widget')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'terminal', pluginId: '', guiTree: ['line1', 'line2'] } })
    })

    it('extension:widgetGui → extension-widget（gui 包进 guiTree）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'extension:widgetGui', payload: { sessionId: 's1', widgetKey: 'side', gui: { type: 'container', children: [] } } })
      const e = emitted.find((x) => x.kind === 'extension-widget')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', pluginId: '', guiTree: [{ type: 'container', children: [] }] } })
    })

    it('extension:widgetGui gui:null → 保留清除语义（[null]）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'extension:widgetGui', payload: { sessionId: 's1', widgetKey: 'side', gui: null } })
      const e = emitted.find((x) => x.kind === 'extension-widget')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'extension-widget', sessionId: 's1', widget: { viewId: 'side', guiTree: [null] } })
    })

    it('extension:status → extension-status（status←text、detail←textRaw）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'extension:status', payload: { sessionId: 's1', statusKey: 'session', text: 'working', textRaw: '\x1b[32mworking\x1b[0m' } })
      const e = emitted.find((x) => x.kind === 'extension-status')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'extension-status', sessionId: 's1', status: { pluginId: '', status: 'working', detail: '\x1b[32mworking\x1b[0m' } })
    })

    it('extension:notify → extension-notify', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'extension:notify', payload: { sessionId: 's1', message: 'done', level: 'info' } })
      const e = emitted.find((x) => x.kind === 'extension-notify')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'extension-notify', sessionId: 's1', notification: { pluginId: '', message: 'done', level: 'info' } })
    })

    it('extension.ui_request → ui-request（与 plugin:uiRequest 归一同一 kind）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'extension.ui_request', payload: { sessionId: 's1', requestId: 'r2', method: 'select', title: '选择', options: ['a', 'b'] } })
      const e = emitted.find((x) => x.kind === 'ui-request')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r2', pluginId: '', kind: 'select', title: '选择', method: 'select', options: ['a', 'b'] } })
    })

    it('5 个 extension:* 全部收敛，无零订阅', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'extension:widget', payload: { widgetKey: 'w', lines: [] } })
      source.emit({ type: 'extension:widgetGui', payload: { widgetKey: 'w', gui: null } })
      source.emit({ type: 'extension:status', payload: { text: 't' } })
      source.emit({ type: 'extension:notify', payload: { message: 'm' } })
      source.emit({ type: 'extension.ui_request', payload: { requestId: 'r', method: 'input' } })
      for (const kind of ['extension-widget', 'extension-status', 'extension-notify', 'ui-request']) {
        expect(emitted.some((x) => x.kind === kind), `expected ${kind} emitted`).toBe(true)
      }
      expect(emitted.some((x) => x.kind === 'error')).toBe(false)
      expect(emitted.length).toBe(5)
    })
  })

  describe('ERR2: 未知 type + payload 解析失败 → error 事件', () => {
    it('未知 type → error（source=msg.type）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'foo.bar', payload: {} })
      const e = emitted.find((x) => x.kind === 'error')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'error', source: 'foo.bar' })
      expect((e as { message: string }).message).toContain('unknown message type: foo.bar')
    })

    it('statusBarUpdate payload 非 {items} 数组 → error', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:statusBarUpdate', payload: { notItems: true } })
      const e = emitted.find((x) => x.kind === 'error')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'error', source: 'plugin:statusBarUpdate' })
      expect((e as { message: string }).message).toContain('parse failed')
    })

    it('statusBarUpdate items 缺必填字段 → error', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:statusBarUpdate', payload: { items: [{ id: 'a' }] } })
      const e = emitted.find((x) => x.kind === 'error')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'error', source: 'plugin:statusBarUpdate' })
    })

    it('permissionRequest payload 非 object → error', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:permissionRequest', payload: 'nope' })
      const e = emitted.find((x) => x.kind === 'error')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'error', source: 'plugin:permissionRequest' })
    })

    it('uiRequest 无 requestId → error', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:uiRequest', payload: { pluginId: 'p', method: 'input' } })
      const e = emitted.find((x) => x.kind === 'error')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'error', source: 'plugin:uiRequest' })
    })

    it('messageDecoration 无 messageId → error', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:messageDecoration', payload: { decoration: {} } })
      const e = emitted.find((x) => x.kind === 'error')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'error', source: 'plugin:messageDecoration' })
    })

    it('statusChange 非法 status → error', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:statusChange', payload: { pluginId: 'p', oldStatus: 'active', newStatus: 'zzz' } })
      const e = emitted.find((x) => x.kind === 'error')
      expect(e).toBeDefined()
      expect(e).toMatchObject({ kind: 'error', source: 'plugin:statusChange' })
    })
  })

  describe('dispose 防泄漏（C3 契约）', () => {
    it('dispose 后 listenerCount 归 0 且 emit 无新事件', () => {
      const { source, bus, bridge } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:statusBarUpdate', payload: { items: [] } })
      expect(emitted.length).toBe(1)
      expect(source.listenerCount()).toBe(1)

      bridge.dispose()
      expect(source.listenerCount()).toBe(0)

      emitted.length = 0
      source.emit({ type: 'plugin:notification', payload: { pluginId: 'p', message: 'm' } })
      expect(emitted.length).toBe(0)
    })

    it('dispose 幂等（重复调用安全）', () => {
      const { source, bridge } = makeBridge()
      bridge.dispose()
      expect(source.listenerCount()).toBe(0)
      bridge.dispose()
      expect(source.listenerCount()).toBe(0)
    })
  })

  describe('窄化映射抽查', () => {
    it('statusBarUpdate alignment 默认 "left"，显式 alignment 保留', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:statusBarUpdate', payload: { items: [{ id: 'a', pluginId: 'p', text: 't', priority: 1, alignment: 'right' }] } })
      source.emit({ type: 'plugin:statusBarUpdate', payload: { items: [{ id: 'b', pluginId: 'p', text: 't', priority: 1 }] } })
      const events = emitted.filter((x) => x.kind === 'plugin-status-bar-update')
      expect((events[0] as { items: Array<{ alignment: string }> }).items[0].alignment).toBe('right')
      expect((events[1] as { items: Array<{ alignment: string }> }).items[0].alignment).toBe('left')
    })

    it('statusBarUpdate sessionId 传播：msg.sessionId 优先，payload.sessionId 兜底', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:statusBarUpdate', sessionId: 'top', payload: { sessionId: 'inner', items: [] } })
      source.emit({ type: 'plugin:statusBarUpdate', payload: { sessionId: 'inner2', items: [] } })
      const events = emitted.filter((x) => x.kind === 'plugin-status-bar-update')
      expect((events[0] as { sessionId?: string }).sessionId).toBe('top')
      expect((events[1] as { sessionId?: string }).sessionId).toBe('inner2')
    })

    it('uiRequest method=editor → kind 兜底 "input" + 原始 method 经索引签名保留', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:uiRequest', payload: { requestId: 'r1', pluginId: 'p', method: 'editor', prefill: 'x' } })
      const e = emitted.find((x) => x.kind === 'ui-request')
      expect(e).toBeDefined()
      const req = (e as { request: Record<string, unknown> }).request
      expect(req.kind).toBe('input')
      expect(req.method).toBe('editor')
    })

    it('extension.ui_request method=editor 同样兜底', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'extension.ui_request', payload: { sessionId: 's1', requestId: 'r2', method: 'editor' } })
      const e = emitted.find((x) => x.kind === 'ui-request')
      expect(e).toBeDefined()
      const req = (e as { request: Record<string, unknown> }).request
      expect(req.kind).toBe('input')
      expect(req.method).toBe('editor')
    })
  })

  describe('CT-D5 毒化隔离：statusbar 更新单条坏值跳过该条而非整包丢弃', () => {
    /** 好条目工厂（runtime StatusBarItem 形状：id/pluginId/text/priority 必填） */
    const goodItem = (id: string, text: string) => ({ id, pluginId: `p-${id}`, text, priority: 1 })

    it('CT-D5 parseStatusBarUpdate 直调（导出供测试）：text:{} 单条坏值跳过该条，保留其余条目', () => {
      const result = parseStatusBarUpdate({
        type: 'plugin:statusBarUpdate',
        payload: {
          items: [
            goodItem('good1', 'ok1'),
            { id: 'bad', pluginId: 'p-bad', text: {}, priority: 2 },
            goodItem('good2', 'ok2'),
          ],
        },
      })
      // 旧行为（整包 null 丢弃）已改造：单条坏值不再连坐其余条目
      expect(result).not.toBeNull()
      expect(result?.kind).toBe('plugin-status-bar-update')
      expect(((result ?? {}) as { items?: Array<{ id: string }> }).items?.map((i) => i.id)).toEqual(['good1', 'good2'])
    })

    it('CT-D5 经 bridge 完整链路：坏条目跳过、好条目正常上屏、不 emit error', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({
        type: 'plugin:statusBarUpdate',
        payload: {
          items: [
            goodItem('good1', 'ok1'),
            { id: 'bad', pluginId: 'p-bad', text: {}, priority: 2 },
          ],
        },
      })
      const e = emitted.find((x) => x.kind === 'plugin-status-bar-update')
      expect(e).toBeDefined()
      expect((e as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(['good1'])
      expect(emitted.some((x) => x.kind === 'error')).toBe(false)
    })

    it('CT-D5 非 object 条目（string/null/number）同样跳过该条，保留其余条目', () => {
      // 覆盖逐条窄化的 asRecord 落空分支（坏条目不只是字段缺失，还可能是非 object 值）
      const result = parseStatusBarUpdate({
        type: 'plugin:statusBarUpdate',
        payload: { items: ['nope', null, 42, goodItem('good1', 'ok1')] },
      })
      expect(result).not.toBeNull()
      expect(((result ?? {}) as { items?: Array<{ id: string }> }).items?.map((i) => i.id)).toEqual(['good1'])
    })

    it('CT-D5 全部条目均坏（items 非空零存活）→ 仍整包 error（毒化上报），与合法清空区分', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({
        type: 'plugin:statusBarUpdate',
        payload: { items: [{ id: 'bad', pluginId: 'p', text: {}, priority: 1 }] },
      })
      expect(emitted.find((x) => x.kind === 'plugin-status-bar-update')).toBeUndefined()
      expect(emitted.some((x) => x.kind === 'error')).toBe(true)
    })

    it('CT-D5 合法清空语义不受影响：items:[] → 正常事件（非 error）', () => {
      const { source, bus } = makeBridge()
      const { emitted } = spyEmit(bus)
      source.emit({ type: 'plugin:statusBarUpdate', payload: { items: [] } })
      const e = emitted.find((x) => x.kind === 'plugin-status-bar-update')
      expect(e).toBeDefined()
      expect((e as { items: unknown[] }).items).toHaveLength(0)
      expect(emitted.some((x) => x.kind === 'error')).toBe(false)
    })
  })
})
