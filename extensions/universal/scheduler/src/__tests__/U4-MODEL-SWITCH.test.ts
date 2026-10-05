/**
 * U4_MODEL_SWITCH：dispatch 模型切换（设计 D3 修订版 + D1 归属简化 + ADR-0112
 * 事实查询翻转）验收
 *
 * 覆盖五块机制（D1 终态：agent_settled + isIdle 复核拆 turnIndex 归属状态机——原
 * turnIndex 归属：4 状态字段 + 6 事件挂点 + customType 前缀匹配）：
 * - 切换：dispatchTaskInner 在 sendMessage 前 setModel（busy 亦生效——本层不做 idle 检查）
 * - 恢复：判定锚点 = isIdle() 同步事实查询（判定层级最高）；agent_settled 确定性事件是
 *   提前触发的加速器——事件到达即查询并兑现；非 idle（settled 与用户新 run 交错）不切
 *   （记录保留），tick 的 isIdle() 查询在 idle 重入时兑现；不挂 agent_end（end 后可能
 *   有自动续跑 turn，恢复只认 settled）
 * - 互斥：切换在途时其他需切模型任务 skip + pending 留待下 tick 重试
 * - 串行化（MF-2）：settled 恢复在途 / 切换 setModel 在途未建记录窗口内，后继需切模型
 *   任务的 setModel 排队等前序模型 op 完成（任意两个 setModel 不并发、双记录不叠写）
 * - tick 事实查询兜正确性（原 2-tick 计数对账已按 ADR-0112 删除）：严格先于同 tick
 *   dispatch 循环；记录存在 + idle 即恢复（agent_settled 丢失时由查询收敛——拉保证
 *   正确、事件只优化延迟）；未决记录守卫（无记录时模型漂移 = 用户自主行为不动作）
 * - 降级与接管副作用：setModel false 不阻塞 dispatch；sendMessage 抛错 catch 先恢复；
 *   模型语义异常只走日志（不进持久化词表）
 *
 * 事件注入：直接调用 runtime 的 handleRunSettled（index.ts 的 pi.on 只做转发）。
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
import { TICK_INTERVAL_MS, SchedulerRuntime, type SchedulerModelOps } from '../runtime.js'
import type { ScheduledTask } from '../types.js'
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

/** 纯 microtask 冲刷：handleRunSettled 的恢复是 fire-and-forget async，断言前等待其 await 链完成 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** 放宽轮数的 microtask 冲刷：gate 释放后的「mock 续跑 → 队列推进 → dispatch 收尾」链
 * 跨多个 await 边界（≥8 轮），固定 5 轮会卡在结算中途误报未完成。 */
async function flushAsyncRounds(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
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

  describe('切换与 settled 恢复', () => {
    it('task.model ≠ 当前 → setModel(目标)；agent_settled + idle 即恢复(原)，重复 settled 不二次恢复', async () => {
      task = await addModelTask('job', TASK_M)
      const ok = await runtime.dispatchTask(task)
      expect(ok).toBe(true)
      expect(ops.setModelCalls).toEqual([TASK_M])

      // run 完全落定（agent_settled）+ idle：唯一事件通道立即兑现，无需推进 tick
      runtime.handleRunSettled()
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])

      // 记录已清：重复 settled 不二次恢复
      runtime.handleRunSettled()
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
    })

    it('task.model = 当前 → 不切换不写记录', async () => {
      task = await addModelTask('job', ORIG)
      const ok = await runtime.dispatchTask(task)
      expect(ok).toBe(true)
      expect(ops.setModelCalls).toEqual([])

      runtime.handleRunSettled()
      await flushAsync()
      expect(ops.setModelCalls).toEqual([])
    })

    it('settled 非 idle（与用户新 run 交错）→ 不切（记录保留），tick 重入 idle 兑现', async () => {
      task = await addModelTask('job', TASK_M)
      await runtime.dispatchTask(task)
      expect(ops.setModelCalls).toEqual([TASK_M])

      // settled 事件处理时用户已开始新 run（isIdle false）：不能切（会把新 run 模型换掉）
      ops.idle = false
      runtime.handleRunSettled()
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M])

      // 兜底不变：后续 tick 的 isIdle() 查询在 idle 重入时恢复（记录无时间窗过期）
      ops.idle = true
      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
    })

    it('恢复 setModel(原) false → restore-failed 终态：warn 日志 + 清标记 + 后续查询不再动作', async () => {
      task = await addModelTask('job', TASK_M)
      await runtime.dispatchTask(task)
      expect(ops.setModelCalls).toEqual([TASK_M])

      // 模拟恢复期 setModel 失败（无可用 key 等）
      ops.setModelResult = false
      runtime.handleRunSettled()
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('restore-failed')

      // 标记已清：后续 tick 的 isIdle() 查询不重复动作
      ops.setModelResult = true
      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 3)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
    })

    it('恢复前用户已手动切回（当前 == 期望）→ 清记录不动作', async () => {
      task = await addModelTask('job', TASK_M)
      await runtime.dispatchTask(task)
      ops.currentRef = ORIG // 用户手动切回

      runtime.handleRunSettled()
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M]) // 无恢复调用
    })
  })

  describe('互斥窗口', () => {
    it('切换在途时第二个需切模型任务 skip + pending 保留 + A 结算后重试成功', async () => {
      const taskA = await addModelTask('job-a', TASK_M)
      await runtime.dispatchTask(taskA)
      ops.idle = false // A 的 run 在途（isIdle 事实查询非 idle）：互斥窗口成立的前提

      // B 到期走 tick 路径：step2 标 pending → step3 dispatch 命中互斥 skip
      //（tick 开头的事实查询因非 idle 不动作，记录保留 → 互斥命中）
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

      // A 结算（run 落定后会话空闲 → settled + idle 恢复）后 B 重试成功
      ops.idle = true
      runtime.handleRunSettled()
      await flushAsync()
      const okRetry = await runtime.dispatchTask(taskB)
      expect(okRetry).toBe(true)
      expect(backend.sentMessages).toHaveLength(3)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M])
    })

    it('互斥结算的恢复与后续切换串行：恢复(原)完成前新切换目标不得写入（无交错）', async () => {
      // 场景（runTaskNow 直连路径）：互斥命中触发事实查询结算恢复；若恢复
      // fire-and-forget，恢复先同步清记录再 await setModel(原)，紧随的需切模型任务 B 的
      // setModel(目标) 与之并发、完成顺序不定（恢复后完成则 B 的 turn 用错模型）。修复后
      // 互斥分支 await 结算——锁定「恢复(原)记账并完成前，新切换不得发起」的顺序契约。
      //
      // 状态构造说明：公开行为下「记录存在 + idle」即结算（ADR-0112 事实查询，无窗口
      // 计数），互斥分支命中的未决记录直接可用——此处只断言记录存在
      //（extensions 测试目录豁免 unsafe-cast 规则，ask-user 等先例）。
      const taskA = await addModelTask('job-a', TASK_M)
      await runtime.dispatchTask(taskA)
      expect(ops.setModelCalls).toEqual([TASK_M])

      // A 的事件丢失（无 settled 注入）；未决记录直接可结算
      const internal = runtime as unknown as { pendingModelSwitch: unknown | null }
      expect(internal.pendingModelSwitch).not.toBeNull()

      // 恢复(ORIG) 的 setModel 在「已记账未完成」态挂起（模拟真实 RPC 在途窗口）
      let releaseRestore: (() => void) | undefined
      const restoreInFlight = new Promise<void>(resolve => {
        releaseRestore = resolve
      })
      let gatedCalls = 0
      vi.spyOn(ops, 'setModelByRef').mockImplementation(async (ref: string) => {
        ops.setModelCalls.push(ref)
        if (ops.setModelResult) ops.currentRef = ref
        if (gatedCalls++ === 0) await restoreInFlight // 首个调用 = mutex-settle 事实查询恢复
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

    it('切换 setModel 在途未建记录时并发第二个 model 任务 → 不并发第二 setModel、不叠写记录', async () => {
      // 同根 SUG 回归（互斥窗口全程覆盖）：pendingModelSwitch 在 setModelByRef 受理之后才
      // 创建，「setModel 起步 → 记录创建」的 await 窗口内第二个需切模型任务可经 runTaskNow
      // 直连进入同一分支（互斥检查读到 null）→ 双记录叠写 + 两个 setModel 交错。修复后
      // 切换段整体入模型 op 队列，后继任务排队、出队时重新校验命中互斥 skip。
      const taskA = await addModelTask('job-a', TASK_M)
      // A 的切换 setModel 挂起在「已发起未受理」态（记录尚未创建的窗口）
      let releaseSwitch: (() => void) | undefined
      const switchGate = new Promise<void>(resolve => {
        releaseSwitch = resolve
      })
      let gatedCalls = 0
      vi.spyOn(ops, 'setModelByRef').mockImplementation(async (ref: string) => {
        ops.setModelCalls.push(ref)
        if (ops.setModelResult) ops.currentRef = ref
        if (gatedCalls++ === 0) await switchGate // 首次 = A 的切换
        return ops.setModelResult
      })

      let aSettled = false
      void runtime.dispatchTask(taskA).then(ok => {
        aSettled = true
      })
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M])
      // 窗口内证据：setModel 已发起、未决记录尚未创建
      expect(
        (runtime as unknown as { pendingModelSwitch: unknown }).pendingModelSwitch,
      ).toBeNull()
      expect(aSettled).toBe(false)

      // B 并发直连 dispatch：此刻互斥检查读到 null（修复前在此放行第二 setModel）
      const taskB = await addModelTask('job-b', OTHER_M)
      let bSettled = false
      let bResult: boolean | undefined
      void runtime.dispatchTask(taskB).then(ok => {
        bSettled = true
        bResult = ok
      })
      await flushAsync()

      // B 的 setModel 未并发发起（排队等 A 的切换段出队）
      expect(ops.setModelCalls).toEqual([TASK_M])
      expect(bSettled).toBe(false)

      // 放行 A 切换 → A 建记录并完成 dispatch；B 出队后重新校验命中互斥 → skip 不叠写
      //（mock 续跑→opA 建记录→队列推进→opB skip→双 dispatch 收尾 ≥8 轮，放宽冲刷）
      releaseSwitch!()
      await flushAsyncRounds(30)
      expect(aSettled).toBe(true)
      expect(bSettled).toBe(true)
      expect(bResult).toBe(false)
      expect(ops.setModelCalls).toEqual([TASK_M]) // 全程仅一次切换调用（无并发第二 setModel）
      expect(backend.sentMessages).toHaveLength(1) // 仅 A dispatch

      // 记录未被 B 叠写：仍是 A 的记录（expected = ORIG 而非 TASK_M）
      const internal = runtime as unknown as {
        pendingModelSwitch: { taskId: string; expectedModelRef: string; targetModelRef: string } | null
      }
      expect(internal.pendingModelSwitch).not.toBeNull()
      expect(internal.pendingModelSwitch!.taskId).toBe(taskA.id)
      expect(internal.pendingModelSwitch!.expectedModelRef).toBe(ORIG)
      expect(internal.pendingModelSwitch!.targetModelRef).toBe(TASK_M)

      // A 结算后 B 重试成功（系统收敛，目标模型生效）
      runtime.handleRunSettled()
      await flushAsync()
      const okRetry = await runtime.dispatchTask(taskB)
      expect(okRetry).toBe(true)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M])
      expect(ops.currentRef).toBe(OTHER_M)
    })

    it('同 tick 双任务顺序：A 结算恢复 + B 到期切换 → B 生效不被 A 回滚', async () => {
      // A dispatch（记录在途）后事件全部丢失
      const taskA = await addModelTask('job-a', TASK_M)
      await runtime.dispatchTask(taskA)
      const taskB = await addModelTask('job-b', OTHER_M)
      taskB.nextRunAt = 0 // 到期

      runtime.startScheduler()
      // 首 tick：结算先于 dispatch 循环（顺序约束）——记录存在 + idle 即恢复 A（isIdle
      // 事实查询，无窗口计数），B 的 setModel 在恢复完成后执行，B 生效且不被 A 回滚
      //（若交错则最后写入是 ORIG）
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M])
      expect(ops.currentRef).toBe(OTHER_M)
      expect(backend.sentMessages).toHaveLength(2)
      expect(taskB.lastStatus).toBe('success')

      // B 的恢复链路随后正常闭环
      runtime.handleRunSettled()
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M, ORIG])
    })
  })

  describe('模型 op 串行化（MF-2 回归）', () => {
    it('settled 恢复在途时新需切模型任务 dispatch → 新 setModel 排队等恢复完成（先恢复后切换）', async () => {
      // MF-2 回归：handleRunSettled 的恢复是 fire-and-forget（先同步清记录再 await setModel(原)）。
      // 修复前恢复在途窗口内 pendingModelSwitch 已为 null → 新 dispatch 的互斥检查放行，
      // setModel(目标) 与在途 setModel(原) 并发、完成顺序不定（恢复后完成则该任务 turn
      // 静默跑错模型）。修复后恢复持模型 op 队列，后继 setModel 排队等其完成。
      const taskA = await addModelTask('job-a', TASK_M)
      await runtime.dispatchTask(taskA)
      expect(ops.setModelCalls).toEqual([TASK_M])

      // 恢复(ORIG) 的 setModel 挂起在「已记账未完成」态（模拟真实 RPC 在途窗口）
      let releaseRestore: (() => void) | undefined
      const restoreGate = new Promise<void>(resolve => {
        releaseRestore = resolve
      })
      // gate 按 ref 定位（不用调用序号）：spy 在 A 的 dispatch 之后安装，restore 是 spy
      // 观测的首个调用，调用序号计数会把 gate 错挂到后继 dispatch 切换上
      vi.spyOn(ops, 'setModelByRef').mockImplementation(async (ref: string) => {
        ops.setModelCalls.push(ref)
        if (ops.setModelResult) ops.currentRef = ref
        if (ref === ORIG) await restoreGate // settled 恢复挂起在「已发起未完成」态
        return ops.setModelResult
      })

      // A 的 run 完全落定且 idle → fire-and-forget 恢复启动并挂起
      runtime.handleRunSettled()
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
      // 记录已同步清（先关后恢复不变）——修复前正是这个窗口放行了并发 setModel
      expect(
        (runtime as unknown as { pendingModelSwitch: unknown }).pendingModelSwitch,
      ).toBeNull()

      // B（需切模型）直连 dispatch：恢复在途、记录已清
      const taskB = await addModelTask('job-b', OTHER_M)
      let bSettled = false
      let bResult: boolean | undefined
      void runtime.dispatchTask(taskB).then(ok => {
        bSettled = true
        bResult = ok
      })
      await flushAsync()

      // B 的 setModel 未并发发起：仍在排队等恢复（顺序约束核心断言）
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
      expect(bSettled).toBe(false)
      expect(backend.sentMessages).toHaveLength(1) // 仅 A 的消息，B 未 dispatch

      // 放行恢复 → B 的 setModel 才发起（调用序 = 恢复先完成），B 正常 dispatch
      //（restore 续跑→队列推进→opB 切换→记录→dispatch 收尾 ≥8 轮，放宽冲刷）
      releaseRestore!()
      await flushAsyncRounds(30)
      expect(bSettled).toBe(true)
      expect(bResult).toBe(true)
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M])
      expect(ops.currentRef).toBe(OTHER_M)
      expect(backend.sentMessages).toHaveLength(2)

      // B 的恢复链路随后正常闭环（终态回 ORIG）
      runtime.handleRunSettled()
      await flushAsync()
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG, OTHER_M, ORIG])
    })
  })

  describe('tick 事实查询兜正确性（事件丢失路径）', () => {
    it('agent_settled 丢失：记录存在 + idle → 下个 tick 的 isIdle() 查询恢复', async () => {
      task = await addModelTask('job', TASK_M)
      await runtime.dispatchTask(task)
      // 无任何事件注入（settled 恢复通道不触发）

      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // 首 tick：isIdle() 事实查询 → 恢复
      expect(ops.setModelCalls).toEqual([TASK_M, ORIG])
    })

    it('无未决记录时模型漂移 = 用户自主行为，查询不动作', async () => {
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

      // 无未决记录：settled 不动作（切换失败 = 无恢复对象）
      runtime.handleRunSettled()
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
