import { toErrorMessage } from '@zhushanwen/pi-ext-guards'

import { formatRelativeTime, formatSchedule } from './format.js'
import { toTaskParams } from './i18n.js'
import type { ServiceMessage, TaskListParams } from './i18n.js'
import { computeNextRuns, parseSchedule } from './parsing.js'
import type { SchedulerRuntime } from './runtime.js'
import type { AddOptions, ScheduledTask } from './types.js'

// recurring 预览行数（once 只回显 1 次）
const PREVIEW_RUN_COUNT = 5

// runtime 以普通 Error 抛任务上限（typed error `TaskLimitError` 归后续单元）——分类
// 收敛在本单点（设计 §6.9「失败键赋值」），禁字符串匹配散落。括号内即 runtime MAX_TASKS。
const TASK_LIMIT_RE = /^Task limit reached \((\d+)\)/

// ── 结构化结果 ──

/**
 * 结构化结果（设计 §6.9「双受众」/ §7.1）：
 * - `messageKey`：本地化键（语义 = 呈现层查词典，**非错误分类**；命名刻意避开刚被
 *   ext-simplify-08 删除的 errorCode 族）。消费者 = commands / interaction 的 L2 呈现层。
 * - `params`：locale-neutral 原始值，按 messageKey 判别（见 `i18n.ts` ServiceMessageParamsMap）。
 * - `message`：英文回退（L4 tool result 正文 + 未分类异常），**不走词典**。
 * 键或 params 缺失 = 未分类失败（不可达串 / toErrorMessage catch-all）→ L2 回落英文。
 */
export type ServiceResult<T = unknown> = {
  success: boolean
  message: string
  data?: T
} & (ServiceMessage | { messageKey?: undefined; params?: undefined })

export type { ServiceMessageKey } from './i18n.js'

// ── SchedulerService ──

/**
 * tool 与 command 的唯一业务入口（IF-4 去双轨）：
 * 5 个动作单一实现，返回结构化 ServiceResult。
 * - 成功: { success: true, messageKey, params, message, data }
 * - 失败: { success: false, messageKey?, params?, message }
 *
 * message 为英文回退（tool result 正文 / 未知异常），locale 固定 'en-US'。
 * data 供 tool details（create: {task, nextRuns}；list: {tasks}）。
 */
export class SchedulerService {
  constructor(
    public readonly runtime: SchedulerRuntime,
    private readonly now: () => number,
    /**
     * 创建成功后的汇聚点回调（可选；u-ack-turn 接线）：addTask 成功且 nextRuns 算好后
     * 调用一次。fire-and-forget —— create 不 await（触发是后台编排，不得阻塞用户可见的
     * 创建反馈时延）；调用方（index.ts）自行 catch 回调内的异步失败。
     * 既有调用点（interaction.ts / commands.ts / tool.ts）不传，行为不变。
     */
    private readonly onTaskCreated?: (task: ScheduledTask) => void,
  ) {}

  /**
   * 创建任务。
   * 注意：create 接收原始 schedule 字符串、内部 parseSchedule（而非已解析的
   * ScheduleSpec）——这是对 IF-4 草案 create(parseResult) 的有意细化：
   * 解析失败需要结构化失败返回（success=false + 用户可读 message），把解析责任留在
   * service 内，tool/command 两层都不需要重复 parseSchedule。
   * U2 起 tool 层在交互前做预校验性 parseSchedule（tool.ts 步骤 1），解析与结构化
   * 失败责任仍在本方法。
   */
  async create(
    prompt: string,
    scheduleInput: string,
    options: AddOptions = {},
  ): Promise<ServiceResult<{ task: ScheduledTask; nextRuns: number[] }>> {
    // parseSchedule 同步化（D2）后返回值即 ScheduleSpec（L7：不再包装 { spec }）；
    // undefined 唯一语义 = 表达式无效——croner 是 dependencies 恒在盘，不存在解析器缺失
    const parsed = parseSchedule(scheduleInput)
    if (!parsed) {
      return {
        success: false,
        messageKey: 'schedule.invalid',
        params: { input: scheduleInput },
        message: `Invalid schedule: "${scheduleInput}". Use duration (5m/2h/1d) or cron expression (*/10 * * * *).`,
      }
    }

    let task: ScheduledTask
    try {
      task = await this.runtime.addTask(prompt, parsed, options)
    } catch (err) {
      // 失败归一（L1）：任务上限 / 意外错误（正常路径不会到达——parseSchedule 已校验 cron 有效性）
      const limitMatch = err instanceof Error ? TASK_LIMIT_RE.exec(err.message) : null
      if (limitMatch) {
        return {
          success: false,
          messageKey: 'task.limit',
          params: { max: Number(limitMatch[1]) },
          message: toErrorMessage(err),
        }
      }
      return { success: false, message: toErrorMessage(err) }
    }

    const count = task.kind === 'once' ? 1 : PREVIEW_RUN_COUNT
    // 消息内相对时间与 nextRuns 必须同基准：分开读时钟会在整点边界漂移（in 1h → in 59m）
    const now = this.now()
    const nextRuns = computeNextRuns(task.schedule, now, count)
    // once 单行内联回显（只执行 1 次，编号列表会误导）；recurring 保持 5 行编号列表
    const runPreview =
      task.kind === 'once'
        ? `Next run: ${formatRelativeTime(nextRuns[0]!, 'en-US', now)}`
        : [
            'Next 5 runs:',
            ...nextRuns.map((t, i) => `  ${i + 1}. ${formatRelativeTime(t, 'en-US', now)}`),
          ].join('\n')
    // 一行紧凑：name(id) + schedule(含 kind 信息) + expires。
    // 删冗余 Kind 行（formatSchedule 已含 once/every）；Expires 合并（默认 no-expires 显式）。
    const expiresLabel = task.expiresAt
      ? `expires ${formatRelativeTime(task.expiresAt, 'en-US', now)}`
      : 'no-expires'
    const message = [
      `Task "${task.name}" (${task.id}) created. ${formatSchedule(task.schedule, task.kind, 'en-US')}, ${expiresLabel}`,
      runPreview,
    ].join('\n')

    // 创建汇聚点（u-ack-turn）：ack 确认轮触发。调用点在成功返回前、nextRuns 算好之后——
    // 三个创建入口（tool / command / interaction）自然经此被覆盖，无需各自动手。
    this.onTaskCreated?.(task)

    return {
      success: true,
      messageKey: 'task.created',
      params: toTaskParams(task, now),
      message,
      data: { task, nextRuns },
    }
  }

  list(): ServiceResult<{ tasks: ScheduledTask[] }> {
    const tasks = this.runtime.listTasks()
    if (tasks.length === 0) {
      return {
        success: true,
        messageKey: 'task.list.empty',
        params: {},
        message: 'No scheduled tasks.',
        data: { tasks: [] },
      }
    }
    // 同 create：同一基准渲染全部相对时间，避免逐项读时钟的边界漂移
    const now = this.now()
    const message = tasks.map(t =>
      `${t.enabled ? '●' : '○'} ${t.id} ${t.name} · ${formatSchedule(t.schedule, t.kind, 'en-US')} · ${formatRelativeTime(t.nextRunAt, 'en-US', now)}`
    ).join('\n')
    const params: TaskListParams = { n: tasks.length, tasks: tasks.map(t => toTaskParams(t, now)), now }
    return { success: true, messageKey: 'task.list', params, message, data: { tasks } }
  }

  async toggle(id: string | undefined, enabled: boolean | undefined): Promise<ServiceResult> {
    if (!id) {
      return { success: false, message: 'id is required for toggle.' }
    }
    if (enabled === undefined) {
      return { success: false, message: 'enabled is required for toggle.' }
    }
    const success = await this.runtime.toggleTask(id, enabled)
    if (!success) {
      return {
        success: false,
        messageKey: 'task.notFound',
        params: { id },
        message: `Task ${id} not found.`,
      }
    }
    return enabled
      ? { success: true, messageKey: 'task.enabled', params: { id }, message: `Task ${id} enabled.` }
      : { success: true, messageKey: 'task.disabled', params: { id }, message: `Task ${id} disabled.` }
  }

  delete(id: string | undefined): ServiceResult {
    if (!id) {
      return { success: false, message: 'id is required for delete.' }
    }
    const success = this.runtime.deleteTask(id)
    if (!success) {
      return {
        success: false,
        messageKey: 'task.notFound',
        params: { id },
        message: `Task ${id} not found.`,
      }
    }
    return { success: true, messageKey: 'task.deleted', params: { id }, message: `Task ${id} deleted.` }
  }

  /**
   * 立即执行任务。语义细分：
   * 任务不存在 → not found 文案；任务存在但 dispatch no-op
   * （disabled / rate-limited / 同任务在途）→ not dispatched 文案。
   * 修复了旧实现把 no-op 误报为 not found 的混同。
   */
  async run(id: string | undefined): Promise<ServiceResult> {
    if (!id) {
      return { success: false, message: 'id is required for run.' }
    }
    if (!this.runtime.getTask(id)) {
      return {
        success: false,
        messageKey: 'task.notFound',
        params: { id },
        message: `Task ${id} not found.`,
      }
    }
    const dispatched = await this.runtime.runTaskNow(id)
    if (!dispatched) {
      return {
        success: false,
        messageKey: 'task.notDispatched',
        params: { id },
        message: `Task ${id} not dispatched (disabled, rate-limited, or dispatch in flight).`,
      }
    }
    return { success: true, messageKey: 'task.executed', params: { id }, message: `Task ${id} executed.` }
  }
}
