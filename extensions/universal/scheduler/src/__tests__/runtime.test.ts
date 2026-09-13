import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeliveryMessage } from '@xyz-agent/session-delivery'

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}))

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'

// MockSchedulerBackend 零 FS 副作用：runtime 不再触碰 store，无需 mock store.js。

/** 构造 delivery onSettled 回调入参消息（dispatchViaDelivery 挂 dedupeKey=task.id）。 */
function settledMsg(content: string, taskId: string): DeliveryMessage {
  return {
    payload: {
      kind: 'custom',
      customType: 'pi-scheduler:dispatched',
      content,
      display: true,
    },
    intent: 'after-run',
    dedupeKey: taskId,
  }
}

describe('SchedulerRuntime', () => {
  let backend: MockSchedulerBackend
  let runtime: SchedulerRuntime

  beforeEach(() => {
    vi.clearAllMocks()
    backend = new MockSchedulerBackend()
    runtime = new SchedulerRuntime(backend)
  })

  describe('addTask', () => {
    it('creates a new task', async () => {
      const task = await runtime.addTask('check build', { mode: 'interval', intervalMs: 60000 })
      expect(task.id).toHaveLength(8)
      expect(task.prompt).toBe('check build')
      expect(task.enabled).toBe(true)
    })

    it('throws when task limit reached', async () => {
      for (let i = 0; i < 50; i++) {
        await runtime.addTask(`task ${i}`, { mode: 'interval', intervalMs: 60000 })
      }
      await expect(runtime.addTask('one more', { mode: 'interval', intervalMs: 60000 }))
        .rejects.toThrow('Task limit reached')
    })

    it('throws for invalid cron expression at creation', async () => {
      await expect(runtime.addTask('bad cron', { mode: 'cron', cronExpression: 'invalid * *' }))
        .rejects.toThrow('Invalid cron expression: invalid * *')
    })
  })

  describe('listTasks', () => {
    it('returns tasks sorted by nextRunAt', async () => {
      await runtime.addTask('task 1', { mode: 'interval', intervalMs: 60000 })
      await runtime.addTask('task 2', { mode: 'interval', intervalMs: 30000 })
      const tasks = runtime.listTasks()
      expect(tasks).toHaveLength(2)
      // 30s interval 的 nextRunAt 早于 60s 的，应排前
      expect(tasks[0]!.nextRunAt).toBeLessThan(tasks[1]!.nextRunAt)
    })

    // 强化断言：30s 任务 nextRunAt 更小（更早），应是 listTasks()[0]
    it('orders shorter-interval task first', async () => {
      const t60 = await runtime.addTask('60s', { mode: 'interval', intervalMs: 60000 })
      const t30 = await runtime.addTask('30s', { mode: 'interval', intervalMs: 30000 })
      const tasks = runtime.listTasks()
      expect(tasks[0]!.id).toBe(t30.id)
      expect(tasks[0]!.nextRunAt).toBeLessThan(t60.nextRunAt)
    })
  })

  describe('toggleTask', () => {
    it('toggles task enabled state', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(await runtime.toggleTask(task.id, false)).toBe(true)
      expect(runtime.getTask(task.id)?.enabled).toBe(false)
    })

    it('returns false for non-existent task', async () => {
      expect(await runtime.toggleTask('nonexistent', true)).toBe(false)
    })

    it('ERR-2: enable 时 cron 失效 → 停用 + failed + lastError，不落入 ?? now() 死循环', async () => {
      const task = await runtime.addTask('test', { mode: 'cron', cronExpression: '*/10 * * * *' })
      await runtime.toggleTask(task.id, false)
      // 手动破坏 cron 表达式（模拟表达式随环境失效），并让 nextRunAt 过期触发重算
      task.schedule = { mode: 'cron', cronExpression: 'invalid * *' }
      task.nextRunAt = 0

      await runtime.toggleTask(task.id, true)

      expect(task.enabled).toBe(false)
      expect(task.lastStatus).toBe('failed')
      expect(task.lastError).toBe('cron expression invalid')
      // nextRunAt 保留原值（0），enabled=false 后 tick 不再触发
      expect(task.nextRunAt).toBe(0)
    })
  })

  describe('deleteTask', () => {
    it('deletes existing task', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(runtime.deleteTask(task.id)).toBe(true)
      expect(runtime.getTask(task.id)).toBeUndefined()
    })

    it('returns false for non-existent task', () => {
      expect(runtime.deleteTask('nonexistent')).toBe(false)
    })
  })

  describe('dispatchTask', () => {
    // L3/L4（ext-simplify-08）后构造器不再收 ctx（idle/busy 判定已移交 delivery 内核），
    // 直投路径只由 force 触达；无 handle 直投分支已删（装配契约见 index-generation.test.ts）。
    // 原「无 delivery handle 时直投」类用例按设计 L4 裁决改由 force 路径覆盖。

    it('dispatches task via direct send (force)', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      await runtime.dispatchTask(task)
      expect(backend.sentMessages).toHaveLength(1)
      expect(backend.sentMessages[0]!.msg).toEqual(expect.objectContaining({ content: 'test' }))
    })

    it('skips disabled task', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      await runtime.toggleTask(task.id, false)
      await runtime.dispatchTask(task)
      expect(backend.sentMessages).toHaveLength(0)
    })

    it('non-force 任务走 delivery 入队（不直调 sendMessage）', async () => {
      const deliveryBackend = new MockSchedulerBackend()
      const mockDelivery = {
        send: vi.fn(),
        sendChecked: vi.fn(),
        flush: vi.fn(),
        depth: vi.fn(() => 0),
        dispose: vi.fn(),
      } as any
      const deliveryRuntime = new SchedulerRuntime(deliveryBackend, mockDelivery)
      const task = await deliveryRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      await deliveryRuntime.dispatchTask(task)
      expect(mockDelivery.send).toHaveBeenCalledTimes(1)
      expect(deliveryBackend.sentMessages).toHaveLength(0)
    })

    it('dispatches directly when force is true even if busy', async () => {
      const busyBackend = new MockSchedulerBackend()
      const busyRuntime = new SchedulerRuntime(busyBackend)
      const task = await busyRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      await busyRuntime.dispatchTask(task)
      expect(busyBackend.sentMessages).toHaveLength(1)
    })

    // 原「无 delivery handle 时直投不受 idle/pending 影响」用例（L4 裁决改由 force 路径覆盖）：
    // 直投不经 delivery 内核，idle/pending 状态不参与判定——force 任务在 busy/pending 场景同样直投成功
    it('force 任务直投不受 idle/pending 影响', async () => {
      const pendingBackend = new MockSchedulerBackend()
      const pendingRuntime = new SchedulerRuntime(pendingBackend)
      const task = await pendingRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      await pendingRuntime.dispatchTask(task)
      expect(pendingBackend.sentMessages).toHaveLength(1)
    })

    // U4 区分力补强：有 delivery handle 时非 force 任务走 delivery 入队而非直投
    it('有 delivery handle 时非 force 任务走 delivery 入队', async () => {
      const pendingBackend = new MockSchedulerBackend()
      const mockDelivery = {
        send: vi.fn(),
        sendChecked: vi.fn(),
        flush: vi.fn(),
        depth: vi.fn(() => 0),
        dispose: vi.fn(),
      } as any
      const pendingRuntime = new SchedulerRuntime(pendingBackend, mockDelivery)
      const task = await pendingRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      const dispatched = await pendingRuntime.dispatchTask(task)

      expect(dispatched).toBe(true)
      expect(mockDelivery.send).toHaveBeenCalledTimes(1)
      expect(pendingBackend.sentMessages).toHaveLength(0)
      expect(task.pending).toBe(false)
    })

    // U4 区分力补强：busy 时 delivery 入队成功，不触发直投
    it('busy 时 delivery 入队成功，不触发直投', async () => {
      const busyBackend = new MockSchedulerBackend()
      const mockDelivery = {
        send: vi.fn(),
        sendChecked: vi.fn(),
        flush: vi.fn(),
        depth: vi.fn(() => 0),
        dispose: vi.fn(),
      } as any
      const busyRuntime = new SchedulerRuntime(busyBackend, mockDelivery)
      const task = await busyRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      const dispatched = await busyRuntime.dispatchTask(task)

      expect(dispatched).toBe(true)
      expect(mockDelivery.send).toHaveBeenCalledTimes(1)
      expect(busyBackend.sentMessages).toHaveLength(0)
      expect(task.pending).toBe(false)
    })

    it('sendMessage 失败 → 记 failed 状态但不 rethrow', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      // backend.sendMessage 抛错模拟注入失败
      backend.sendMessage = async () => { throw new Error('inject failed') }
      const dispatched = await runtime.dispatchTask(task)
      expect(dispatched).toBe(false)
      expect(task.lastStatus).toBe('failed')
      expect(task.pending).toBe(false)
      expect(task.history[task.history.length - 1]!.status).toBe('failed')
    })

    it('成功 dispatch 后清除 lastError', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      task.lastError = 'cron expression invalid'
      await runtime.dispatchTask(task)
      expect(task.lastError).toBeUndefined()
    })
  })

  // ── R3-S1：dispatchTask in-flight 守卫 ──
  // tick 为 fire-and-forget：tick1 的 await sendMessage 挂起超过 TICK_INTERVAL_MS（如 pi
  // 卡死）时，tick2 的 step2 再标 pending → step3 对同一 task 并发第二个 dispatch → 同一
  // prompt 双注入（force 任务绕过 isIdle gate 直接受影响）。守卫：同任务在途（Set<taskId>）
  // 时 skip 本轮并 warn；不同任务不受影响。
  describe('dispatchTask in-flight 守卫（R3-S1）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('sendMessage 挂起期间下一 tick 同任务被跳过：不双注入、warn in-flight、完成后 runCount=1', async () => {
      loggerMock.warn.mockClear()
      let resolveSend: (() => void) | undefined
      const sendPromise = new Promise<void>(resolve => { resolveSend = resolve })
      backend.sendMessage = vi.fn(() => sendPromise)

      const task = await runtime.addTask('in-flight', { mode: 'interval', intervalMs: 60000 }, { force: true })
      task.nextRunAt = Date.now() - 1000

      // tick1：dispatch 进入 sendMessage 挂起（同步段已置 in-flight 标记）
      const tick1 = runtime.tickScheduler()
      expect(backend.sendMessage).toHaveBeenCalledTimes(1)
      expect(task.pending).toBe(true) // dispatch 未完成，pending 未清

      // tick2（模拟 30s 后 pi 仍卡死）：同任务再标 pending → step3 dispatchTask 命中
      // in-flight 守卫 → skip + warn（修复前：同一 prompt 双注入）
      await runtime.tickScheduler()
      expect(backend.sendMessage).toHaveBeenCalledTimes(1)
      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('already in flight')

      // 放行挂起的 sendMessage：tick1 正常收尾（状态推进恰好一次）
      resolveSend!()
      await tick1
      expect(backend.sendMessage).toHaveBeenCalledTimes(1)
      expect(task.runCount).toBe(1)
      expect(task.pending).toBe(false)
    })

    it('挂起 dispatch 只挡同任务：其他任务在下一 tick 正常 dispatch 不受影响', async () => {
      let resolveSend: (() => void) | undefined
      const sendPromise = new Promise<void>(resolve => { resolveSend = resolve })
      backend.sendMessage = vi.fn(() => sendPromise)

      const task1 = await runtime.addTask('first', { mode: 'interval', intervalMs: 60000 }, { force: true })
      const task2 = await runtime.addTask('second', { mode: 'interval', intervalMs: 60000 }, { force: true })
      task1.nextRunAt = Date.now() - 1000
      task2.nextRunAt = Date.now() - 1000

      // tick1：task1 dispatch 挂起（step3 顺序 await，task2 尚未轮到）
      const tick1 = runtime.tickScheduler()
      expect(backend.sendMessage).toHaveBeenCalledTimes(1)

      // tick2：task1 命中守卫跳过，task2 无在途 → 正常 dispatch（守卫按 taskId 粒度隔离）。
      // 注：tick2 挂起在 task1 的 await dispatchTask（守卫命中即 resolved promise）与 task2
      // 的 await sendMessage 上，先放行再 await，完成态统一断言
      const tick2 = runtime.tickScheduler()
      resolveSend!()
      await Promise.all([tick1, tick2])
      expect(backend.sendMessage).toHaveBeenCalledTimes(2)
      expect(task1.runCount).toBe(1)
      expect(task2.runCount).toBe(1)
    })
  })

  // ── M10b：rate-limit ──
  // dispatchTask 受 RATE_LIMIT_PER_MINUTE=6 限制。前 6 次成功（sendMessage 被调），
  // 第 7 次被 hasDispatchCapacity 拒绝（dispatchTimestamps.length 已达 6）。
  describe('rate-limit', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('rate-limits dispatch to 6 per minute', async () => {
      // force=true 保证不被 idle/busy 干扰，直接命中 rate-limit
      const tasks: Awaited<ReturnType<typeof runtime.addTask>>[] = []
      for (let i = 0; i < 7; i++) {
        tasks.push(await runtime.addTask(`task ${i}`, { mode: 'interval', intervalMs: 60000 }, { force: true }))
      }

      // 7 次 dispatch 全在同一分钟内（fake time 不前进）
      for (const task of tasks) {
        await runtime.dispatchTask(task)
      }

      // 前 6 次成功，第 7 次被限流：sendMessage 只被调 6 次
      expect(backend.sentMessages).toHaveLength(6)
    })

    it('allows dispatch again after 1 minute window slides', async () => {
      const task = await runtime.addTask('t', { mode: 'interval', intervalMs: 60000 }, { force: true })
      // 先消耗完 6 次配额
      for (let i = 0; i < 6; i++) {
        // 同一 task 反复 dispatch（interval 模式每次重算 nextRunAt，不影响 rate-limit 计数）
        await runtime.dispatchTask(task)
      }
      expect(backend.sentMessages).toHaveLength(6)

      // 时间前进 61 秒：旧 timestamp 滑出窗口，配额恢复
      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
      const dispatched = await runtime.dispatchTask(task)
      expect(dispatched).toBe(true)
      expect(backend.sentMessages).toHaveLength(7)
    })
  })

  // ── M10d：tickScheduler ──
  describe('tickScheduler', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('dispatches due interval tasks and advances nextRunAt', async () => {
      const task = await runtime.addTask('tick me', { mode: 'interval', intervalMs: 60000 }, { force: true })
      // 手动让任务过期（nextRunAt 设为过去）
      task.nextRunAt = Date.now() - 1000

      await runtime.tickScheduler()

      // 已 dispatch
      expect(backend.sentMessages).toHaveLength(1)
      const updated = runtime.getTask(task.id)
      expect(updated).toBeDefined()
      expect(updated!.runCount).toBe(1)
      // nextRunAt 推进到 now + intervalMs（60000ms）
      expect(updated!.nextRunAt).toBe(Date.now() + 60000)
    })

    it('removes expired tasks (expiresAt in the past)', async () => {
      const task = await runtime.addTask('expire me', { mode: 'interval', intervalMs: 60000 })
      // expiresAt 已过：tick 的第 1 步清理会删除
      task.expiresAt = Date.now() - 1000

      await runtime.tickScheduler()

      expect(runtime.getTask(task.id)).toBeUndefined()
      // 过期清理先于 dispatch，不应 dispatch
      expect(backend.sentMessages).toHaveLength(0)
    })

    it('deletes once task after dispatch', async () => {
      const task = await runtime.addTask('one-shot', { mode: 'interval', intervalMs: 60000 }, { kind: 'once', force: true })
      task.nextRunAt = Date.now() - 1000

      await runtime.tickScheduler()

      // once 任务 dispatch 后自删
      expect(runtime.getTask(task.id)).toBeUndefined()
      expect(backend.sentMessages).toHaveLength(1)
    })

    // ── TC1：cron 失效任务不死循环 ──
    // tick1 dispatch 成功、重算 nextRunAt 失败停用；tick2/3 因 enabled=false 不再 dispatch。
    // 旧实现 `?? Date.now()` 会把 nextRunAt 设为 now → 每 tick 立即重触发 → 死循环。
    it('TC1: cron 失效任务不死循环（sendMessage 只触发 1 次）', async () => {
      const task = await runtime.addTask('tick me', { mode: 'cron', cronExpression: '*/10 * * * *' }, { force: true })
      // 手动把 cron 表达式改为无效（模拟表达式随环境失效），并使任务到期
      task.schedule = { mode: 'cron', cronExpression: 'invalid * *' }
      task.nextRunAt = Date.now() - 1000

      // 连跑 3 次 tick
      await runtime.tickScheduler()
      await runtime.tickScheduler()
      await runtime.tickScheduler()

      expect(backend.sentMessages).toHaveLength(1)
      const updated = runtime.getTask(task.id)
      expect(updated).toBeDefined()
      expect(updated!.enabled).toBe(false)
      expect(updated!.lastStatus).toBe('failed')
      expect(updated!.lastError).toBe('cron expression invalid')
    })

    // ── TC-W-APPEND-FAIL：appendEntry 失败捕获（ER-APPEND-FAIL）──
    it('TC-W-APPEND-FAIL: appendEntry 失败不抛、保留内存态、不污染 lastError', async () => {
      loggerMock.warn.mockClear()
      backend.appendError = new Error('pi internal')

      // addTask 内 appendEntry 抛错 → 被捕获（console.warn），不 rethrow；内存态已更新（task 仍在）
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      expect(runtime.getTask(task.id)).toBeDefined()
      expect(task.enabled).toBe(true)
      // appendEntrySafe 不污染业务态（append 失败是 transient，不设 lastError）
      expect(task.lastError).toBeUndefined()
      expect(loggerMock.warn).toHaveBeenCalled()

      // tickScheduler 同样不抛：dispatch 成功后 append advance 抛错被捕获，nextRunAt 已推进（内存态正确）
      task.nextRunAt = Date.now() - 1000
      await expect(runtime.tickScheduler()).resolves.toBeUndefined()
      const updated = runtime.getTask(task.id)!
      expect(updated.enabled).toBe(true)
      expect(updated.runCount).toBe(1)
      // nextRunAt 已推进到未来（内存态正确，append 失败只丢持久化）
      expect(updated.nextRunAt).toBe(Date.now() + 60000)
      expect(updated.lastError).toBeUndefined() // 不被 append 失败污染
    })

    // ── TC-W-ON-AFTER-TICK：onAfterTick 回调（W2）──
    it('TC-W-ON-AFTER-TICK: onAfterTick 回调在 tick 完成后被调用 1 次', async () => {
      const spy = vi.fn()
      runtime.onAfterTick(spy)
      await runtime.tickScheduler()
      expect(spy).toHaveBeenCalledTimes(1)
    })

    // ── TC-W-ENABLED-FILTER：tickScheduler 步骤3 显式 enabled 过滤（W4）──
    it('TC-W-ENABLED-FILTER: disabled 且到期的任务不被 dispatch，enabled 到期则 dispatch', async () => {
      // disabled + 到期
      const disabled = await runtime.addTask('disabled', { mode: 'interval', intervalMs: 60000 })
      await runtime.toggleTask(disabled.id, false)
      disabled.nextRunAt = Date.now() - 1000

      // enabled + 到期（force=true 绕过 idle/busy 检查，隔离 enabled 维度）
      const enabledTask = await runtime.addTask('enabled', { mode: 'interval', intervalMs: 60000 }, { force: true })
      enabledTask.nextRunAt = Date.now() - 1000

      await runtime.tickScheduler()

      // 只 dispatch enabled（disabled 被步骤2 不标 pending + 步骤3 +t.enabled 双重过滤）
      expect(backend.sentMessages).toHaveLength(1)
      expect(backend.sentMessages[0]!.msg.content).toBe('enabled')
      // disabled 仍在、未被 dispatch、enabled=false
      const stillDisabled = runtime.getTask(disabled.id)
      expect(stillDisabled).toBeDefined()
      expect(stillDisabled!.enabled).toBe(false)
      expect(stillDisabled!.runCount).toBe(0)
    })

    // ── MF-1：toggle enable 重算 nextRunAt 到未来时清除残留 pending ──
    // U4 变更：gate 已交 delivery 内核。pending 在 dispatchViaDelivery/dispatchDirect
    // 成功后清除（不再依赖 gate 跳过保留 pending）；L3 后构造器不收 ctx、L4 后直投仅 force 触达。
    it('MF-1: enable 重算 nextRunAt 到未来时清除残留 pending，不提前 dispatch', async () => {
      const controllableBackend = new MockSchedulerBackend()
      const rt = new SchedulerRuntime(controllableBackend)

      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const task = await rt.addTask('mf1', { mode: 'interval', intervalMs: 60000 }, { force: true })

      // T0+61s：任务到期 → dispatchDirect（force 直投）
      // 直投成功后 pending=false
      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
      await rt.tickScheduler()
      expect(task.pending).toBe(false) // 直投成功后 pending 已清除
      expect(controllableBackend.sentMessages).toHaveLength(1) // 直投成功

      // 重算 nextRunAt 到未来（recurring 任务 dispatch 后 nextRunAt 已推进）
      const recalcedNext = task.nextRunAt
      expect(recalcedNext).toBeGreaterThan(Date.now()) // 已推进到未来

      // T0+90s：在重算的未来 nextRunAt 之前 tick → 不应 dispatch
      vi.setSystemTime(new Date('2026-01-01T00:01:30Z'))
      await rt.tickScheduler()
      expect(controllableBackend.sentMessages).toHaveLength(1) // 仍是 1 次

      // 到达重算的未来 nextRunAt 后 tick：才 dispatch
      vi.setSystemTime(new Date(recalcedNext + 1000))
      await rt.tickScheduler()
      expect(controllableBackend.sentMessages).toHaveLength(2)
    })

    // ── P1：toggle enable 重算的 nextRunAt 跨 session 重放后保持未来值 ──
    // 场景：addTask → nextRunAt 过期 → disable → enable 重算到未来（内存）→
    //   新建第二个 SchedulerRuntime + backend.loadTasks() 重放 appendedOps（模拟 resume）→
    //   重放后 nextRunAt = 重算的未来值（非 upsert 快照旧过期值）+ enabled=true + tick 不立即 dispatch。
    // 修复前：toggle op 不带 nextRunAt，重放回退到 upsert 快照旧过期值 → 首个 tick 立即 dispatch（跨 session 数据丢失）。
    it('P1: toggle enable 重算的 nextRunAt 跨 session 重放后保持未来值，不回退到旧过期值', async () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const task = await runtime.addTask('cross-session', { mode: 'interval', intervalMs: 60000 })
      const oldNextRunAt = task.nextRunAt // T0+60s（upsert 快照值）

      // T0+120s：nextRunAt(T0+60s) 已过期
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
      expect(task.nextRunAt).toBeLessThan(Date.now())

      // disable → enable：enable 重算 nextRunAt 到未来（T0+120s + 60s = T0+180s）
      await runtime.toggleTask(task.id, false)
      await runtime.toggleTask(task.id, true)
      const recalcedNext = task.nextRunAt
      expect(recalcedNext).toBeGreaterThan(Date.now()) // 内存态已重算到未来
      expect(recalcedNext).not.toBe(oldNextRunAt) // 确实重算，非旧值

      // 模拟 resume：把第一个 runtime 的 appendedOps 包装成 entries，喂给第二个 backend 重放。
      // appendedOps = [upsert(T0+60s), toggle(enabled=false), toggle(enabled=true, nextRunAt=T0+180s)]
      const replayBackend = new MockSchedulerBackend()
      replayBackend.fakeEntries = backend.appendedOps.map(op => ({
        type: 'custom',
        customType: 'pi-scheduler:task',
        data: op,
      }))
      // fakeSessionFile 默认 '/test/session.json'，与第一个 backend 一致 → owner 过滤放行
      const replayRuntime = new SchedulerRuntime(replayBackend)
      replayRuntime.loadTasks(replayBackend.loadTasks())

      const replayed = replayRuntime.getTask(task.id)
      expect(replayed).toBeDefined()
      expect(replayed!.enabled).toBe(true)
      // 重放后是重算的未来值（修复核心），非 upsert 快照的旧过期值
      expect(replayed!.nextRunAt).toBe(recalcedNext)
      expect(replayed!.nextRunAt).not.toBe(oldNextRunAt)

      // 再 tick 一次（now=T0+120s < 重算 nextRunAt T0+180s）：不应 dispatch。
      // 修复前此断言会失败：nextRunAt 回退到 oldNextRunAt(T0+60s) < now → 首个 tick 立即触发
      await replayRuntime.tickScheduler()
      expect(replayBackend.sentMessages).toHaveLength(0)
    })
  })

  // ── TC9：expiresAt 三态（addTask 的 expires 分支）──
  // 源码逻辑：expires==='never' → undefined；kind==='recurring' 且 expires →
  // now + parseDuration(expires)（解析失败 ?? 默认 7d）；recurring 无 expires →
  // 默认 7d；kind==='once' 不进分支 → undefined。
  // MockSchedulerBackend nowValue 固定为 1_000_000，expiresAt 精确可控。
  describe('expiresAt', () => {
    beforeEach(() => {
      backend.nowValue = 1_000_000
    })

    it("expires: 'never' → expiresAt undefined", async () => {
      const task = await runtime.addTask(
        'test',
        { mode: 'interval', intervalMs: 60000 },
        { expires: 'never' },
      )
      expect(task.expiresAt).toBeUndefined()
    })

    it('recurring + expires 30m → now + 1_800_000', async () => {
      const task = await runtime.addTask(
        'test',
        { mode: 'interval', intervalMs: 60000 },
        { expires: '30m' },
      )
      expect(task.expiresAt).toBe(2_800_000)
    })

    it('recurring + 无 expires → 默认 7d（now + 604_800_000）', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(task.expiresAt).toBe(605_800_000)
    })

    it("kind once + expires '30m' → expiresAt undefined（once 不设过期）", async () => {
      const task = await runtime.addTask(
        'test',
        { mode: 'interval', intervalMs: 60000 },
        { kind: 'once', expires: '30m' },
      )
      expect(task.expiresAt).toBeUndefined()
    })
  })

  // ── U4：delivery 内核集成 ──
  // scheduler 的非 force 任务走 delivery 内核（park 模式）。
  // force 任务走 dispatchDirect（直投）；无 handle 直投分支已删（L4，装配恒注入 delivery）。
  describe('U4: delivery 内核集成', () => {
    it('有 delivery handle 时非 force 任务走 delivery 入队（不直调 sendMessage）', async () => {
      // 模拟 delivery handle（L2 后经构造器直传）
      const sentViaDelivery: Array<{ content: string; intent: string }> = []
      const mockDelivery = {
        send: vi.fn((msg: { payload: { content: string }; intent?: string }) => {
          sentViaDelivery.push({
            content: msg.payload.content,
            intent: msg.intent ?? 'after-run',
          })
        }),
        sendChecked: vi.fn(),
        flush: vi.fn(),
        depth: vi.fn(() => 0),
        dispose: vi.fn(),
      }
      const deliveryRuntime = new SchedulerRuntime(backend, mockDelivery as any)

      const task = await deliveryRuntime.addTask('delivery-test', { mode: 'interval', intervalMs: 60000 })
      await deliveryRuntime.dispatchTask(task)

      // 非 force 任务走 delivery 入队
      expect(mockDelivery.send).toHaveBeenCalledTimes(1)
      expect(sentViaDelivery[0]!.content).toBe('delivery-test')
      expect(sentViaDelivery[0]!.intent).toBe('after-run')
      // 不直调 sendMessage
      expect(backend.sentMessages).toHaveLength(0)
      // pending 已清除（入队后移交内核管理）
      expect(task.pending).toBe(false)
    })

    it('force 任务绕过 delivery 直投', async () => {
      const mockDelivery = {
        send: vi.fn(),
        sendChecked: vi.fn(),
        flush: vi.fn(),
        depth: vi.fn(() => 0),
        dispose: vi.fn(),
      }
      const deliveryRuntime = new SchedulerRuntime(backend, mockDelivery as any)

      const task = await deliveryRuntime.addTask('force-test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      await deliveryRuntime.dispatchTask(task)

      // force 任务直投（不走 delivery）
      expect(mockDelivery.send).not.toHaveBeenCalled()
      expect(backend.sentMessages).toHaveLength(1)
      expect(backend.sentMessages[0]!.msg.content).toBe('force-test')
    })

    it('tick 末尾调 delivery.flush()', async () => {
      const mockDelivery = {
        send: vi.fn(),
        sendChecked: vi.fn(),
        flush: vi.fn(),
        depth: vi.fn(() => 0),
        dispose: vi.fn(),
      }
      const deliveryRuntime = new SchedulerRuntime(backend, mockDelivery as any)

      await deliveryRuntime.tickScheduler()

      // tick 完成后调 flush
      expect(mockDelivery.flush).toHaveBeenCalledTimes(1)
    })

    it('handleSettled delivered（dedupeKey=task.id 反查）→ 成功记账', async () => {
      const task = await runtime.addTask('settle-test', { mode: 'interval', intervalMs: 60000 })

      // 模拟 delivery onSettled 回调（dispatchViaDelivery 挂 dedupeKey=task.id）
      runtime.handleSettled(settledMsg('settle-test', task.id), 'delivered')

      // onDispatchSuccess 是异步的，等待完成
      await vi.waitFor(() => {
        expect(task.runCount).toBe(1)
        expect(task.lastStatus).toBe('success')
      })
      expect(task.lastError).toBeUndefined()
    })

    it('handleSettled rejected → 失败记账（once 不删持久化）', async () => {
      const task = await runtime.addTask('settle-fail', { mode: 'interval', intervalMs: 60000 }, { kind: 'once' })

      // 模拟 delivery onSettled 回调
      runtime.handleSettled(settledMsg('settle-fail', task.id), 'rejected')

      // 失败记账
      expect(task.lastStatus).toBe('failed')
      expect(task.history[task.history.length - 1]!.status).toBe('failed')
      // once 任务失败不删持久化（任务仍在）
      expect(runtime.getTask(task.id)).toBeDefined()
    })

    it('#11 同 prompt 两任务：各自 onSettled 按 dedupeKey 精确记账（不互相错配）', async () => {
      const taskA = await runtime.addTask('same-prompt', { mode: 'interval', intervalMs: 60000 })
      const taskB = await runtime.addTask('same-prompt', { mode: 'interval', intervalMs: 60000 })
      expect(taskA.id).not.toBe(taskB.id)

      // A 的投递终态：只记 A 的账（旧 content 反查 find 取首个命中，B 先入 Map 时错记 B）
      runtime.handleSettled(settledMsg('same-prompt', taskA.id), 'delivered')

      await vi.waitFor(() => {
        expect(taskA.runCount).toBe(1)
      })
      expect(taskA.lastStatus).toBe('success')
      expect(taskB.runCount).toBe(0)
      expect(taskB.lastStatus).toBeUndefined()

      // B 的投递终态：记 B 的账
      runtime.handleSettled(settledMsg('same-prompt', taskB.id), 'delivered')

      await vi.waitFor(() => {
        expect(taskB.runCount).toBe(1)
      })
      expect(taskB.lastStatus).toBe('success')
    })

    it('#11 任务先删后 delivered → 不炸不误记其他任务', async () => {
      const taskA = await runtime.addTask('deleted-task', { mode: 'interval', intervalMs: 60000 })
      const taskB = await runtime.addTask('other-task', { mode: 'interval', intervalMs: 60000 })

      // once 成功 / 手动删除后 delivered 迟到：dedupeKey 反查未命中 → no-op
      runtime.deleteTask(taskA.id)
      expect(() => {
        runtime.handleSettled(settledMsg('deleted-task', taskA.id), 'delivered')
      }).not.toThrow()

      // 不误记其他任务的账
      expect(taskB.runCount).toBe(0)
      expect(taskB.lastStatus).toBeUndefined()
    })
  })

  // ── F2：tick 错误分诊（crash-fix）──
  // startScheduler 的 interval 回调对 fire-and-forget 的 tickScheduler() 加 catch：
  // stale 类错误（session 替换后泄漏 timer 访问 stale ctx）→ warn "tick stopped" + stopScheduler
  // 自停；其他错误 → warn "tick error" 继续调度。修复前 tick 内异常无人接住 →
  // unhandledRejection → pi 主进程 exit 1。
  describe('tick 错误分诊（F2）', () => {
    const TICK_INTERVAL_MS = 30_000

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    afterEach(() => {
      runtime.stopScheduler()
      vi.useRealTimers()
    })

    it('U1: stale 错误 → warn "tick stopped" + timer 自停，后续 tick 不再发生', async () => {
      loggerMock.warn.mockClear()
      const nowSpy = vi.spyOn(backend, 'now')
      runtime.onAfterTick(() => {
        throw new Error('This extension ctx is stale after session replacement or reload.')
      })

      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick1：stale 抛 → catch 分诊 → 自停

      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('tick stopped')
      expect(warnText).not.toContain('tick error')

      const countAfterSelfStop = nowSpy.mock.calls.length
      expect(countAfterSelfStop).toBeGreaterThan(0) // tick1 确实跑过（排除「timer 未启动」假绿）

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2) // 60s：timer 已停，无新 tick
      expect(nowSpy.mock.calls.length).toBe(countAfterSelfStop) // now 计数不再增长
      nowSpy.mockRestore()
    })

    it('U2: 非 stale 错误 → warn "tick error" 且调度继续（advance 两次 now 计数 +2）', async () => {
      loggerMock.warn.mockClear()
      const nowSpy = vi.spyOn(backend, 'now')
      runtime.onAfterTick(() => {
        throw new Error('boom')
      })

      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick1：warn 但不停

      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('tick error')
      expect(warnText).not.toContain('tick stopped')

      const countAfterFirstTick = nowSpy.mock.calls.length
      expect(countAfterFirstTick).toBeGreaterThan(0)

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2) // 2 个后续 tick 照常
      expect(nowSpy.mock.calls.length).toBe(countAfterFirstTick + 2)
      nowSpy.mockRestore()
    })

    it('U5: stopScheduler 幂等——连续调用两次不抛、无副作用', () => {
      runtime.startScheduler()
      expect(() => {
        runtime.stopScheduler()
        runtime.stopScheduler()
      }).not.toThrow()
    })
  })

  // ── G1：代际检测分诊（S9 review 修复 / R3-M1 模块级化）──
  // isCtxStale（index.ts 注入的模块级代数比对）为主判，替代对 pi 错误文案的依赖：
  // - G1-a：in-flight tick 内代际翻转 + 任意非文案错误 → catch 分诊走 stale 自停（不依赖文案）
  // - G1-b：代际翻转后（无任何错误）泄漏 timer 在下个 tick 前置检查自停，不进入 tick
  // - G1-c：显式注入 isCtxStale=false + 非 stale 错误 → 仍 "tick error" 继续调度（不误伤）
  // - G1-d：isCtxStale=false 但错误文案含 stale 片段 → 文案兜底仍自停（覆盖 reload 盲区：
  //   clearExtensionCache 后 jiti 重 import 全新模块环境，旧闭包的模块级代数冻结不再递增，
  //   只剩文案能识别 stale；模块级方案的装配级验证见 index-generation.test.ts factory 重跑用例）
  describe('G1: 代际检测分诊（S9）', () => {
    const TICK_INTERVAL_MS = 30_000
    let staleFlag: boolean
    let genRuntime: SchedulerRuntime

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      staleFlag = false
      genRuntime = new SchedulerRuntime(backend, undefined, () => staleFlag)
    })

    afterEach(() => {
      genRuntime.stopScheduler()
      vi.useRealTimers()
    })

    it('G1-a: in-flight tick 期间代际翻转 + 非文案错误 → warn "tick stopped" + 自停（不依赖 pi 错误文案）', async () => {
      loggerMock.warn.mockClear()
      const nowSpy = vi.spyOn(backend, 'now')
      // tick 内先翻世代（模拟 session 替换交错发生在 dispatch await 窗口），再抛与
      // pi 文案完全无关的错误——旧实现按文案分诊会误判为普通错误继续调度（若 pi 改文案）
      genRuntime.onAfterTick(() => {
        staleFlag = true
        throw new Error('some unexpected failure')
      })

      genRuntime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick1：catch 分诊走 G1 代际 → 自停

      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('tick stopped')
      expect(warnText).not.toContain('tick error')

      const countAfterSelfStop = nowSpy.mock.calls.length
      expect(countAfterSelfStop).toBeGreaterThan(0) // tick1 确实跑过（排除「timer 未启动」假绿）

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2) // timer 已停，无新 tick
      expect(nowSpy.mock.calls.length).toBe(countAfterSelfStop)
      nowSpy.mockRestore()
    })

    it('G1-b: 代际翻转后泄漏 timer 在下个 tick 前置检查自停——不进入 tick（backend.now 零调用）', async () => {
      loggerMock.warn.mockClear()
      const nowSpy = vi.spyOn(backend, 'now')
      genRuntime.startScheduler()
      // session 替换：代际翻转（F1 未能触达的泄漏 timer 场景；无任何错误发生）
      staleFlag = true

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick1：前置检查命中 → 自停

      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('tick stopped')
      expect(warnText).not.toContain('tick error')
      // 前置检查在 tickScheduler 之前拦截：tick 本体未执行（now 零调用，无 dispatch/append）
      expect(nowSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2) // timer 已停，仍零调用
      expect(nowSpy).not.toHaveBeenCalled()
      nowSpy.mockRestore()
    })

    it('G1-c: isCtxStale 注入但返回 false + 非 stale 错误 → warn "tick error" 且调度继续', async () => {
      loggerMock.warn.mockClear()
      const nowSpy = vi.spyOn(backend, 'now')
      // staleFlag 恒 false（beforeEach 初始化）：代际未翻转，注入存在不改变分诊结果
      genRuntime.onAfterTick(() => {
        throw new Error('boom')
      })

      genRuntime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick1：非 stale → warn 继续调度

      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('tick error')
      expect(warnText).not.toContain('tick stopped')

      const countAfterFirstTick = nowSpy.mock.calls.length
      expect(countAfterFirstTick).toBeGreaterThan(0)

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2) // 2 个后续 tick 照常
      expect(nowSpy.mock.calls.length).toBe(countAfterFirstTick + 2)
      nowSpy.mockRestore()
    })

    it('G1-d: isCtxStale 返回 false 但错误文案含 stale 片段 → 文案兜底仍自停（覆盖 reload 盲区）', async () => {
      loggerMock.warn.mockClear()
      const nowSpy = vi.spyOn(backend, 'now')
      // reload 场景模拟：factory 重跑后旧闭包代际计数不再递增（staleFlag 恒 false），
      // 只有错误文案能识别 stale——兜底支必须独立于代际检测生效
      genRuntime.onAfterTick(() => {
        throw new Error('This extension ctx is stale after session replacement or reload.')
      })

      genRuntime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick1：文案兜底 → 自停

      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('tick stopped')
      expect(warnText).not.toContain('tick error')

      const countAfterSelfStop = nowSpy.mock.calls.length
      expect(countAfterSelfStop).toBeGreaterThan(0)

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2)
      expect(nowSpy.mock.calls.length).toBe(countAfterSelfStop)
      nowSpy.mockRestore()
    })
  })
})
