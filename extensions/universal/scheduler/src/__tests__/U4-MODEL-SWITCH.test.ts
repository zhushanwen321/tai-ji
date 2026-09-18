/**
 * U4_MODEL_SWITCH：dispatch 模型切换（设计 D3 修订版）验收
 *
 * 覆盖设计 §3.3 D3 的五块机制（探针 P-MODEL 修订后语义）：
 * - 切换：dispatchTaskInner 在 sendMessage 前 setModel（busy 亦生效——本层不做 idle 检查）
 * - 归属与恢复：message_start customType 前缀匹配 + run 窗口内 turnIndex 序态关联；
 *   turn_end(dispatchedTurnIndex) + isIdle 复核推迟；agent_end/agent_settled 封口 run 窗口
 * - 互斥：切换在途时其他需切模型任务 skip + pending 留待下 tick 重试
 * - 对账兜底：严格先于同 tick dispatch 循环；在途标记 2 tick 过期强制开放；未决记录守卫
 *   （无记录时模型漂移 = 用户自主行为不动作）
 * - 降级与接管副作用：setModel false 不阻塞 dispatch；sendMessage 抛错 catch 先恢复；
 *   模型语义异常只走日志（不进持久化词表）
 *
 * 事件注入：直接调用 runtime 的 handle* 事件入口（index.ts 的 pi.on 只做转发）。
 * tick：fake timers 驱动真实 interval（对齐 runtime.test.ts F2 形态）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 共享 logger，让 logger.warn 可被 spy（对齐 runtime.test.ts 形态）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}))

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime, type SchedulerModelOps } from '../runtime.js'
import type { ScheduledTask } from '../types.js'

const TICK_INTERVAL_MS = 30_000
const ORIG = 'prov-a/model-1'
const TASK_M = 'prov-b/model-2'
const OTHER_M = 'prov-c/model-3'

/** 模型控制面 mock：setModelCalls 记录调用序（切换/恢复时序断言的核心观测点） */
class ModelOpsMock implements SchedulerModelOps {
  currentRef: string | undefined = ORIG
  idle = true
  setModelResult = true
  setModelCalls: string[] = []

  getCurrentModelRef(): string | undefined {
    return this.currentRef
  }

  async setModelByRef(ref: string): Promise<boolean> {
    this.setModelCalls.push(ref)
    if (this.setModelResult) this.currentRef = ref
    return this.setModelResult
  }

  isIdle(): boolean {
    return this.idle
  }
}

/** 纯 microtask 冲刷：handleTurnEnd 的恢复是 fire-and-forget async，断言前等待其 await 链完成 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** dispatch 注入的 custom message 形状（P-MODEL-④ 实测 payload） */
function dispatchCustomMessage(): Record<string, unknown> {
  return { role: 'custom', customType: 'pi-scheduler:dispatched', content: 'job', display: true, timestamp: 0 }
}

describe('U4_MODEL_SWITCH: dispatch 模型切换', () => {
  let backend: MockSchedulerBackend
  let ops: ModelOpsMock
  let runtime: SchedulerRuntime
  let task: ScheduledTask

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    backend = new MockSchedulerBackend()
    ops = new ModelOpsMock()
    runtime = new SchedulerRuntime(backend, undefined, ops)
  })

  afterEach(() => {
    runtime.stopScheduler()
    vi.useRealTimers()
  })

  async function addModelTask(prompt: string, model: string): Promise<ScheduledTask> {
    // interval 10 分钟：测试窗口（≤5 tick = 150s）内任务不会自身重到期（onDispatchSuccess 推进
    // nextRunAt），避免现状调度语义（到期重发）污染切换/互斥场景
    return runtime.addTask(prompt, { mode: 'interval', intervalMs: 600_000 }, { model })
  }

  /** 事件序注入（P-MODEL-④ 实测序态）：agent_start → turn_start(n) → message_start(custom) → turn_end(n) */
  function injectDispatchTurn(turnIndex: number): void {
    runtime.handleAgentStart()
    runtime.handleTurnStart(turnIndex)
    runtime.handleMessageStart(dispatchCustomMessage())
    runtime.handleTurnEnd(turnIndex)
  }

  describe('切换与归属恢复', () => {
    it('task.model ≠ 当前 → setModel(目标) + 归属 turn 结束后恢复(原)', async () => {
      task = await addModelTask('job', TASK_M)
      const ok = await runtime.dispatchTask(task)
      expect(ok).toBe(true)
      expect(ops.setModelCalls).toEqual([TASK_M])

      injectDispatchTurn(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])

      // 记录已清：重复 turn_end 不二次恢复
      runtime.handleTurnEnd(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
    })

    it('task.model = 当前 → 不切换不写记录', async () => {
      task = await addModelTask('job', ORIG)
      const ok = await runtime.dispatchTask(task)
      expect(ok).toBe(true)
      expect(ops.setModelCalls).toEqual([])

      injectDispatchTurn(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([])
    })

    it('turn_end 非 idle → 推迟（无立即恢复），tick 重入 idle 即兑现', async () => {
      task = await addModelTask('job', TASK_M)
      await runtime.dispatchTask(task)

      // 用户长 run 在途（非 idle）：turn_end 只推迟
      ops.idle = false
      injectDispatchTurn(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M])

      // run 沉降后 tick 重入：恢复兑现
      ops.idle = true
      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
    })

    it('非匹配事件不触发恢复：非 custom / 非前缀 / turnIndex 不匹配 / run 窗口封口', async () => {
      task = await addModelTask('job', TASK_M)
      await runtime.dispatchTask(task)

      // a) 非 custom message（assistant 形状）不归属
      runtime.handleAgentStart()
      runtime.handleTurnStart(0)
      runtime.handleMessageStart({ role: 'assistant', provider: 'p', model: 'm', content: [], timestamp: 0 })
      runtime.handleTurnEnd(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M])

      // b) customType 非 pi-scheduler: 前缀不归属
      runtime.handleMessageStart({ role: 'custom', customType: 'other-ext:thing', content: '', display: true, timestamp: 0 })
      runtime.handleTurnEnd(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M])

      // c) 前缀命中但 turnIndex 不匹配（归属 0，结束 1）
      runtime.handleMessageStart(dispatchCustomMessage())
      runtime.handleTurnEnd(1)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M])

      // d) run 窗口封口（agent_end/agent_settled）后陈旧索引失效
      runtime.handleRunClosed()
      runtime.handleTurnEnd(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M])

      // sanity：封口后新 run 的正常归属仍可恢复（封口只清陈旧索引，不杀记录）
      injectDispatchTurn(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
    })

    it('恢复 setModel(原) false → restore-failed 终态：warn 日志 + 清标记 + 对账不再动作', async () => {
      task = await addModelTask('job', TASK_M)
      await runtime.dispatchTask(task)
      expect(ops.setModelCalls).toEqual([TASK_M])

      // 模拟恢复期 setModel 失败（无可用 key 等）
      ops.setModelResult = false
      injectDispatchTurn(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('restore-failed')

      // 标记已清：后续对账窗口不重复动作
      ops.setModelResult = true
      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 3)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
    })

    it('恢复前用户已手动切回（当前 == 期望）→ 清记录不动作', async () => {
      task = await addModelTask('job', TASK_M)
      await runtime.dispatchTask(task)
      ops.currentRef = ORIG // 用户手动切回

      injectDispatchTurn(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M]) // 无恢复调用
    })
  })

  describe('互斥窗口', () => {
    it('切换在途时第二个需切模型任务 skip + pending 保留 + A 结算后重试成功', async () => {
      const taskA = await addModelTask('job-a', TASK_M)
      await runtime.dispatchTask(taskA)

      // B 到期走 tick 路径：step2 标 pending → step3 dispatch 命中互斥 skip
      const taskB = await addModelTask('job-b', OTHER_M)
      taskB.nextRunAt = 0
      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)

      expect(taskB.pending).toBe(true) // skip 不清 pending（留待下 tick 重试，复用现状语义）
      expect(backend.sentMessages).toHaveLength(1) // B 未发出
      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('model switch in progress')

      // 不需切模型的任务不受互斥影响（无 model 字段）
      const taskC = await runtime.addTask('job-c', { mode: 'interval', intervalMs: 600_000 })
      const okC = await runtime.dispatchTask(taskC)
      expect(okC).toBe(true)
      expect(backend.sentMessages).toHaveLength(2)

      // A 结算（turn_end + idle 恢复）后 B 重试成功
      injectDispatchTurn(0)
      await flushAsync()
      const okRetry = await runtime.dispatchTask(taskB)
      expect(okRetry).toBe(true)
      expect(backend.sentMessages).toHaveLength(3)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M])
    })

    it('互斥强制结算的恢复与后续切换串行：恢复(原)完成前新切换目标不得写入（无交错）', async () => {
      // 场景（runTaskNow 直连路径）：互斥命中触发 mutex-forced 强制结算恢复；若恢复
      // fire-and-forget，恢复先同步清记录再 await setModel(原)，紧随的需切模型任务 B 的
      // setModel(目标) 与之并发、完成顺序不定（恢复后完成则 B 的 turn 用错模型）。修复后
      // 互斥分支 await 强制结算——锁定「恢复(原)记账并完成前，新切换不得发起」的顺序契约。
      //
      // 状态构造说明：公开行为下 reconcile 在 ticksOpen 递增过窗口的同一 tick 内即结算
      //（idle 恢复 / 非 idle 转推迟），互斥分支命中的「in-flight 过窗口残留」是防御分支——
      // 此处直接注入该内部状态（extensions 测试目录豁免 unsafe-cast 规则，ask-user 等先例）。
      const taskA = await addModelTask('job-a', TASK_M)
      await runtime.dispatchTask(taskA)
      expect(ops.setModelCalls).toEqual([TASK_M])

      // A 的事件全部丢失；把在途标记推过对账窗口（> MODEL_SWITCH_RECONCILE_TICKS = 2）
      const internal = runtime as unknown as { pendingModelSwitch: { ticksOpen: number } | null }
      expect(internal.pendingModelSwitch).not.toBeNull()
      internal.pendingModelSwitch!.ticksOpen = 3

      // 恢复(ORIG) 的 setModel 在「已记账未完成」态挂起（模拟真实 RPC 在途窗口）
      let releaseRestore: (() => void) | undefined
      const restoreInFlight = new Promise<void>(resolve => {
        releaseRestore = resolve
      })
      let gatedCalls = 0
      vi.spyOn(ops, 'setModelByRef').mockImplementation(async (ref: string) => {
        ops.setModelCalls.push(ref)
        if (ops.setModelResult) ops.currentRef = ref
        if (gatedCalls++ === 0) await restoreInFlight // 首个调用 = mutex-forced 恢复
        return ops.setModelResult
      })

      // B（需切模型）直连 dispatch：命中互斥 → 强制结算恢复（挂起）→ await
      const taskB = await addModelTask('job-b', OTHER_M)
      let bSettled = false
      let bResult: boolean | undefined
      void runtime.dispatchTask(taskB).then(ok => {
        bSettled = true
        bResult = ok
      })
      await flushAsync()

      // 恢复已发起（ORIG 已记账）但未完成：B 未被放行、OTHER_M 未写入（无交错核心断言）
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
      expect(bSettled).toBe(false)
      expect(backend.sentMessages).toHaveLength(1) // 仅 A 的消息，B 未 dispatch

      // 放行恢复 → 互斥分支才继续 skip（B 返回 false，pending 留待下 tick 重试）
      releaseRestore!()
      await flushAsync()
      expect(bSettled).toBe(true)
      expect(bResult).toBe(false)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG]) // B 被 skip，未切换
      expect(backend.sentMessages).toHaveLength(1)

      // 恢复完成后 B 重试：新切换目标写入在恢复之后（调用序断言）
      const okRetry = await runtime.dispatchTask(taskB)
      expect(okRetry).toBe(true)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M])
      expect(ops.currentRef).toBe(OTHER_M)
      expect(backend.sentMessages).toHaveLength(2)
    })

    it('同 tick 双任务顺序：A 恢复过期强制开放 + B 到期切换 → B 生效不被 A 回滚', async () => {
      // A dispatch（记录在途）后事件全部丢失
      const taskA = await addModelTask('job-a', TASK_M)
      await runtime.dispatchTask(taskA)
      const taskB = await addModelTask('job-b', OTHER_M)
      taskB.nextRunAt = 0 // 到期

      runtime.startScheduler()
      // tick1：对账 ticksOpen=1（窗口内等事件）；B pending → 互斥 skip
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
      expect(backend.sentMessages).toHaveLength(1)
      expect(taskB.pending).toBe(true)
      // tick2：ticksOpen=2 仍在窗口内；B 仍 skip
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
      expect(backend.sentMessages).toHaveLength(1)
      // tick3：ticksOpen=3 > 2 → A 强制开放（idle 即恢复）→ dispatch 循环 B 切换成功。
      // 顺序约束（对账 await 先于 dispatch 循环）：A 的恢复 setModel 完成后 B 才 setModel，
      // B 生效且不被 A 回滚（若交错则最后写入是 ORIG）
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M])
      expect(ops.currentRef).toBe(OTHER_M)
      expect(backend.sentMessages).toHaveLength(2)
      expect(taskB.lastStatus).toBe('success')

      // B 的恢复链路随后正常闭环
      injectDispatchTurn(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M, ORIG])
    })
  })

  describe('对账兜底', () => {
    it('在途标记超过 2 tick 未关闭 → 强制开放并对账恢复（事件丢失路径）', async () => {
      task = await addModelTask('job', TASK_M)
      await runtime.dispatchTask(task)
      // 无任何事件注入（恢复回调永不执行）

      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick1: ticksOpen=1
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick2: ticksOpen=2，窗口内
      expect(ops.setModelCalls).toEqual([TASK_M])

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick3: >2 → 强制开放（idle）→ 恢复
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
    })

    it('无未决记录时模型漂移 = 用户自主行为，对账不动作', async () => {
      ops.currentRef = 'prov-x/model-y' // 无 dispatch，用户手动改模型
      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 5)
      expect(ops.setModelCalls).toEqual([])
    })
  })

  describe('降级与接管副作用', () => {
    it('setModel false → 日志 + 放弃切换，任务照常 dispatch（无恢复链路）', async () => {
      ops.setModelResult = false
      task = await addModelTask('job', TASK_M)
      const ok = await runtime.dispatchTask(task)
      expect(ok).toBe(true)
      expect(backend.sentMessages).toHaveLength(1)
      expect(task.lastStatus).toBe('success')
      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('model switch failed')

      // 无未决记录：事件归属不建立、turn_end 无恢复
      injectDispatchTurn(0)
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M])
    })

    it('sendMessage 同步抛错 → catch 先恢复原模型，再走现状 failed 记账', async () => {
      // 首次 reject 触发同步抛错路径；后续 resolve（CL7 现状重试语义：failed 不推进
      // nextRunAt，下个到期 tick 重试 dispatch）
      backend.sendMessage = vi.fn().mockRejectedValueOnce(new Error('session closed')).mockResolvedValue(undefined)
      task = await addModelTask('job', TASK_M)
      const ok = await runtime.dispatchTask(task)
      expect(ok).toBe(false)
      // 切换 + catch 中恢复（异常路径不把会话留在任务模型）
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
      expect(task.lastStatus).toBe('failed')

      // 重试到期：记录已清（否则互斥挡住、TASK_M 不会再次出现），dispatch 照常重试。
      // 重试成功的证据 = 第三次 setModel(TASK_M)（切换分支重新执行）+ lastStatus 翻回 success
      //（onDispatchSuccess 记账；vi.fn 覆盖实例 sendMessage 后 sentMessages 不再记录，不以此断言）
      task.nextRunAt = 0
      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, TASK_M])
      expect(task.lastStatus).toBe('success')
    })

    it('modelOps 缺省（旧装配形态）→ task.model 非空照常 dispatch，不抛错', async () => {
      const plainBackend = new MockSchedulerBackend()
      const plainRuntime = new SchedulerRuntime(plainBackend)
      const plainTask = await plainRuntime.addTask('job', { mode: 'interval', intervalMs: 60_000 }, { model: TASK_M })
      const ok = await plainRuntime.dispatchTask(plainTask)
      expect(ok).toBe(true)
      expect(plainBackend.sentMessages).toHaveLength(1)
      expect(plainTask.lastStatus).toBe('success')
    })
  })
})
