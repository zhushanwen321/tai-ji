/**
 * plugin-modal-slot.test.ts —— plugin-modal-slot 单测（AP-2 单例语义：open/close/replaced 仲裁）。
 *
 * 覆盖：空槽 open / 同 (pluginId,modalId) 重复 open（epoch 递增、不产生 replaced、owner 不变）/
 * 不同 owner replaced；epoch 单调（陈旧 open ≤ 高水位丢弃）；close 三元组校验
 * （陈旧 epoch / owner 不匹配 → not-applied 槽不变、命中 → 槽清空、closed 后再 close 幂等）；
 * clearPluginModalForPlugin（plugin-gone）；plugin:modalState 帧驱动镜像
 * （含「关闭在途→立即重开」陈旧 closed 帧不误关新层）；subscribePluginModalSlot 幂等防翻倍。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  openPluginModal,
  closePluginModal,
  getPluginModalSlot,
  clearPluginModalForPlugin,
  subscribePluginModalSlot,
  resetPluginModalSlot,
} from '../plugin-modal-slot'
import type { ModalCloseResult, ModalOpenResult, PluginModalOpenRequest } from '../plugin-modal-slot'
import { InternalEventBus } from '../internal-event-bus'

beforeEach(() => {
  // 模块级单例：状态跨用例共享，beforeEach 全量重置（search-modal 同款隔离手法）
  resetPluginModalSlot()
})

const OPEN: PluginModalOpenRequest = { pluginId: 'p1', modalId: 'm1', sessionId: 's1' }

/** open 并断言生效（收窄 union 供 record/replaced 访问）。 */
function openOk(req: PluginModalOpenRequest): Extract<ModalOpenResult, { applied: true }> {
  const r = openPluginModal(req)
  if (!r.applied) throw new Error(`open not applied: ${r.notApplied}`)
  return r
}

/** close 并断言生效（收窄 union 供 closed 访问）。 */
function closeOk(pluginId: string, modalId: string, epoch: number, reason?: Parameters<typeof closePluginModal>[3]): Extract<ModalCloseResult, { applied: true }> {
  const r = closePluginModal(pluginId, modalId, epoch, reason)
  if (!r.applied) throw new Error(`close not applied: ${r.notApplied}`)
  return r
}

describe('plugin-modal-slot（AP-2 全局单槽）', () => {
  describe('open 仲裁', () => {
    it('空槽 open → opened，epoch=1，记录含调用参数（title/width 缺省无值）', () => {
      const r = openOk({ ...OPEN })
      expect(r.outcome).toBe('opened')
      expect(getPluginModalSlot()).toMatchObject({ pluginId: 'p1', modalId: 'm1', sessionId: 's1', epoch: 1 })
      expect(getPluginModalSlot()!.title).toBeUndefined()
      expect(getPluginModalSlot()!.width).toBeUndefined()
    })

    it('同 (pluginId,modalId) 重复 open → reopened：epoch 递增、记录更新为最新参数、无 replaced（不算换主）', () => {
      openOk({ ...OPEN, title: '旧标题' })
      const r = openOk({ ...OPEN, sessionId: 's2', title: '新标题' })
      expect(r.outcome).toBe('reopened')
      expect(r.replaced).toBeUndefined()
      expect(getPluginModalSlot()).toMatchObject({ pluginId: 'p1', modalId: 'm1', sessionId: 's2', title: '新标题', epoch: 2 })
    })

    it('不同 owner open → replaced：旧记录随 replaced 上浮，新槽 epoch 递增', () => {
      openOk({ ...OPEN })
      const r = openOk({ pluginId: 'p2', modalId: 'm2', sessionId: 's1', epoch: 2 })
      expect(r.outcome).toBe('replaced')
      expect(r.replaced).toMatchObject({ pluginId: 'p1', modalId: 'm1', sessionId: 's1', epoch: 1 })
      expect(getPluginModalSlot()).toMatchObject({ pluginId: 'p2', modalId: 'm2', epoch: 2 })
    })

    it('epoch 严格单调递增（opened/reopened/replaced 混合序列）', () => {
      expect(openOk({ ...OPEN }).record.epoch).toBe(1)
      expect(openOk({ ...OPEN }).record.epoch).toBe(2)
      expect(openOk({ pluginId: 'p2', modalId: 'm2', sessionId: 's1' }).record.epoch).toBe(3)
      expect(openOk({ pluginId: 'p3', modalId: 'm3', sessionId: 's1' }).record.epoch).toBe(4)
    })

    it('陈旧 open（epoch ≤ 高水位）→ not-applied（stale-epoch），槽不变', () => {
      openOk({ ...OPEN, epoch: 5 })
      const before = getPluginModalSlot()
      expect(openPluginModal({ pluginId: 'p2', modalId: 'm2', sessionId: 's1', epoch: 5 })).toEqual({ applied: false, notApplied: 'stale-epoch' })
      expect(openPluginModal({ pluginId: 'p2', modalId: 'm2', sessionId: 's1', epoch: 3 })).toEqual({ applied: false, notApplied: 'stale-epoch' })
      expect(getPluginModalSlot()).toBe(before)
    })
  })

  describe('close 三元组校验（(pluginId, modalId, epoch)）', () => {
    it('三元组命中 → applied + 槽清空 + closed 记录；reason 缺省 dismissed', () => {
      openOk({ ...OPEN })
      const r = closeOk('p1', 'm1', 1)
      expect(r.reason).toBe('dismissed')
      expect(r.closed).toMatchObject({ pluginId: 'p1', modalId: 'm1', sessionId: 's1', epoch: 1 })
      expect(getPluginModalSlot()).toBeNull()
    })

    it('reason 透传（host 侧 session-switched，D1 切会话关闭）', () => {
      openOk({ ...OPEN })
      expect(closeOk('p1', 'm1', 1, 'session-switched').reason).toBe('session-switched')
      expect(getPluginModalSlot()).toBeNull()
    })

    it('陈旧 dismiss（epoch 不等）→ not-applied（epoch-mismatch），槽不变（防误关刚重开的新层）', () => {
      openOk({ ...OPEN, epoch: 7 })
      expect(closePluginModal('p1', 'm1', 6)).toEqual({ applied: false, notApplied: 'epoch-mismatch' })
      expect(getPluginModalSlot()).toMatchObject({ epoch: 7 })
    })

    it('owner 不匹配 → not-applied（owner-mismatch），槽不变', () => {
      openOk({ ...OPEN })
      expect(closePluginModal('pX', 'm1', 1)).toEqual({ applied: false, notApplied: 'owner-mismatch' })
      expect(closePluginModal('p1', 'mX', 1)).toEqual({ applied: false, notApplied: 'owner-mismatch' })
      expect(getPluginModalSlot()).toMatchObject({ pluginId: 'p1', modalId: 'm1', epoch: 1 })
    })

    it('closed 后再 close → not-applied（not-open，幂等）', () => {
      openOk({ ...OPEN })
      expect(closeOk('p1', 'm1', 1).applied).toBe(true)
      expect(closePluginModal('p1', 'm1', 1)).toEqual({ applied: false, notApplied: 'not-open' })
      expect(getPluginModalSlot()).toBeNull()
    })

    it('close 后重开：epoch 必须超过高水位（runtime 每次生效 open 递增的镜像契约）', () => {
      openOk({ ...OPEN })
      closeOk('p1', 'm1', 1)
      expect(openPluginModal({ ...OPEN, epoch: 1 })).toEqual({ applied: false, notApplied: 'stale-epoch' })
      expect(openOk({ ...OPEN, epoch: 2 }).outcome).toBe('opened')
    })
  })

  describe('clearPluginModalForPlugin（AP-1 生命周期：崩溃/禁用/卸载）', () => {
    it('owner 命中 → applied（reason=plugin-gone），槽清空', () => {
      openOk({ ...OPEN })
      const r = clearPluginModalForPlugin('p1')
      expect(r).toMatchObject({ applied: true, reason: 'plugin-gone' })
      expect(getPluginModalSlot()).toBeNull()
    })

    it('owner 非该插件 → not-applied（owner-mismatch），槽不变；空槽 → not-open', () => {
      openOk({ ...OPEN })
      expect(clearPluginModalForPlugin('pX')).toEqual({ applied: false, notApplied: 'owner-mismatch' })
      expect(getPluginModalSlot()).toMatchObject({ pluginId: 'p1' })
      closeOk('p1', 'm1', 1)
      expect(clearPluginModalForPlugin('p1')).toEqual({ applied: false, notApplied: 'not-open' })
    })
  })

  describe('plugin:modalState 帧驱动镜像', () => {
    it('open 帧 → 槽更新；closed 帧 → 槽清空（reason 缺省 dismissed）', () => {
      const bus = new InternalEventBus()
      subscribePluginModalSlot(bus)
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 1 } })
      expect(getPluginModalSlot()).toMatchObject({ pluginId: 'p1', modalId: 'm1', sessionId: 's1', epoch: 1 })
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'closed', epoch: 1 } })
      expect(getPluginModalSlot()).toBeNull()
    })

    it('「关闭在途→立即重开」：重开后的陈旧 closed 帧（epoch 不等）不误关新层（AP-2 幂等与竞态）', () => {
      // 陈旧 closed 帧触发 close not-applied 的 warn 留痕（AP-2 关①），本用例只断言槽语义，mock 掉输出
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const bus = new InternalEventBus()
      subscribePluginModalSlot(bus)
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 1 } })
      // 用户 Esc（dismiss ep1 在途）→ 立即重开 → runtime 广播带新 epoch 的 open 帧
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 2 } })
      // 迟到的 ep1 closed 帧（镜像侧按同款三元组规则防御）
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'closed', epoch: 1, reason: 'dismissed' } })
      expect(getPluginModalSlot()).toMatchObject({ epoch: 2 })
      vi.restoreAllMocks()
    })

    it('closed 帧三元组不匹配 → console.warn 留痕（pluginId/modalId/epoch + notApplied 原因）；命中 close 不 warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const bus = new InternalEventBus()
      subscribePluginModalSlot(bus)
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 1 } })
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 2 } })
      // 迟到的 ep1 closed 帧 → not-applied（epoch-mismatch）→ warn 带三元组与原因、槽不变
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'closed', epoch: 1, reason: 'dismissed' } })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const warnText = String(warnSpy.mock.calls[0]?.[0])
      expect(warnText).toContain('epoch-mismatch')
      expect(warnText).toContain('pluginId=p1')
      expect(warnText).toContain('modalId=m1')
      expect(warnText).toContain('epoch=1')
      expect(getPluginModalSlot()).toMatchObject({ epoch: 2 })
      // 命中 close（三元组匹配）→ 槽清空且不 warn
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'closed', epoch: 2, reason: 'dismissed' } })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(getPluginModalSlot()).toBeNull()
      vi.restoreAllMocks()
    })

    it('replaced 帧序列：不同 owner 的 open 帧 → 槽切到新 owner', () => {
      const bus = new InternalEventBus()
      subscribePluginModalSlot(bus)
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 1 } })
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p2', modalId: 'm2', sessionId: 's1', state: 'open', epoch: 2 } })
      expect(getPluginModalSlot()).toMatchObject({ pluginId: 'p2', modalId: 'm2', epoch: 2 })
    })

    it('subscribePluginModalSlot 幂等：重复订阅返回同一取消函数，unsubscribe 后帧不再驱动', () => {
      const bus = new InternalEventBus()
      const unsub1 = subscribePluginModalSlot(bus)
      const unsub2 = subscribePluginModalSlot(bus)
      expect(unsub2).toBe(unsub1)
      unsub1()
      bus.emit({ kind: 'plugin:modalState', modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 1 } })
      expect(getPluginModalSlot()).toBeNull()
    })
  })
})
