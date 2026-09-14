import { guardStaleCtx, toErrorMessage } from '@zhushanwen/pi-ext-guards'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import type { SchedulerBackend } from './backend.js'
import { autoName, generateTaskId } from './format.js'
import { computeNextRunAt, MS_PER_DAY, MS_PER_MINUTE, parseDuration } from './parsing.js'
import { HISTORY_LIMIT } from './types.js'
import type {
  AddOptions,
  ScheduledTask,
  SchedulerEntryOp,
  ScheduleSpec,
  TaskSnapshot,
} from './types.js'

const logger = getLogger('scheduler')

const MAX_TASKS = 50
const RATE_LIMIT_PER_MINUTE = 6
const TICK_INTERVAL_MS = 30_000
const DEFAULT_EXPIRY_DAYS = 7
const DEFAULT_EXPIRY_MS = DEFAULT_EXPIRY_DAYS * MS_PER_DAY // 7 days
// HISTORY_LIMIT 单点在 types.ts（ext-simplify-08 L5）——与 replay.ts 的 advance 折叠共用
// STALE_CTX_MARKER（文案兜底分诊词）已迁移到 ext-guards 共享守卫（guardStaleCtx 内部
// 引用，本文件不再直接持有）。语义：G1 模块级代际检测（isCtxStale）为主判；文案子串
// 覆盖代际盲区——显式 reload / cwd 变化触发 clearExtensionCache 后 jiti 重新 import 产生
// 全新模块环境，旧闭包引用的模块级代数冻结不再递增，isCtxStale 恒 false，只剩错误文案
// 能识别 stale。pi 非契约 API（Error message 非稳定接口）：文案由 docs/pi-semantics.json
// PS-30 探针随 pi 版本门禁自动重验；pi 升级仍需回归 runtime.test.ts 的 U1 / G1-d 文案
// 锚定用例。文案变更时此兜底失效，后果为 timer 泄漏 + 每 30s warn（不 crash）。

export class SchedulerRuntime {
  private tasks: Map<string, ScheduledTask> = new Map()
  private backend: SchedulerBackend
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private dispatchTimestamps: number[] = []
  private onAfterTickCallback: (() => void) | null = null
  private readonly isCtxStale: (() => boolean) | undefined
  // R3-S1：同任务 dispatch 在途标记（Set<taskId>），见 dispatchTask 注释
  private readonly dispatchesInFlight = new Set<string>()

  /**
   * 依赖反转构造：backend 承担 appendEntry/pi.sendMessage/时间源，runtime 只持有内存态。
   * 不触碰任何 FS / session JSONL（测试可用 MockSchedulerBackend 零副作用注入）。
   *
   * isCtxStale（G1 代际检测，S9/R3-M1）：返回 true 表示本 runtime 建立时的 session 已被
   * 替换。index.ts 装配点注入（模块级代数比对，R3-M1），使 stale 分诊不依赖 pi 错误文案；
   * 缺省（不注入）恒视为非 stale——纯 runtime 单测与旧装配路径行为不变。
   */
  constructor(backend: SchedulerBackend, isCtxStale?: () => boolean) {
    this.backend = backend
    this.isCtxStale = isCtxStale
  }

  // ── 任务 CRUD ──

  async addTask(prompt: string, schedule: ScheduleSpec, options: AddOptions = {}): Promise<ScheduledTask> {
    if (this.tasks.size >= MAX_TASKS) {
      throw new Error(`Task limit reached (${MAX_TASKS}). Delete a task first.`)
    }

    const id = generateTaskId()
    const now = this.backend.now()
    const kind = options.kind ?? 'recurring'
    const name = options.name ?? autoName(prompt)

    let expiresAt: number | undefined
    if (options.expires === 'never') {
      expiresAt = undefined
    } else if (kind === 'recurring') {
      const expiryMs = options.expires ? (parseDuration(options.expires) ?? DEFAULT_EXPIRY_MS) : DEFAULT_EXPIRY_MS
      expiresAt = now + expiryMs
    }

    // 统一 nextRunAt 计算：interval → now + intervalMs；cron → 下次命中（D2 后同步）
    const nextRunAt = computeNextRunAt(schedule, now)
    if (nextRunAt === undefined) {
      // 创建时校验失败报错给用户（仅 cron 可能 undefined，interval 恒有值）
      const expr = schedule.mode === 'cron' ? schedule.cronExpression : '<unknown>'
      throw new Error(`Invalid cron expression: ${expr}`)
    }

    const task: ScheduledTask = {
      id,
      name,
      prompt,
      kind,
      schedule,
      enabled: true,
      createdAt: now,
      nextRunAt,
      expiresAt,
      runCount: 0,
      history: [],
    }

    this.tasks.set(id, task)
    // append-only：写 upsert op 到 owner session JSONL（ER-APPEND-FAIL catch，内存态已更新）
    this.appendEntrySafe({
      op: 'upsert',
      taskId: id,
      // getSessionFile() 在 --no-session 模式返回 undefined → '' 兜底（该模式 appendEntry 无 owner 不落盘）
      ownerSessionFile: this.backend.getSessionFile() ?? '',
      task: this.toSnapshot(task),
    })
    return task
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.nextRunAt - b.nextRunAt)
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id)
  }

  async toggleTask(id: string, enabled: boolean): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task) return false
    task.enabled = enabled
    // enable 重算到未来后的新 nextRunAt；携带到 toggle op 持久化，
    // 防 resume 重放从 upsert 快照回退到旧过期 nextRunAt（P1 跨 session 持久化）
    let recalcedNext: number | undefined
    // enable 时若 nextRunAt 已过期，重算，避免 enable 瞬间立即触发
    if (enabled && task.nextRunAt < this.backend.now()) {
      const next = computeNextRunAt(task.schedule, this.backend.now())
      if (next === undefined) {
        // ERR-2 fallback：cron 表达式失效 → 停用任务并记录失败原因。
        // 禁止 `?? now()` 类 fallback（会使 nextRunAt=now，下个 tick 立即重算 → 死循环）
        task.enabled = false
        task.lastStatus = 'failed'
        task.lastError = 'cron expression invalid'
        // nextRunAt 保留原值（enabled=false 后 tick 不再触发）
      } else {
        task.nextRunAt = next
        recalcedNext = next
        // MF-1：重算到未来后清除残留 pending。pending 是「到期待 dispatch」标记，
        // 由 busy tick 的 step2 置位（W4 跨 tick 重试保留）。nextRunAt 已推到未来则该标记过期，
        // 否则下个 tick step3 `pending && enabled` 会在重算的未来时间点之前提前 dispatch，
        // 违背上方注释「避免 enable 瞬间立即触发」承诺。
        task.pending = false
      }
    }
    // 全部 mutation 完成后 append toggle：确保 append 的 enabled 是最终值
    // （LOW4：cron-invalid 回退 enabled=false 的路径，append enabled=false 而非入参 true）
    // P1：nextRunAt 仅 enable 重算到未来时携带——持久化重算值，防 resume 重放回退到 upsert 快照的旧过期值。
    // 普通 toggle / cron 失效回退（recalcedNext=undefined）不带，重放时保持 upsert 快照值。
    this.appendEntrySafe({
      op: 'toggle',
      taskId: id,
      enabled: task.enabled,
      ...(recalcedNext !== undefined && { nextRunAt: recalcedNext }),
    })
    return true
  }

  deleteTask(id: string): boolean {
    const deleted = this.tasks.delete(id)
    if (deleted) {
      this.appendEntrySafe({ op: 'delete', taskId: id })
    }
    return deleted
  }

  async runTaskNow(id: string): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task) return false
    // gap3：持久化由 dispatchTask 成功后 append advance(recurring)/delete(once) 隐式覆盖，
    // 不在此重复 append（advance 已在 dispatchTask chokepoint）
    return await this.dispatchTask(task)
  }

  // ── 调度 ──

  startScheduler(): void {
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => {
      // 三件套语义等价迁移到共享守卫 guardStaleCtx（crash-resilience D1 / u1-ext-guard；
      // 守卫语义 = 本处原地实现的泛化，迁移对照逐条可证）：
      // 1. G1 前置检查（S9）：守卫的 isCtxStale 命中 → onStale（= retireStaleTimer）且
      //    tickScheduler 不执行——与迁移前「前置分支 return」等价：本 runtime 所属 session
      //    已被替换 → timer 属泄漏资源自停退场，不触碰捕获的 stale ctx，不依赖 pi 错误文案。
      //    主防线仍是 F1（session_start 停旧 timer），此处覆盖 F1 未能触达的泄漏路径。
      // 2. F2 catch 分诊（防御兜底）：守卫对 tickScheduler 的 rejection 挂同一分诊谓词
      //    `isCtxStale() || 文案含 STALE_CTX_MARKER`（字面不变）——stale → retireStaleTimer；
      //    非 stale → 原样 reject，由下方 .catch 仅告警不终止调度（'tick error' 文案不变，
      //    U2/G1-c 锚定）。fire-and-forget 的 tick 链路必须自带 catch——tick 内任何异常
      //    （典型：泄漏 timer 的 onAfterTick → refreshWidget 访问 stale ctx.ui 抛错）无人接住
      //    即 unhandledRejection，直接崩掉 pi 主进程（E1 同机制）。
      // 3. retireStaleTimer 自停：未改（'tick stopped' warn 口径与幂等 stopScheduler 原样，
      //    U1/G1-b/G1-d 锚定）。
      // `?.catch`：前置检查命中时守卫返回 undefined（fn 未执行、无 Promise、无 rejection
      // 可接——retire 已由 onStale 完成）；非 stale 时返回 Promise，非 stale rejection
      // 流到 .catch 仅告警。
      void guardStaleCtx(() => this.tickScheduler(), {
        isCtxStale: this.isCtxStale,
        onStale: () => this.retireStaleTimer(),
      })?.catch((err: unknown) => {
        logger.warn('tick error', { error: toErrorMessage(err) })
      })
    }, TICK_INTERVAL_MS)
  }

  stopScheduler(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  /**
   * stale 自停退场（G1 前置检查与 F2 catch 分诊共用）：warn 观测口径与 crash-fix 一致
   * （含 "tick stopped"，U1 断言锚定）+ stopScheduler（幂等）。timer 自停后调度由
   * session_start 重建的新一代 runtime 接管。
   */
  private retireStaleTimer(): void {
    logger.warn('tick stopped: stale extension ctx (session replaced); timer self-retired')
    this.stopScheduler()
  }

  /**
   * 注册 tick 后回调（W2）。index.ts 注册 refreshWidget 替代独立 widgetTimer——
   * 每次 tickScheduler 末尾调用，对齐 TICK_INTERVAL_MS 刷新 widget。
   */
  onAfterTick(callback: () => void): void {
    this.onAfterTickCallback = callback
  }

  async tickScheduler(): Promise<void> {
    const now = this.backend.now()

    // 1. 过期清理（must-fix 2 / CL9：append delete 抵消残留 upsert，防 resume 复活已过期任务）
    // append-only 下 upsert entry 永久残留 JSONL（D10 不裁剪），若无 delete entry 抵消，
    // resume 时 replayFoldEntries 会从 upsert 重放出已过期任务 → 每 resume 复活直到首个 tick。
    for (const [id, task] of this.tasks) {
      if (task.expiresAt && now >= task.expiresAt) {
        this.tasks.delete(id)
        this.appendEntrySafe({ op: 'delete', taskId: id })
      }
    }

    // 2. 标记到期（pending 是运行时标记，与 enabled 正交）
    for (const task of this.tasks.values()) {
      if (task.enabled && now >= task.nextRunAt) {
        task.pending = true
      }
    }

    // 3. dispatch pending 任务（按 nextRunAt 排序）。W4：显式 +t.enabled，
    // 防御标记后到 dispatch 之间被 toggle disabled 的竞态（pending 与 enabled 正交）
    const pending = [...this.tasks.values()]
      .filter(t => t.pending && t.enabled)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)

    for (const task of pending) {
      if (task.pending) {
        await this.dispatchTask(task)
      }
    }

    // W2：tick 完成后刷新 widget（index.ts 注册 refreshWidget）
    this.onAfterTickCallback?.()
  }

  // ── dispatch ──

  /**
   * dispatch 单个任务。返回 true 表示消息已发出（pi.sendMessage 受理），false 表示
   * no-op（task disabled / 已有同任务在途 / rate-limited）。
   *
   * R3-S1 in-flight 守卫：tick 为 fire-and-forget，若 tick1 的 `await backend.sendMessage`
   * 挂起超过 TICK_INTERVAL_MS（如 pi 卡死），tick2 的 step2 会再标 pending、step3 对同一
   * task 并发第二个 dispatch → 同一 prompt 双注入。参照 subagent-workflow resumesInFlight
   * 模式：入口同步置位、finally 清除（覆盖 gate / rate-limit / sendMessage 抛错 / 成功推进
   * 全部退出路径）；命中时 skip 本轮并 warn（不 throw——tick 继续处理其他任务，本任务
   * pending 保留到下轮重试）。
   */
  async dispatchTask(task: ScheduledTask): Promise<boolean> {
    if (!task.enabled) return false
    if (this.dispatchesInFlight.has(task.id)) {
      logger.warn('dispatch already in flight, skipping this tick', { taskId: task.id })
      return false
    }
    this.dispatchesInFlight.add(task.id)
    try {
      return await this.dispatchTaskInner(task)
    } finally {
      this.dispatchesInFlight.delete(task.id)
    }
  }

  /**
   * dispatch 本体（dispatchTask 守卫置位后执行；runTaskNow 与 tick step3 共用入口，
   * 手动 run-now 与挂起中的 tick dispatch 并发时同样被守卫拦截）。
   * steer 直投（scheduler-steer-direct-dispatch 设计）：{deliverAs:'steer', triggerTurn:true}
   * 在 pi 侧的两分支——busy 时 steer 插入当前 turn（立即被模型看到）、idle 时开新 turn。
   * 受理即记账：pi extension API sendMessage 是 fire-and-forget（返回 void，错误走
   * pi 内部 emitError 通道），await 立即通过，无「入队未终态」窗口——nextRunAt 调用即推进，
   * tick 不重标 pending，无需防重标记。
   * sendMessage 抛错（同步异常，session 关闭等）时记录 failed 状态但不 rethrow，
   * 让 tick 继续处理其他任务。
   *
   * 持久化（append-only）：recurring 成功推进 nextRunAt → append advance（status='success' CL8）；
   * once 成功 → append delete。失败 dispatch 不 append（CL7 重试语义，transient 失败 nextRunAt 未推进）。
   */
  private async dispatchTaskInner(task: ScheduledTask): Promise<boolean> {
    // 检查速率限制
    if (!this.hasDispatchCapacity(this.backend.now())) return false

    try {
      await this.backend.sendMessage(
        { content: task.prompt, customType: 'pi-scheduler:dispatched', display: true },
        { deliverAs: 'steer', triggerTurn: true },
      )
    } catch {
      task.lastStatus = 'failed'
      task.pending = false
      task.history.push({ at: this.backend.now(), status: 'failed' })
      if (task.history.length > HISTORY_LIMIT) task.history.shift()
      return false
    }
    return this.onDispatchSuccess(task)
  }

  /**
   * dispatch 成功后的状态更新与持久化（dispatchTaskInner 受理成功后调用）。
   */
  private async onDispatchSuccess(task: ScheduledTask): Promise<boolean> {
    const now = this.backend.now()
    task.runCount++
    task.lastRunAt = now
    task.lastStatus = 'success'
    task.pending = false
    task.lastError = undefined
    task.history.push({ at: now, status: 'success' })
    if (task.history.length > HISTORY_LIMIT) task.history.shift()

    if (task.kind === 'once') {
      this.tasks.delete(task.id)
      this.appendEntrySafe({ op: 'delete', taskId: task.id })
    } else {
      const next = computeNextRunAt(task.schedule, now)
      if (next === undefined) {
        task.enabled = false
        task.lastStatus = 'failed'
        task.lastError = 'cron expression invalid'
      } else {
        task.nextRunAt = next
        this.appendEntrySafe({
          op: 'advance',
          taskId: task.id,
          nextRunAt: next,
          at: now,
          status: 'success',
        })
      }
    }

    this.dispatchTimestamps.push(now)
    return true
  }

  private hasDispatchCapacity(now: number): boolean {
    const oneMinuteAgo = now - MS_PER_MINUTE
    this.dispatchTimestamps = this.dispatchTimestamps.filter(t => t > oneMinuteAgo)
    return this.dispatchTimestamps.length < RATE_LIMIT_PER_MINUTE
  }

  // ── 装配与回调 ──

  /** 装配点注入初始任务数组（读盘/重放由 backend 完成，runtime 只持有内存态）。 */
  loadTasks(tasks: ScheduledTask[]): void {
    this.tasks = new Map(tasks.map(t => [t.id, t]))
  }

  // ── append-only 持久化辅助 ──

  /**
   * 委托 backend.appendEntry。失败 → logger.warn + 不 rethrow（ER-APPEND-FAIL）。
   * 内存态已先行更新（at-least-once 已知恶化窗口：append 失败则该 op 丢失，resume 重放回退）。
   * 不再设 task.lastError='persist failed'（append 失败是 transient，不应污染业务态）。
   */
  private appendEntrySafe(op: SchedulerEntryOp): void {
    try {
      this.backend.appendEntry(op)
    } catch (err) {
      // best-effort 降级（ER-APPEND-FAIL）：append-only 模型下 append 失败仅丢失该 op 的持久化，
      // 内存态已先行更新、不 rethrow，业务流程继续。at-least-once 已知恶化窗口（resume 重放回退）。
      logger.warn('appendEntry failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * ScheduledTask → TaskSnapshot：剥离 ownerSessionFile（在 op 顶层）与 pending（运行时标记），
   * history 深拷贝（避免快照与运行时 task 共享数组引用）。
   */
  private toSnapshot(task: ScheduledTask): TaskSnapshot {
    const { ownerSessionFile: _o, pending: _p, history, ...rest } = task
    return { ...rest, history: history.slice() }
  }
}
