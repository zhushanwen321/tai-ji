/**
 * status-bar-controller.test.ts —— StatusBarController 单测（IF8 + AC7 + ERR4 + clarify Q3）。
 *
 * 覆盖：scope 分流（global/per-session）、分区键优先级三态（item 级 > 事件级 > '__global__'）、
 * statusSet/extensionStatus 聚合、ERR4 session-destroyed cleanup、unsubscribe 防泄漏。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { StatusBarController, GLOBAL_STATUS_KEY } from '../status-bar-controller'
import { InternalEventBus } from '../internal-event-bus'
import { createSessionScopedMap } from '../utils/session-scoped-map'
import type { StatusBarEntry } from '../types'

function makeController() {
  const bus = new InternalEventBus()
  const sessionScoped = createSessionScopedMap(() => ({ items: [] as StatusBarEntry[], setEntries: [] as { id: string; pluginId: string; text: string }[] }))
  const controller = new StatusBarController({ bus, sessionScoped })
  controller.subscribe()
  return { bus, sessionScoped, controller }
}

describe('StatusBarController', () => {
  beforeEach(() => {
    // 无全局状态残留
  })

  describe('scope 分流（IF8）', () => {
    it('global 项进 globalState，getItems("global") 含该项', () => {
      const { bus, controller } = makeController()
      bus.emit({
        kind: 'plugin-status-bar-update',
        items: [{ id: 'g1', pluginId: 'statusline', text: '3 tasks', alignment: 'left', priority: 100, scope: 'global' }],
      })
      expect(controller.getItems('global')).toHaveLength(1)
      expect(controller.getItems('global')[0].id).toBe('g1')
    })

    it('per-session 项进对应分区，getItems("per-session","s1") 含该项 + global 不含', () => {
      const { bus, controller } = makeController()
      bus.emit({
        kind: 'plugin-status-bar-update',
        items: [{ id: 'p1', pluginId: 'tasks', text: '2 todos', alignment: 'right', priority: 50, scope: 'per-session', sessionId: 's1' }],
      })
      expect(controller.getItems('per-session', 's1')).toHaveLength(1)
      expect(controller.getItems('per-session', 's1')[0].id).toBe('p1')
      expect(controller.getItems('global')).toHaveLength(0)
    })

    it('scope 缺失（旧消费方）默认归 global（IF8 分流兜底，clarify Q3）', () => {
      const { bus, controller } = makeController()
      bus.emit({
        kind: 'plugin-status-bar-update',
        items: [{ id: 'legacy1', pluginId: 'statusline', text: 'ready', alignment: 'left', priority: 10 }],
      })
      expect(controller.getItems('global')).toHaveLength(1)
      expect(controller.getItems('global')[0].id).toBe('legacy1')
    })
  })

  describe('分区键优先级三态（clarify Q3）', () => {
    it('item 级 sessionId 优先于事件级', () => {
      const { bus, controller } = makeController()
      bus.emit({
        kind: 'plugin-status-bar-update',
        sessionId: 'event-sid',
        items: [{ id: 'x1', pluginId: 'tasks', text: 't', alignment: 'left', priority: 1, scope: 'per-session', sessionId: 'item-sid' }],
      })
      expect(controller.getItems('per-session', 'item-sid')).toHaveLength(1)
      expect(controller.getItems('per-session', 'event-sid')).toHaveLength(0)
    })

    it('仅事件级 sessionId → 取事件级', () => {
      const { bus, controller } = makeController()
      bus.emit({
        kind: 'plugin-status-bar-update',
        sessionId: 'event-sid',
        items: [{ id: 'x2', pluginId: 'tasks', text: 't', alignment: 'left', priority: 1, scope: 'per-session' }],
      })
      expect(controller.getItems('per-session', 'event-sid')).toHaveLength(1)
    })

    it('两者皆无 → __global__ 兜底', () => {
      const { bus, controller } = makeController()
      bus.emit({
        kind: 'plugin-status-bar-update',
        items: [{ id: 'x3', pluginId: 'tasks', text: 't', alignment: 'left', priority: 1, scope: 'per-session' }],
      })
      expect(controller.getItems('per-session', GLOBAL_STATUS_KEY)).toHaveLength(1)
    })
  })

  describe('statusSet / extensionStatus 聚合', () => {
    it('plugin-status-set-update → 分区 setEntries 含条目', () => {
      const { bus, controller } = makeController()
      bus.emit({ kind: 'plugin-status-set-update', sessionId: 's1', status: [{ id: 'session', pluginId: '', text: 'ready' }] })
      const state = controller.getSessionState('s1')
      expect(state).toBeDefined()
      expect(state!.setEntries).toHaveLength(1)
      expect(state!.setEntries[0].id).toBe('session')
    })

    it('extension-status → 分区 extensionStatus 被设置', () => {
      const { bus, controller } = makeController()
      bus.emit({ kind: 'extension-status', sessionId: 's1', status: { pluginId: '', status: 'working', detail: 'task-1' } })
      const state = controller.getSessionState('s1')
      expect(state).toBeDefined()
      expect(state!.extensionStatus).toMatchObject({ status: 'working', detail: 'task-1' })
    })
  })

  describe('ERR5: 全量快照替换语义（同 id 更新不累积 + 删除同步消失）', () => {
    it('global：同 pluginId:id 更新 → 长度不变 + 文本为新值（不累积）', () => {
      const { bus, controller } = makeController()
      const base = { pluginId: 'statusline', id: 'g1', text: '3 tasks', alignment: 'left' as const, priority: 100, scope: 'global' as const }
      bus.emit({ kind: 'plugin-status-bar-update', items: [base] })
      bus.emit({ kind: 'plugin-status-bar-update', items: [{ ...base, text: '4 tasks' }] })
      expect(controller.getItems('global')).toHaveLength(1)
      expect(controller.getItems('global')[0].text).toBe('4 tasks')
    })

    it('global：不同插件同 id 不互相替换（pluginId:id 复合键，同一快照内共存）', () => {
      const { bus, controller } = makeController()
      const a = { pluginId: 'pA', id: 'x', text: 'A', alignment: 'left' as const, priority: 100, scope: 'global' as const }
      const b = { pluginId: 'pB', id: 'x', text: 'B', alignment: 'left' as const, priority: 100, scope: 'global' as const }
      // 同一全量快照中两个插件各自 id:'x'：复合键区分，互不覆盖
      bus.emit({ kind: 'plugin-status-bar-update', items: [a, b] })
      expect(controller.getItems('global')).toHaveLength(2)
      expect(controller.getItems('global').map((i) => i.pluginId).sort()).toEqual(['pA', 'pB'])
    })

    it('per-session：同 key 更新不累积（分区内替换）', () => {
      const { bus, controller } = makeController()
      const base = { pluginId: 'tasks', id: 'p1', text: '2 todos', alignment: 'right' as const, priority: 50, scope: 'per-session' as const, sessionId: 's1' }
      bus.emit({ kind: 'plugin-status-bar-update', items: [base] })
      bus.emit({ kind: 'plugin-status-bar-update', items: [{ ...base, text: '3 todos' }] })
      expect(controller.getItems('per-session', 's1')).toHaveLength(1)
      expect(controller.getItems('per-session', 's1')[0].text).toBe('3 todos')
    })

    it('per-session：runtime 删除（全量广播不再含该 item）→ 条目消失', () => {
      const { bus, controller } = makeController()
      bus.emit({
        kind: 'plugin-status-bar-update',
        items: [{ id: 'p1', pluginId: 'tasks', text: 't', alignment: 'left', priority: 1, scope: 'per-session', sessionId: 's1' }],
      })
      expect(controller.getItems('per-session', 's1')).toHaveLength(1)
      // 空 text 移除 / clearForPlugin 后广播全量不含该 item
      bus.emit({ kind: 'plugin-status-bar-update', items: [] })
      expect(controller.getItems('per-session', 's1')).toHaveLength(0)
      expect(controller.getItems('global')).toHaveLength(0)
    })

    it('per-session：广播未提及的分区被清空（快照外条目不残留）', () => {
      const { bus, sessionScoped, controller } = makeController()
      const item = (id: string, sid: string) => ({ id, pluginId: 'tasks', text: 't', alignment: 'left' as const, priority: 1, scope: 'per-session' as const, sessionId: sid })
      bus.emit({ kind: 'plugin-status-bar-update', items: [item('p1', 's1'), item('p2', 's2')] })
      expect(controller.getItems('per-session', 's1')).toHaveLength(1)
      expect(controller.getItems('per-session', 's2')).toHaveLength(1)
      // 新快照只剩 s1 的 item：s2 分区应被清空（其条目在 runtime 已全部删除）
      bus.emit({ kind: 'plugin-status-bar-update', items: [item('p1', 's1')] })
      expect(controller.getItems('per-session', 's1')).toHaveLength(1)
      expect(controller.getItems('per-session', 's2')).toHaveLength(0)
      expect(sessionScoped.has('s2')).toBe(false)
    })
  })

  describe('ERR4: session-destroyed cleanup', () => {
    it('session-destroyed → 分区清空（has false）+ getItems 返回空数组', () => {
      const { bus, sessionScoped, controller } = makeController()
      bus.emit({
        kind: 'plugin-status-bar-update',
        items: [{ id: 'p1', pluginId: 'tasks', text: 't', alignment: 'left', priority: 1, scope: 'per-session', sessionId: 's1' }],
      })
      expect(controller.getItems('per-session', 's1')).toHaveLength(1)

      bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
      expect(sessionScoped.has('s1')).toBe(false)
      expect(controller.getItems('per-session', 's1')).toHaveLength(0)
    })
  })

  describe('unsubscribe 防泄漏（项目规则#2）', () => {
    it('dispose 后不再接收事件', () => {
      const { bus, controller } = makeController()
      controller.dispose()
      bus.emit({
        kind: 'plugin-status-bar-update',
        items: [{ id: 'late1', pluginId: 'tasks', text: 't', alignment: 'left', priority: 1, scope: 'global' }],
      })
      expect(controller.getItems('global')).toHaveLength(0)
    })
  })
})
