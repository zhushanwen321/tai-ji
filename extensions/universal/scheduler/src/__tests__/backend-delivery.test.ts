// src/__tests__/backend-delivery.test.ts —— 到期 dispatch 投递端口接入（unified-delivery
// 迁移，2026-10-25 裁决）的单元：PiSchedulerBackend.deliverDispatch 经真实投递端口
// （bindDeliveryPort + 最小 fake host，同 base-tool-enhance notify.test.ts 形态）锁定：
//
//  1. 注入参数逐字一致：port 内部对 steer 档条目的 host.sendMessage 调用与直发兜底
//     完全同形（customType / content / display / {deliverAs:'steer', triggerTurn:true}），
//     仅 details 追加端口送达凭据 deliveryId；
//  2. 幂等键跨轮唯一：同 taskId 两轮 dispatch（不同键）各自注入不被判重吞掉；同键
//     重提被吞（恒定 taskId 会被端口按终局条目永久判重的对照锁）；
//  3. 失败语义 forget：受理后注入失败端口首败即弃——落 discard 终局、不留账、不重投
//     （recover 差集为空），重试由 scheduler 侧 failed 记账承载；
//  4. 端口拒收（persist-failed）→ deliverDispatch throw → runtime 既有 failed 记账
//     路径在新返回值形态下仍工作，下个 tick 重试（新幂等键）照常注入；
//  5. port 缺席 → 直发兜底：pi.sendMessage 参数与迁移前逐字一致 + warn 留痕。
import { describe, expect, it, afterEach, vi } from 'vitest'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  _resetDeliveryPortForTest,
  bindDeliveryPort,
  getDeliveryPort,
  ACK_CUSTOM_TYPE,
  OUTBOX_CUSTOM_TYPE,
  type DeliveryPortHost,
} from '@zhushanwen/pi-delivery-port'

// Mock 共享 logger，让 deliverDispatch 缺席兜底的 warn 可被 spy
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}))

import { PiSchedulerBackend } from '../backend.js'
import type { SchedulerBackendCtx } from '../backend.js'
import { SchedulerRuntime } from '../runtime.js'

/** port 宿主 mock（结构满足 DeliveryPortHost；idle 恒真 = 提交即注入，免缓冲挂起）。 */
function createPortHost(overrides: Partial<DeliveryPortHost> = {}): DeliveryPortHost & {
  appendEntry: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
} {
  return {
    appendEntry: vi.fn(),
    readSessionEntries: () => [],
    isIdle: () => true,
    sendMessage: vi.fn(),
    onMessageEnd: vi.fn(() => () => {}),
    onAgentSettled: vi.fn(() => () => {}),
    onSessionBeforeCompact: vi.fn(() => () => {}),
    onSessionCompact: vi.fn(() => () => {}),
    onSessionCompactFailed: vi.fn(() => () => {}),
    logger: { warn: vi.fn(), debug: vi.fn() },
    ...overrides,
  }
}

/** 最小假 pi（deliverDispatch 直发兜底与 ack 转发面）。 */
function createFakePi() {
  const calls: Array<{ msg: unknown; opts: unknown }> = []
  return {
    calls,
    pi: {
      sendMessage: async (msg: unknown, opts?: unknown) => {
        calls.push({ msg, opts })
      },
      appendEntry: () => {},
      registerProvider: () => {},
      unregisterProvider: () => {},
    } as unknown as Pick<ExtensionAPI, 'sendMessage' | 'appendEntry' | 'registerProvider' | 'unregisterProvider'>,
  }
}

/** 最小 ctx（PiSchedulerBackend 构造只读 sessionManager 两方法）。 */
function createCtx(): SchedulerBackendCtx {
  return {
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => '/test/session.json',
      getLeafId: () => null,
    },
    isIdle: () => true,
  }
}

/** dispatch 消息（与 runtime.dispatchTaskInner 的调用逐字一致）。 */
const DISPATCH_MSG = { content: 'check build', customType: 'pi-scheduler:dispatched', display: true }
const DISPATCH_OPTS = { deliverAs: 'steer' as const, triggerTurn: true }

afterEach(() => {
  _resetDeliveryPortForTest()
  vi.clearAllMocks()
})

describe('PiSchedulerBackend.deliverDispatch（unified-delivery 迁移）', () => {
  it('port 受理 → 注入参数与直发逐字一致（steer + triggerTurn + deliveryId 凭据）', async () => {
    const host = createPortHost()
    bindDeliveryPort(host)
    const backend = new PiSchedulerBackend(createCtx(), createFakePi().pi)

    await backend.deliverDispatch(DISPATCH_MSG, DISPATCH_OPTS, 'task-1:1000')

    // 注入形态：与迁移前 pi.sendMessage 直发同形，details 仅追加端口送达凭据 deliveryId
    expect(host.sendMessage).toHaveBeenCalledTimes(1)
    const [message, options] = host.sendMessage.mock.calls[0] as [
      { customType: string; content: string; display: boolean; details: { deliveryId: string } },
      { deliverAs: string; triggerTurn: boolean },
    ]
    expect(message).toEqual({
      customType: 'pi-scheduler:dispatched',
      content: 'check build',
      display: true,
      details: { deliveryId: 'task-1:1000' },
    })
    expect(options).toEqual({ deliverAs: 'steer', triggerTurn: true })

    // 受理前落投递日志（outbox）：幂等键 + steer 档
    const outbox = host.appendEntry.mock.calls.find(c => c[0] === OUTBOX_CUSTOM_TYPE)
    expect(outbox).toBeDefined()
    expect(outbox![1]).toMatchObject({ id: 'task-1:1000', timing: 'steer' })
  })

  it('幂等键跨轮唯一：两轮 dispatch 各自注入不被判重吞掉；同键重提被吞（对照锁）', async () => {
    const host = createPortHost()
    bindDeliveryPort(host)
    const backend = new PiSchedulerBackend(createCtx(), createFakePi().pi)

    // 第一轮：键 task-1:1000 → 注入
    await backend.deliverDispatch(DISPATCH_MSG, DISPATCH_OPTS, 'task-1:1000')
    // 第二轮：新键 task-1:1030（每轮唯一）→ 不被第一轮终局/在途条目判重，照常注入
    await backend.deliverDispatch(DISPATCH_MSG, DISPATCH_OPTS, 'task-1:1030')
    expect(host.sendMessage).toHaveBeenCalledTimes(2)

    // 对照锁：同键重提（= 迁移前恒定 taskId 的形态）→ 端口判重吞掉，不第三次注入。
    // 这正是幂等键必须含轮次维度的原因——恒定 taskId 从第二轮起任务永不再提醒。
    await backend.deliverDispatch(DISPATCH_MSG, DISPATCH_OPTS, 'task-1:1000')
    expect(host.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('失败语义 forget：注入失败端口首败即弃——落 discard 终局、不留账、不重投', async () => {
    const host = createPortHost({ sendMessage: vi.fn(() => { throw new Error('stale ctx') }) })
    bindDeliveryPort(host)
    const backend = new PiSchedulerBackend(createCtx(), createFakePi().pi)

    // 受理即记账：注入失败不上抛（端口按 forget 首败即弃，该轮提醒丢失为已裁决代价）
    await expect(backend.deliverDispatch(DISPATCH_MSG, DISPATCH_OPTS, 'task-1:1000')).resolves.toBeUndefined()

    // discard 终局已落（ack entry outcome:'discarded'）——forget 条目不复活
    const acks = host.appendEntry.mock.calls
      .filter(c => c[0] === ACK_CUSTOM_TYPE)
      .map(c => c[1] as { id: string; outcome?: string })
    expect(acks).toEqual([{ v: 2, id: 'task-1:1000', outcome: 'discarded' }])

    // 不留账重投：session_start 差集重放为空（discard 终局不在差集）
    expect(getDeliveryPort()?.recover()).toBe(0)
    // 单次注入尝试（首败即停，无重试）
    expect(host.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('端口拒收（persist-failed）→ throw → runtime failed 记账仍工作，下 tick 重试（新键）照常注入', async () => {
    // 受理前落盘失败：outbox appendEntry 抛错 → deliver 返回 rejected → deliverDispatch throw
    const host = createPortHost({
      appendEntry: vi.fn((customType: string) => {
        if (customType === OUTBOX_CUSTOM_TYPE) throw new Error('disk full')
      }),
    })
    bindDeliveryPort(host)
    const pi = createFakePi()
    const backend = new PiSchedulerBackend(createCtx(), pi.pi)
    const runtime = new SchedulerRuntime(backend)
    const task = await runtime.addTask('retry-me', { mode: 'interval', intervalMs: 60000 })

    // 第一轮：拒收 → failed 记账（lastStatus/pending/history），不 rethrow
    expect(await runtime.dispatchTask(task)).toBe(false)
    expect(task.lastStatus).toBe('failed')
    expect(task.pending).toBe(false)
    expect(task.history[task.history.length - 1]!.status).toBe('failed')
    expect(task.nextRunAt).toBeGreaterThan(0) // 未推进（failed 不 advance）→ 造到期后下 tick 重试

    // 第二轮：恢复落盘（拒收是受理前瞬时故障），到期重派 → 新幂等键注入成功
    host.appendEntry.mockImplementation(() => {})
    task.nextRunAt = 0
    await runtime.tickScheduler()
    expect(task.lastStatus).toBe('success')
    expect(task.runCount).toBe(1)
    expect(host.sendMessage).toHaveBeenCalledTimes(1)
    const [message] = host.sendMessage.mock.calls[0] as [
      { content: string; details: { deliveryId: string } },
      unknown,
    ]
    expect(message.content).toBe('retry-me')
    // 重试轮新键 ≠ 第一轮键（rejected 键未登记、重试合法；nextDispatchEpoch 天然给新键）
    expect(message.details.deliveryId).toMatch(new RegExp(`^${task.id}:\\d+`))
    const outboxIds = host.appendEntry.mock.calls
      .filter(c => c[0] === OUTBOX_CUSTOM_TYPE)
      .map(c => (c[1] as { id: string }).id)
    // 两次 outbox 写：第一轮（落盘抛错仍记录调用）+ 重试轮；两键不同
    expect(outboxIds).toHaveLength(2)
    expect(outboxIds[0]).not.toBe(outboxIds[1])
    expect(outboxIds[1]).toBe(message.details.deliveryId)
  })

  it('port 缺席 → 直发兜底：pi.sendMessage 参数与迁移前逐字一致 + warn 留痕', async () => {
    _resetDeliveryPortForTest() // 确保槽空（装配异常窗口形态）
    const pi = createFakePi()
    const backend = new PiSchedulerBackend(createCtx(), pi.pi)

    await backend.deliverDispatch(DISPATCH_MSG, DISPATCH_OPTS, 'task-1:1000')

    expect(pi.calls).toHaveLength(1)
    expect(pi.calls[0]).toEqual({
      msg: { content: 'check build', customType: 'pi-scheduler:dispatched', display: true },
      opts: { deliverAs: 'steer', triggerTurn: true },
    })
    // 缺席是装配级异常：warn 即修复信号（at-most-once 降级代价登记见 deliverDispatch 注释）
    const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(warnText).toContain('delivery port not bound')
  })
})
