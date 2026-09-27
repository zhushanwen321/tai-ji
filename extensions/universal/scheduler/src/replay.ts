import { toErrorMessage } from '@zhushanwen/pi-ext-guards'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import { appendExecutionRecord, snapshotToTask, TASK_ENTRY_TYPE } from './types.js'
import type { ScheduledTask, SchedulerEntryOp } from './types.js'

const logger = getLogger('scheduler')

/**
 * CustomEntry 的最小可识别形状（duck-typed，不依赖 @earendil-works/pi-coding-agent 的
 * 具体 SessionEntry 类型）。与 pending-notifications/state.ts、goal/ports.ts 同款：
 * 纯函数可独立单测，调用方传入真实 SessionEntry[] 时按结构兼容。
 */
export interface SchedulerEntryLike {
  type: string
  customType?: string
  data?: unknown
}

/**
 * 从 CustomEntry 序列折叠恢复 per-task 末态（event sourcing）。
 *
 * session_start 重放入口：PiSchedulerBackend.loadTasks() 委托本函数，把当前 session 的
 * TASK_ENTRY_TYPE custom entries 折叠成运行时任务 Map。
 *
 * 两步：
 * ① 全量折叠（foldEntries）——遍历 customType===TASK_ENTRY_TYPE 的 entries，按 op 类型折叠：
 *    - upsert → 用快照重建任务（ownerSessionFile 来自 op 顶层）
 *    - advance → nextRunAt=新值 / lastRunAt=at / runCount++ / history.push(裁20) / lastStatus=status（gap2）
 *    - toggle → enabled=新值
 *    - delete → 从 Map 移除（后续同 taskId 的 advance/toggle 对不存在 taskId 为 no-op，安全）
 *   advance/toggle/delete 对不存在的 taskId 为 no-op，因此 fork 继承的完整序列必须先全量折叠，
 *   不能在处理 upsert 时按 owner 跳过（否则后续无 owner 字段的 op 会作用于「不存在的 taskId」丢失）。
 * ② 折叠完成后按 task.ownerSessionFile !== currentSessionFile 整体过滤（gap1，filterNonOwnerTasks）：
 *   移除 fork 继承的非 owner 任务——fork 出的 session B 继承了 owner=A 的 upsert+advance 序列，
 *   但 B 不应拥有 A 的任务，重放后整体过滤掉。
 *
 * append-only 时序保证 nextRunAt 不回退（D1）：advance entry 按写入顺序折叠，自然取到最后推进值。
 *
 * getEntries 解析/迭代异常 → logger.warn + 返回空 Map（gap4）：降级为无任务而非崩溃 session_start。
 */
export function replayFoldEntries(
  entries: Iterable<SchedulerEntryLike>,
  currentSessionFile: string | undefined,
): Map<string, ScheduledTask> {
  try {
    const tasks = new Map<string, ScheduledTask>()
    foldEntries(entries, tasks)
    filterNonOwnerTasks(tasks, currentSessionFile)
    return tasks
  } catch (err) {
    // gap4：session JSONL 损坏 / 迭代器抛错时降级为无任务，不让 session_start 崩溃。
    logger.warn('replayFoldEntries failed', { error: toErrorMessage(err) })
    return new Map()
  }
}

/** 步骤① 全量折叠：跳过非本扩展 entry 与守卫不过的损坏 entry；单条折叠抛错只跳过该条（MF-2）。 */
function foldEntries(entries: Iterable<SchedulerEntryLike>, tasks: Map<string, ScheduledTask>): void {
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== TASK_ENTRY_TYPE) continue
    if (!isSchedulerEntryOp(entry.data)) continue
    const op = entry.data // SchedulerEntryOp（守卫 isSchedulerEntryOp 收窄）

    try {
      applyOp(tasks, op)
    } catch (err) {
      // MF-2：守卫已按变体校验必填字段，但嵌套数据损坏（如 upsert task.history 非数组 →
      // snapshotToTask 的 .map 抛）仍可能抛——逐条 try/catch 只跳过该条，
      // 不让外层整体 catch 把全部任务清成空 Map（一条损坏 entry 不得清空全部任务）
      logger.warn('skipping corrupted scheduler entry', { error: toErrorMessage(err) })
      continue
    }
  }
}

/** 按 op 判别值分发到对应折叠函数；无 default——未知 op 静默跳过（守卫已排除，理论不可达）。 */
function applyOp(tasks: Map<string, ScheduledTask>, op: SchedulerEntryOp): void {
  switch (op.op) {
    case 'upsert':
      applyUpsert(tasks, op)
      break
    case 'advance':
      applyAdvance(tasks, op)
      break
    case 'toggle':
      applyToggle(tasks, op)
      break
    case 'delete':
      applyDelete(tasks, op)
      break
  }
}

/** upsert → 用快照重建任务（ownerSessionFile 来自 op 顶层）。 */
function applyUpsert(
  tasks: Map<string, ScheduledTask>,
  op: Extract<SchedulerEntryOp, { op: 'upsert' }>,
): void {
  tasks.set(op.taskId, { ...snapshotToTask(op.task), ownerSessionFile: op.ownerSessionFile })
}

/** advance → 推进运行末态；对不存在的 taskId 为 no-op（fork 场景安全）。 */
function applyAdvance(
  tasks: Map<string, ScheduledTask>,
  op: Extract<SchedulerEntryOp, { op: 'advance' }>,
): void {
  const task = tasks.get(op.taskId)
  if (!task) return // no-op for unknown taskId（fork 场景安全）
  task.nextRunAt = op.nextRunAt
  task.lastRunAt = op.at
  task.runCount += 1
  appendExecutionRecord(task, op.at, op.status)
  task.lastStatus = op.status // gap2：advance 必须恢复 lastStatus（不只 nextRunAt/lastRunAt/runCount/history）
}

/** toggle → enabled=新值；携带 nextRunAt 时一并应用（P1，防快照回退到旧过期值）。 */
function applyToggle(
  tasks: Map<string, ScheduledTask>,
  op: Extract<SchedulerEntryOp, { op: 'toggle' }>,
): void {
  const task = tasks.get(op.taskId)
  if (!task) return
  task.enabled = op.enabled
  // P1：enable 重算到未来的 nextRunAt 随 toggle op 持久化；重放时应用，
  // 防 upsert 快照回退到旧过期值导致首个 tick 立即触发
  if (op.nextRunAt !== undefined) task.nextRunAt = op.nextRunAt
}

/** delete → 从 Map 移除；taskId 不存在时 no-op。 */
function applyDelete(tasks: Map<string, ScheduledTask>, op: Extract<SchedulerEntryOp, { op: 'delete' }>): void {
  tasks.delete(op.taskId)
}

/**
 * 步骤② fork owner 过滤（gap1）：折叠完成后整体移除非 owner 任务。
 * currentSessionFile 为 undefined（--no-session 模式）时，所有带 ownerSessionFile 的任务都被移除
 * （无 session 文件可归属，等同空 session）——该模式下 addTask 用 '' 兜底 owner，此处比较仍一致。
 */
function filterNonOwnerTasks(tasks: Map<string, ScheduledTask>, currentSessionFile: string | undefined): void {
  for (const [id, task] of tasks) {
    if (task.ownerSessionFile !== currentSessionFile) {
      tasks.delete(id)
    }
  }
}

/**
 * 类型守卫：判断 entry.data 是否为合法 SchedulerEntryOp——按 op 变体校验必填字段，
 * 不只校验 op 判别值（MF-2 修复）。仅按判别值收窄时，损坏 entry `{op:'upsert'}`（缺 task）
 * 会通过守卫后在 snapshotToTask(undefined) 抛 TypeError，被外层整体 catch 捕获 → 返回空 Map
 * → 一条损坏 entry 清空全部任务（违反「只忽略该条」的设计意图）。
 *
 * 变体必填校验：
 *   upsert  → taskId: string + task: 非 null 对象（嵌套字段损坏由重放循环内逐条 try/catch 兜底跳过）
 *   advance → taskId: string + nextRunAt: number + at: number + status: 'success'
 *   toggle  → taskId: string + enabled: boolean（nextRunAt?: number 可选——合法 toggle 可缺省，不能误拒）
 *   delete  → taskId: string
 * 校验不过 → 返回 false，该条被跳过（不触发整体 catch）。
 *
 * 替代 `as { op?: unknown }` 结构断言（taste/no-unsafe-cast）：守卫函数内做真实校验，
 * Record<string, unknown> 配合 typeof/值校验，不是「无校验断言」。
 */
function isSchedulerEntryOp(data: unknown): data is SchedulerEntryOp {
  if (!data || typeof data !== 'object') return false
  const record = data as Record<string, unknown>
  const op = record.op
  if (op === 'upsert') {
    return (
      typeof record.taskId === 'string' &&
      typeof record.task === 'object' &&
      record.task !== null
    )
  }
  if (op === 'advance') {
    return (
      typeof record.taskId === 'string' &&
      typeof record.nextRunAt === 'number' &&
      typeof record.at === 'number' &&
      record.status === 'success'
    )
  }
  if (op === 'toggle') {
    return (
      typeof record.taskId === 'string' &&
      typeof record.enabled === 'boolean' &&
      (record.nextRunAt === undefined || typeof record.nextRunAt === 'number')
    )
  }
  if (op === 'delete') {
    return typeof record.taskId === 'string'
  }
  return false
}
