import { guardStaleCtx, toErrorMessage } from '@zhushanwen/pi-ext-guards'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import type { SchedulerBackend } from './backend.js'
import { autoName, generateTaskId } from './format.js'
import { computeNextRunAt, MS_PER_DAY, MS_PER_MINUTE, parseDuration } from './parsing.js'
import { appendExecutionRecord, toTaskSnapshot } from './types.js'
import type {
  AddOptions,
  ScheduledTask,
  SchedulerEntryOp,
  ScheduleSpec,
} from './types.js'

const logger = getLogger('scheduler')

const MAX_TASKS = 50
const RATE_LIMIT_PER_MINUTE = 6
const TICK_INTERVAL_MS = 30_000
const DEFAULT_EXPIRY_DAYS = 7
const DEFAULT_EXPIRY_MS = DEFAULT_EXPIRY_DAYS * MS_PER_DAY // 7 days
// U4 dispatch 模型切换（设计 D3 修订版）：
// - dispatch 注入消息的 customType 标记前缀（dispatchTaskInner 的 sendMessage 与
//   handleMessageStart 的归属匹配共用单点，字面漂移会静默断开事件恢复链路）
const DISPATCH_CUSTOM_TYPE_PREFIX = 'pi-scheduler:'
// - 在途标记强制开放的 tick 计数（D3 在途标记生命周期：超过 2 个 tick 未关闭即视为事件丢失）
const MODEL_SWITCH_RECONCILE_TICKS = 2

/**
 * 模型控制面（U4 dispatch 模型切换，依赖反转）：runtime 只见 'provider/id' 字符串 ref
 * （与 ScheduledTask.model 同域，tool.ts draft 组装 modelRef 的产出形态），pi 的 Model
 * 对象解析（modelRegistry.find → setModel）封在生产装配闭包（index.ts session_start）。
 *
 * 契约：setModelByRef 不 throw、失败（解析无命中 / pi setModel false / 意外异常）返回 false。
 *
 * 缺省（不注入）= 无模型切换能力：task.model 非空时降级为照常 dispatch（日志，模型字段
 * 不阻塞核心调度），纯 runtime 单测与旧装配路径行为不变。
 */
export interface SchedulerModelOps {
  /** 会话当前模型的 'provider/id' 引用（ctx.model；undefined = 会话无模型） */
  getCurrentModelRef(): string | undefined
  /** 切换会话模型；false = 解析失败 / pi setModel false（无可用 API key 等） */
  setModelByRef(ref: string): Promise<boolean>
  /** 会话是否 idle（not streaming，ctx.isIdle） */
  isIdle(): boolean
}

/**
 * 未决模型切换记录（设计 D3 状态机三要素之一，纯内存态）。模型语义异常不进持久化词表
 * （replay 守卫对 advance.status 硬校验 'success'，旁路字段会炸重放推进）。
 *
 * phase 生命周期（在途标记三分）：
 * - 'in-flight'：等待 dispatched turn 的 turn_end 恢复；ticksOpen 计数超过
 *   MODEL_SWITCH_RECONCILE_TICKS → 事件丢失，对账强制开放
 * - 'awaiting-restore'：非 idle 推迟 / 强制开放转推迟；比对决策已在窗口内锁定，
 *   执行不受窗口过期限制——tick 重入 idle 即兑现（不设墙钟上界）
 * - 恢复成功 / restore-failed（setModel(原) false）→ 记录清除（终态只留日志）
 */
interface PendingModelSwitch {
  taskId: string
  /** 会话期望模型（dispatch 切换前抓取的原模型 'provider/id'） */
  expectedModelRef: string
  targetModelRef: string
  phase: 'in-flight' | 'awaiting-restore'
  ticksOpen: number
}

/**
 * message_start 的 custom message 形状守卫（unknown 收窄，无断言）：
 * role:'custom' 且 customType 以 pi-scheduler: 开头（dispatch 注入标记，P-MODEL-④）。
 */
function matchesDispatchCustomType(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  if (!('role' in message) || !('customType' in message)) return false
  if (message.role !== 'custom') return false
  return (
    typeof message.customType === 'string' && message.customType.startsWith(DISPATCH_CUSTOM_TYPE_PREFIX)
  )
}
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
  // U4 dispatch 模型切换（设计 D3 修订版）：模型控制面（缺省 undefined = 无切换能力，降级）
  private readonly modelOps: SchedulerModelOps | undefined
  // 未决模型切换记录（同时至多一条——互斥窗口 + 模型 op 串行队列共同保证「切换→dispatch→
  // 恢复」周期单在途、单 setModel 在途）
  private pendingModelSwitch: PendingModelSwitch | null = null
  // 模型 op 串行队列尾（MF-2 收口）：调度器发起的全部 setModel（dispatch 切换 / 期望模型
  // 恢复 / 错误路径恢复）单点经 serializeModelOp 入队——「setModel 起步 → 记录创建 /
  // 恢复收口」全程持队，任何后继 setModel 发起点先排队前置等待，两个 setModel 并发
  // 结构性不可能（完成顺序不定 → turn 静默跑错模型的交错被消除）。链条引用恒吞错
  // 自愈（见 serializeModelOp），前序 op 失败不阻断后继。
  private modelOpChain: Promise<void> = Promise.resolve()
  // 归属状态机 run 窗口（P-MODEL-③④：turnIndex per-run 归零，禁止裸 turnIndex 跨 run 当 id）：
  // agent_start 起算（重置 turn 序态）、agent_end / agent_settled 封口
  private runWindowActive = false
  private currentTurnIndex = -1
  private dispatchedTurnIndex: number | null = null

  /**
   * 依赖反转构造：backend 承担 appendEntry/pi.sendMessage/时间源，runtime 只持有内存态。
   * 不触碰任何 FS / session JSONL（测试可用 MockSchedulerBackend 零副作用注入）。
   *
   * isCtxStale（G1 代际检测，S9/R3-M1）：返回 true 表示本 runtime 建立时的 session 已被
   * 替换。index.ts 装配点注入（模块级代数比对，R3-M1），使 stale 分诊不依赖 pi 错误文案；
   * 缺省（不注入）恒视为非 stale——纯 runtime 单测与旧装配路径行为不变。
   *
   * modelOps（U4）：模型控制面，session_start 装配点注入；缺省 = 无模型切换能力
   * （task.model 非空时降级照常 dispatch）。
   */
  constructor(backend: SchedulerBackend, isCtxStale?: () => boolean, modelOps?: SchedulerModelOps) {
    this.backend = backend
    this.isCtxStale = isCtxStale
    this.modelOps = modelOps
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
      model: options.model,
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
      task: toTaskSnapshot(task),
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
        this.disableForInvalidCron(task)
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
    // U4 对账兜底（设计 D3）：严格先于本 tick 的 dispatch 循环。顺序约束：否则出现
    // 「B dispatch 先切 Y → 对账持 A 旧记录把 Y 静默切回」的交错（Y 从未生效、全序列
    // 无报错，G4 被绕过）。恢复执行时 await 完成，保证恢复 setModel 完成后 dispatch 循环
    // 才开 setModel；更广的「任意两个 setModel 不并发」由模型 op 串行队列（modelOpChain）
    // 结构保证——含 turn_end 恢复 fire-and-forget 挂点，dispatch 模型分支排在其后。
    // 无未决记录的绝大多数 tick 同步返回、不引入 microtask 断点——dispatch 的同步段
    // 契约（in-flight 守卫在 tickScheduler() 未 await 时同步可见）保持不变。
    const reconciling = this.reconcileModelSwitch()
    if (reconciling) await reconciling

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
   * U4 模型切换（设计 D3 修订版）：task.model 非空且 ≠ 会话当前模型时，sendMessage 前
   * 按序执行「互斥校验 → setModel(task.model) → 记未决切换记录 → sendMessage」，切换段
   * 整体入模型 op 串行队列（modelOpChain——与恢复 setModel 互斥，MF-2）。busy 亦照常 setModel
   * （P-MODEL-② 证伪「busy 切换不生效」——steer 消息消费时在同一 run 内开新 turn，turn
   * 开始从 ctx.model 取当前模型，setModel 对 steer turn 生效。pi 实装锚点（0.84.4）：
   * dist/core/agent-session.js:1258 setModel 同步写 agent.state.model + :304 每个 turn
   * 准备时从 agent.state.model 取模型快照——setModel 先于下一 turn 准备即生效）。
   * 失败降级（分级，不阻塞核心
   * 调度）：modelOps 缺省 / 会话无当前模型 / setModel false → 日志 + 放弃切换，照常 dispatch。
   *
   * 持久化（append-only）：recurring 成功推进 nextRunAt → append advance（status='success' CL8）；
   * once 成功 → append delete。失败 dispatch 不 append（CL7 重试语义，transient 失败 nextRunAt 未推进）。
   * 模型切换语义不进任何持久化词表（U4 (c)：appendExecutionRecord/advance/delete 行为不变）。
   */
  private async dispatchTaskInner(task: ScheduledTask): Promise<boolean> {
    // 检查速率限制（U4 (b)：rate-limit 拒绝路径保持在任何 setModel 之前，无模型残留）
    if (!this.hasDispatchCapacity(this.backend.now())) return false

    const modelOps = this.modelOps
    if (task.model && modelOps && task.model !== modelOps.getCurrentModelRef()) {
      // 串行段闭包内使用：task.model 的属性收窄不进异步闭包，入口处捕获为 const
      const targetModelRef = task.model
      let skipped = false
      if (this.pendingModelSwitch) {
        // 互斥窗口（设计 D3，理由 = 切换秩序）：未决记录未关闭时，其他需切模型任务命中即
        // skip 本轮 + pending 留待下 tick 重试（复用现状 skip 语义，不建真队列；不需切模型
        // 的任务不受互斥影响——检查只在本分支）。「dispatch 写新记录前先强制结算旧记录」
        // 的落地：本分支结构性永不写新记录（杜绝新旧叠写），同时把已过窗口的 in-flight
        // 残留先强制开放转移，保证新任务在旧记录结算后 ≤1 tick 内接管、不被过期残留无限阻塞。
        // 强制结算的恢复必须 await（顺序约束，与 tickScheduler 的对账 await 同构）：恢复
        // setModel(原) 完成后才放行 skip——恢复与紧随的需切模型任务 setModel(目标) 不得
        // 并发（串行由模型 op 队列结构保证，本 await 是调用方顺序语义：skip 放行前恢复
        // 已收口）；本分支随后即 skip，await 无额外延迟代价。
        await this.forceSettleExpiredInFlight()
        skipped = true
      } else {
        // 模型 op 串行段（MF-2 收口，互斥窗口全程覆盖「setModel 起步 → 记录创建」）：
        // 前序模型 op（turn_end 恢复 / 前序 dispatch 切换 / 错误路径恢复）可能仍在途——
        // 排队等待期间未决记录与当前模型均可能变化，禁止按排队前快照盲切（旧快照的
        // expectedModelRef 会把恢复锚点记错），串行段内重新校验后再切换。后来的需切模型
        // 任务同样排队、出队时重新校验命中互斥 skip——双记录叠写 / 两个 setModel 并发
        // 结构性不可能。
        await this.serializeModelOp(async () => {
          const currentNow = modelOps.getCurrentModelRef()
          if (currentNow === undefined) {
            // 会话无当前模型：期望模型无处记录、恢复不可定义 → 放弃切换照常 dispatch（分级降级）
            logger.warn('cannot record expected model for switch (session has no current model)', {
              taskId: task.id,
              targetModelRef,
            })
            return
          }
          if (this.pendingModelSwitch) {
            // 排队期间前序 dispatch 已建未决记录 → 互斥命中：skip 留待下 tick，不叠写
            skipped = true
            return
          }
          if (targetModelRef === currentNow) {
            // 排队期间恢复已兑现（会话已回期望模型 = 本任务目标）→ 无需切换
            return
          }
          const switched = await modelOps.setModelByRef(targetModelRef)
          if (switched) {
            // setModel 受理 → 记未决切换记录（会话期望模型 + 在途标记，内存态）；
            // sendMessage 受理后等事件恢复（message_start 归属 → turn_end + isIdle 复核）。
            // 记录创建收在同一串行段内：互斥窗口对后继模型任务即时可见，无「已切未记」
            // 的放行缺口。
            this.pendingModelSwitch = {
              taskId: task.id,
              expectedModelRef: currentNow,
              targetModelRef,
              phase: 'in-flight',
              ticksOpen: 0,
            }
            this.dispatchedTurnIndex = null
          } else {
            // setModel false（无可用 API key 等）→ 按「恢复失败」同族处理：日志 + 放弃本次
            // 切换，任务照常 dispatch（模型字段不阻塞核心调度）
            logger.warn('model switch failed (setModel false), dispatch continues with current model', {
              taskId: task.id,
              targetModelRef,
            })
          }
        })
      }
      if (skipped) {
        logger.warn('model switch in progress, skipping this tick (pending retry next tick)', {
          taskId: task.id,
          targetModelRef,
        })
        return false
      }
    }

    try {
      await this.backend.sendMessage(
        { content: task.prompt, customType: `${DISPATCH_CUSTOM_TYPE_PREFIX}dispatched`, display: true },
        { deliverAs: 'steer', triggerTurn: true },
      )
    } catch {
      // U4 (a)：接管副作用——同步抛错路径先恢复原模型（异常路径不得把会话留在目标任务
      // 模型上），再走现状 failed 记账。记录先关后恢复（防 await 期间并发重入）。
      const ps = this.pendingModelSwitch
      if (ps && modelOps) {
        this.pendingModelSwitch = null
        this.dispatchedTurnIndex = null
        // 恢复 setModel 入模型 op 串行队列（与其他 setModel 发起点互斥，不并发）；排队后
        // 复核「当前 == 期望」：等待期间已切回则不动作
        await this.serializeModelOp(async () => {
          if (modelOps.getCurrentModelRef() === ps.expectedModelRef) return
          const restored = await modelOps.setModelByRef(ps.expectedModelRef)
          if (!restored) {
            logger.warn(
              'model restore failed after send error (restore-failed): manual switch back required',
              { expectedModelRef: ps.expectedModelRef, targetModelRef: ps.targetModelRef, taskId: ps.taskId },
            )
          }
        })
      }
      task.lastStatus = 'failed'
      task.pending = false
      appendExecutionRecord(task, this.backend.now(), 'failed')
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
    appendExecutionRecord(task, now, 'success')

    if (task.kind === 'once') {
      this.tasks.delete(task.id)
      this.appendEntrySafe({ op: 'delete', taskId: task.id })
    } else {
      const next = computeNextRunAt(task.schedule, now)
      if (next === undefined) {
        this.disableForInvalidCron(task)
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

  // ── 模型切换：对账兜底与归属状态机（U4，设计 D3 修订版）──

  /**
   * 未决模型切换记录的对账探测（tickScheduler 开头调用，严格先于 dispatch 循环）。
   * 同步推进状态机，仅在需要执行恢复时返回 Promise（调用方 await——顺序约束）。
   * 对账守卫前置：仅当存在未决记录才比对恢复——无记录时「模型 ≠ 期望」是用户自主行为，
   * 不动作（否则用户在任务间隙手动切模型会被静默回滚）。
   * - in-flight：ticksOpen 计数超 MODEL_SWITCH_RECONCILE_TICKS → 恢复回调永不执行（事件
   *   丢失），强制开放：idle 即恢复（返回恢复 Promise）；非 idle 转 awaiting-restore
   *   （P-MODEL-② 证实 setModel 不影响 in-flight turn，但保守口径维持非 idle 推迟。
   *   pi 实装锚点（0.84.4）：dist/core/agent-session.js:304 turn 模型在准备时一次性
   *   快照，setModel 只写 state 不回写已在途 turn 的已快照模型）。
   *   窗口内继续等事件。
   * - awaiting-restore：比对决策已在窗口内锁定，执行不受窗口过期限制——idle 重入即兑现
   *   （tick 为天然重入点，不设墙钟上界：任务级正常路径无墙钟超时）。
   */
  private reconcileModelSwitch(): Promise<void> | undefined {
    const ps = this.pendingModelSwitch
    if (!ps) return undefined
    if (this.isCtxStale?.()) {
      // stale 代际失效（session 替换）：未决记录随代际丢弃，不触碰旧 ctx（同现有守卫路径）
      this.pendingModelSwitch = null
      return undefined
    }
    const ops = this.modelOps
    if (!ops) return undefined
    if (ps.phase === 'in-flight') {
      ps.ticksOpen += 1
      if (ps.ticksOpen <= MODEL_SWITCH_RECONCILE_TICKS) return undefined
      logger.warn('model switch in-flight mark expired, forcing reconciliation', {
        taskId: ps.taskId,
        expectedModelRef: ps.expectedModelRef,
        targetModelRef: ps.targetModelRef,
      })
      if (!ops.isIdle()) {
        ps.phase = 'awaiting-restore'
        return undefined
      }
      return this.restoreExpectedModel('reconcile-forced')
    }
    if (!ops.isIdle()) return undefined
    return this.restoreExpectedModel('reconcile-idle')
  }

  /**
   * 互斥命中时对已过窗口的 in-flight 残留做强制开放转移（idle 恢复 / 非 idle 转
   * awaiting-restore）；未过窗口或已在 awaiting-restore 的记录不动（其结算由事件与
   * tick 对账通道负责）。
   *
   * 返回 Promise 而非 fire-and-forget：idle 恢复路径透传 restoreExpectedModel，调用方
   * （dispatchTaskInner 互斥分支）必须 await——恢复 setModel(原) 与后续新任务的
   * setModel(目标) 不得并发（runTaskNow 直连路径下完成顺序不定，恢复后完成则该任务
   * turn 用错模型；串行由模型 op 队列结构保证，本 await 是调用方顺序语义：skip 放行前
   * 恢复已收口）；本分支随后即 skip，await 无额外延迟代价。
   */
  private forceSettleExpiredInFlight(): Promise<void> {
    const ps = this.pendingModelSwitch
    if (!ps || !this.modelOps) return Promise.resolve()
    if (ps.phase !== 'in-flight' || ps.ticksOpen <= MODEL_SWITCH_RECONCILE_TICKS) return Promise.resolve()
    if (this.modelOps.isIdle()) {
      return this.restoreExpectedModel('mutex-forced')
    }
    ps.phase = 'awaiting-restore'
    return Promise.resolve()
  }

  /**
   * 模型 op 入队（串行化原语，MF-2）：op 排到 modelOpChain 尾，前序 op 完成（含失败）
   * 后才执行；返回本 op 的结果 Promise 供调用方 await。链尾引用恒吞错自愈（重置为
   * resolved），保证前序 op 失败不阻断后继、也不向链条泄漏 rejection（失败只回给本 op
   * 调用方）。op 内禁止再入队（会死锁）——现有 op（切换 / 恢复）只调
   * modelOps.setModelByRef，无重入。
   */
  private serializeModelOp<T>(op: () => Promise<T>): Promise<T> {
    const result = this.modelOpChain.then(op)
    this.modelOpChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * 执行恢复（切回会话期望模型）并关闭未决记录（在途标记生命周期收口）：
   * 当前模型已等于期望（用户已手动切回）→ 清记录不动作；setModel(原) false →
   * restore-failed 终态（日志含恢复动作：会话停留在任务模型，需手动切回）+ 清记录。
   * 记录先关后恢复——防 await setModel 期间 turn_end 与 tick 对账并发重入。
   * 恢复 setModel 本体经模型 op 串行队列（serializeModelOp，MF-2）：turn_end 挂点的
   * fire-and-forget 调用由此变为安全——在途恢复持队，后续任何 setModel 发起点
   * （dispatch 切换 / 对账恢复）排队等待，两个 setModel 并发结构性不可能（完成顺序
   * 不定 → turn 静默跑错模型的交错被消除）。「当前 == 期望」复核移入串行段：排队
   * 等待期间用户已手动切回则不动作（与既有清记录不动作语义一致）。
   */
  private restoreExpectedModel(reason: string): Promise<void> {
    const ps = this.pendingModelSwitch
    const ops = this.modelOps
    if (!ps || !ops) return Promise.resolve()
    this.pendingModelSwitch = null
    this.dispatchedTurnIndex = null
    return this.serializeModelOp(async () => {
      if (ops.getCurrentModelRef() === ps.expectedModelRef) return
      const restored = await ops.setModelByRef(ps.expectedModelRef)
      if (!restored) {
        logger.warn('model restore failed (restore-failed): session stays on task model, manual switch back required', {
          taskId: ps.taskId,
          expectedModelRef: ps.expectedModelRef,
          targetModelRef: ps.targetModelRef,
          reason,
        })
      }
    })
  }

  // 归属状态机事件入口（index.ts 的 pi.on 转发；方法内不触碰捕获的 pi/ctx——恢复动作
  // 经构造注入的 modelOps，stale 代际由 isCtxStale 入口检查拦下：清状态机、不执行恢复）。

  /** agent run 开始：重置 run 窗口与 turn 序态（P-MODEL-③：turnIndex per-run 归零） */
  handleAgentStart(): void {
    if (this.isCtxStale?.()) return
    this.runWindowActive = true
    this.currentTurnIndex = -1
  }

  /** turn 开始：监听器维护「当前 turnIndex」（message_start 序态关联的基准，P-MODEL-④）。
   *  turnIndex 缺省（pi 契约恒有；测试仿真可无参调 handler）→ 忽略本次序态更新。 */
  handleTurnStart(turnIndex: number | undefined): void {
    if (this.isCtxStale?.()) return
    if (typeof turnIndex !== 'number') return
    this.currentTurnIndex = turnIndex
  }

  /**
   * message_start 归属匹配（P-MODEL-④ 实测序态 turn_start(n) → message_start(custom) →
   * … → turn_end(n)）：customType 前缀命中 → 记 dispatchedTurnIndex = 当前 turnIndex。
   * 仅在未决记录在场且 run 窗口活跃时归属——避免陈旧索引在记录关闭后意外匹配后续 turn，
   * 以及裸 turnIndex 跨 run 当 id。
   */
  handleMessageStart(message: unknown): void {
    if (this.isCtxStale?.()) return
    if (!this.pendingModelSwitch || !this.runWindowActive) return
    if (!matchesDispatchCustomType(message)) return
    this.dispatchedTurnIndex = this.currentTurnIndex
  }

  /**
   * turn_end 恢复挂点（设计 D3 修订版）：turnIndex === dispatchedTurnIndex → isIdle 复核——
   * idle 即恢复；非 idle（用户长 run 的后续 turn 在途）推迟（phase 转 awaiting-restore，
   * tick 重入 idle 即兑现）。裸 turn_end 挂点会在用户 run 未结束时提前恢复、把该 run 后续
   * turn 切回原模型，禁止（P-MODEL-② 实测形态）。turnIndex 缺省（同 handleTurnStart）不匹配。
   */
  handleTurnEnd(turnIndex: number | undefined): void {
    if (this.isCtxStale?.()) return
    const ps = this.pendingModelSwitch
    if (
      !ps ||
      typeof turnIndex !== 'number' ||
      this.dispatchedTurnIndex === null ||
      turnIndex !== this.dispatchedTurnIndex
    ) {
      return
    }
    if (this.modelOps?.isIdle()) {
      void this.restoreExpectedModel('turn-end')
    } else {
      ps.phase = 'awaiting-restore'
    }
  }

  /** agent_end / agent_settled 封口 run 窗口（窗口外 turnIndex 不作归属 id） */
  handleRunClosed(): void {
    if (this.isCtxStale?.()) return
    this.runWindowActive = false
    this.currentTurnIndex = -1
    this.dispatchedTurnIndex = null
  }

  /**
   * ERR-2 fallback（ext-simplify-17 B3 抽取）：cron 表达式失效 → 停用任务并记录失败原因
   * （toggle enable 重算与 dispatch 成功推进两处共用）。禁止 `?? now()` 类 fallback
   * （会使 nextRunAt=now，下个 tick 立即重算 → 死循环）；nextRunAt 保留原值——
   * enabled=false 后 tick 不再触发。
   */
  private disableForInvalidCron(task: ScheduledTask): void {
    task.enabled = false
    task.lastStatus = 'failed'
    task.lastError = 'cron expression invalid'
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
      logger.warn('appendEntry failed', { error: toErrorMessage(err) })
    }
  }
}
