/**
 * S5-kernel-unit-tests — 根单元聚合验收的内核冒烟名字锚（design.md §4 S5 同族：
 * 内核行为由 A* 用例全覆盖，本文件是聚合验收入口的精简冒烟，不是替代）。
 *
 * 场景取 S1 的内核半边最小复刻（真实 createDelivery + mock port）：
 * ① busy 下 sendChecked 经投递受理入 pi 队列（resolve = `{queued:true}` 语义，
 *    受理即可达性确认，不返回假 queued）；② 普通 send 的 busy 排队 → settled
 * 边沿 flush 送达。`cd packages/session-delivery && npx vitest run` 全绿即锚生效。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryIntent, DeliveryMessage, DeliveryPort } from '../src/types.js'

describe('S5-kernel-unit-tests 聚合冒烟（根单元验收锚）', () => {
  it('busy sendChecked 经投递受理入 pi 队列（queued 语义）→ resolve + 队列清空', async () => {
    const sendCalls: { msg: DeliveryMessage; intent: DeliveryIntent }[] = []
    let idle = false // busy 起步
    const port: DeliveryPort = {
      supportedPayloads: ['text'],
      isIdle: () => idle,
      hasPendingMessages: () => false,
      send: (msg, intent) => {
        sendCalls.push({ msg, intent })
      },
      subscribeSettled: (cb) => {
        void cb
        return () => {}
      },
    }

    const handle = createDelivery(port)
    try {
      // busy：不返回假 queued——直投经 streaming 受理入 pi 队列即回（探针 P1）
      await expect(
        handle.sendChecked({ payload: { kind: 'text', content: 'S5 smoke message' } }),
      ).resolves.toBeUndefined()
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]!.msg.payload).toEqual({ kind: 'text', content: 'S5 smoke message' })
      expect(sendCalls[0]!.intent).toBe('interrupt-at-turn-boundary')
      expect(handle.depth()).toBe(0)
    } finally {
      handle.dispose()
    }
  })

  it('pi 死（port.send 抛错）且 runtime 标志 busy → sendChecked reject（不假 queued）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port: DeliveryPort = {
      supportedPayloads: ['text'],
      isIdle: () => false, // 僵尸 busy 标志
      hasPendingMessages: () => false,
      send: () => {
        throw new Error('pi process died')
      },
    }

    const handle = createDelivery(port)
    try {
      await expect(
        handle.sendChecked({ payload: { kind: 'text', content: 'S5 smoke message' } }),
      ).rejects.toThrow('pi process died')
      expect(handle.depth()).toBe(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('普通 send busy 排队 → settled 边沿 busy 复核通过 → flush 送达 → 队列清空', () => {
    const sendCalls: { msg: DeliveryMessage; intent: DeliveryIntent }[] = []
    let idle = false // busy 起步
    let settledCb: (() => void) | undefined
    const port: DeliveryPort = {
      supportedPayloads: ['text'],
      isIdle: () => idle,
      hasPendingMessages: () => false,
      send: (msg, intent) => {
        sendCalls.push({ msg, intent })
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {
          settledCb = undefined
        }
      },
    }

    const handle = createDelivery(port)
    try {
      handle.send({ payload: { kind: 'text', content: 'S5 smoke message' } })
      expect(sendCalls).toHaveLength(0)
      expect(handle.depth()).toBe(1)

      // settled 边沿：busy 复核通过 → flush 送达
      idle = true
      settledCb?.()
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]!.intent).toBe('interrupt-at-turn-boundary')
      expect(handle.depth()).toBe(0)
    } finally {
      handle.dispose()
    }
  })
})
