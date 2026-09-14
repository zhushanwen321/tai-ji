import { formatRelativeTime, formatSchedule } from './format.js'
import { computeNextRuns, parseSchedule } from './parsing.js'
import type { SchedulerRuntime } from './runtime.js'
import type { AddOptions, ScheduledTask } from './types.js'

// recurring 预览行数（once 只回显 1 次）
const PREVIEW_RUN_COUNT = 5

// ── 结构化结果 ──

// L1（ext-simplify-08）：errorCode 枚举与字段已删——W4 后失败通道收敛为 throw，
// tool/command 两层均零消费方；失败语义由 message 文案承载。

export interface ServiceResult<T = unknown> {
  success: boolean
  message: string
  data?: T
}

// ── SchedulerService ──

/**
 * tool 与 command 的唯一业务入口（IF-4 去双轨）：
 * 5 个动作单一实现，返回结构化 ServiceResult。
 * - 成功: { success: true, message, data }
 * - 失败: { success: false, message }
 *
 * message 为用户可读纯文本（tool 用作 content 文本、command 直接输出），
 * data 供 tool details（create: {task, nextRuns}；list: {tasks}）。
 */
export class SchedulerService {
  constructor(public readonly runtime: SchedulerRuntime, private readonly now: () => number) {}

  /**
   * 创建任务。
   * 注意：create 接收原始 schedule 字符串、内部 parseSchedule（而非已解析的
   * ScheduleSpec）——这是对 IF-4 草案 create(parseResult) 的有意细化：
   * 解析失败需要结构化失败返回（success=false + 用户可读 message），把解析责任留在
   * service 内，tool/command 两层都不需要重复 parseSchedule。
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
        message: `Invalid schedule: "${scheduleInput}". Use duration (5m/2h/1d) or cron expression (*/10 * * * *).`,
      }
    }

    let task: ScheduledTask
    try {
      task = await this.runtime.addTask(prompt, parsed, options)
    } catch (err) {
      // 失败归一 message 通道（L1）：任务上限 / 意外错误（正常路径不会到达——
      // parseSchedule 已校验 cron 有效性）同样回传原始 message
      return { success: false, message: err instanceof Error ? err.message : String(err) }
    }

    const count = task.kind === 'once' ? 1 : PREVIEW_RUN_COUNT
    // 消息内相对时间与 nextRuns 必须同基准：分开读时钟会在整点边界漂移（in 1h → in 59m）
    const now = this.now()
    const nextRuns = computeNextRuns(task.schedule, now, count)
    // once 单行内联回显（只执行 1 次，编号列表会误导）；recurring 保持 5 行编号列表
    const runPreview =
      task.kind === 'once'
        ? `Next run: ${formatRelativeTime(nextRuns[0]!, now)}`
        : [
            'Next 5 runs:',
            ...nextRuns.map((t, i) => `  ${i + 1}. ${formatRelativeTime(t, now)}`),
          ].join('\n')
    // 一行紧凑：name(id) + schedule(含 kind 信息) + expires。
    // 删冗余 Kind 行（formatSchedule 已含 once/every）；Expires 合并（默认 no-expires 显式）。
    const expiresLabel = task.expiresAt
      ? `expires ${formatRelativeTime(task.expiresAt, now)}`
      : 'no-expires'
    const message = [
      `Task "${task.name}" (${task.id}) created. ${formatSchedule(task.schedule, task.kind)}, ${expiresLabel}`,
      runPreview,
    ].join('\n')

    return { success: true, message, data: { task, nextRuns } }
  }

  list(): ServiceResult<{ tasks: ScheduledTask[] }> {
    const tasks = this.runtime.listTasks()
    if (tasks.length === 0) {
      return { success: true, message: 'No scheduled tasks.', data: { tasks: [] } }
    }
    // 同 create：同一基准渲染全部相对时间，避免逐项读时钟的边界漂移
    const now = this.now()
    const message = tasks.map(t =>
      `${t.enabled ? '●' : '○'} ${t.id} ${t.name} · ${formatSchedule(t.schedule, t.kind)} · ${formatRelativeTime(t.nextRunAt, now)}`
    ).join('\n')
    return { success: true, message, data: { tasks } }
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
      return { success: false, message: `Task ${id} not found.` }
    }
    return { success: true, message: `Task ${id} ${enabled ? 'enabled' : 'disabled'}.` }
  }

  delete(id: string | undefined): ServiceResult {
    if (!id) {
      return { success: false, message: 'id is required for delete.' }
    }
    const success = this.runtime.deleteTask(id)
    if (!success) {
      return { success: false, message: `Task ${id} not found.` }
    }
    return { success: true, message: `Task ${id} deleted.` }
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
      return { success: false, message: `Task ${id} not found.` }
    }
    const dispatched = await this.runtime.runTaskNow(id)
    if (!dispatched) {
      return {
        success: false,
        message: `Task ${id} not dispatched (disabled, rate-limited, or dispatch in flight).`,
      }
    }
    return { success: true, message: `Task ${id} executed.` }
  }
}
