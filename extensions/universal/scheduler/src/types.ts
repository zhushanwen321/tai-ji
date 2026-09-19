// ── 调度规格 ──

export type ScheduleSpec =
  | { mode: 'cron'; cronExpression: string }
  | { mode: 'interval'; intervalMs: number }

// ── 任务 ──

export type TaskKind = 'once' | 'recurring'
export type TaskStatus = 'success' | 'failed'

export interface ScheduledTask {
  id: string                        // 8 位 hex，自动生成
  name: string                      // 可读名称（用户指定或从 prompt 自动截取前 30 字）
  prompt: string                    // 到期时注入的 message
  kind: TaskKind
  schedule: ScheduleSpec            // once 时 intervalMs = delayMs
  model?: string                    // 任务执行模型（scoped model id，provider/model）；undefined = 跟随会话当前模型
  enabled: boolean
  createdAt: number
  nextRunAt: number
  expiresAt?: number                // undefined = 永不过期
  runCount: number
  lastRunAt?: number
  lastStatus?: TaskStatus
  lastError?: string                // 最近一次失败原因（cron 失效 / appendEntry 失败）
  history: ExecutionRecord[]        // 最近 HISTORY_LIMIT 条
  ownerSessionFile?: string         // append-only owner：记录任务创建时所属的 session JSONL，fork 重放时按此过滤非 owner 任务（gap1）
  pending?: boolean                 // 运行时标记：到期待 dispatch（非持久化语义，勿与 TaskStatus 混淆）
}

export interface ExecutionRecord {
  at: number
  status: TaskStatus
}

/**
 * history 裁剪上限（ext-simplify-08 L5 单点）：runtime 侧 dispatch 累积
 * （onDispatchSuccess）与 replay 侧 advance 折叠共用同一上限——
 * 双处各持字面量会漂移（曾 runtime.ts / replay.ts 各写一份 20），收敛到 types.ts 单点导出。
 */
export const HISTORY_LIMIT = 20

/**
 * 追加执行记录并按 HISTORY_LIMIT 裁剪（ext-simplify-17 B4 单点）：runtime 侧 dispatch
 * 累积与 replay 侧 advance 折叠共用的 push+trim——三处内联时与上限字面量同源存在
 * 「漏改一处」漂移风险，随上限一并收敛。
 */
export function appendExecutionRecord(task: ScheduledTask, at: number, status: TaskStatus): void {
  task.history.push({ at, status })
  if (task.history.length > HISTORY_LIMIT) task.history.shift()
}

// ── CustomEntry event sourcing（append-only 任务存储）──

/**
 * pi.appendEntry 写入的 custom entry customType 标识（ext-simplify-17 B1 单点）：
 * backend.appendEntry 写入 / replay.foldEntries 过滤 / importer 旧 store 导入三处共用——
 * 各持字面量时「改一处漏两处」会使写入与重放识别脱节（写入新标识、重放不认，任务静默丢失）。
 */
export const TASK_ENTRY_TYPE = 'pi-scheduler:task'

/**
 * upsert op 携带的全量任务快照（不含 ownerSessionFile / pending）。
 * ownerSessionFile 放在 op 顶层（见 SchedulerEntryOp.upsert），
 * pending 是运行时标记不持久化。其余字段与 ScheduledTask 对齐。
 */
export interface TaskSnapshot {
  id: string
  name: string
  prompt: string
  kind: TaskKind
  schedule: ScheduleSpec
  model?: string
  enabled: boolean
  createdAt: number
  nextRunAt: number
  expiresAt?: number
  runCount: number
  lastRunAt?: number
  lastStatus?: TaskStatus
  lastError?: string
  history: ExecutionRecord[]
}

/**
 * pi.appendEntry(TASK_ENTRY_TYPE, SchedulerEntryOp) 写入 session JSONL 的 op 联合类型。
 *
 * advance.status 固定为 'success'（CL8）：对齐现有 TaskStatus='success'|'failed'，
 * 而非继承的 DM-SCHEDULER-OP 词表 'ok'。唯一 emit 值——按 CL7，advance 仅在 dispatch
 * 成功（nextRunAt 实际推进）时 append，失败 dispatch 不 append（transient 失败重试语义）。
 * fold 的 `task.lastStatus = entry.status` 直接赋值合法（'success' 属 TaskStatus）。
 */
export type SchedulerEntryOp =
  | { op: 'upsert'; taskId: string; ownerSessionFile: string; task: TaskSnapshot }
  | { op: 'advance'; taskId: string; nextRunAt: number; at: number; status: 'success' }
  | { op: 'toggle'; taskId: string; enabled: boolean; nextRunAt?: number }
  | { op: 'delete'; taskId: string }

/**
 * ScheduledTask → TaskSnapshot（ext-simplify-17 B2 canonical，解构剥离式）：剥离
 * ownerSessionFile（在 op 顶层）与 pending（运行时标记），history 用 slice() 拷贝数组
 * （元素为不可变值对象 {at,status}，无元素级 mutate 路径，数组级拷贝即隔离 push/shift）。
 *
 * 选解构式而非显式逐字段列举：快照字段自动跟随 ScheduledTask 演进——显式列举漏写
 * （可选字段）时无编译错误，upsert 快照静默缺字段、replay 恢复丢数据。
 * importer 侧输入是 normalizeLegacyTask 补全的旧 store 数据，本无 ownerSessionFile/
 * pending 运行时字段，剥离子集对其 no-op，同一实现覆盖新任务与导入两条路径。
 */
export function toTaskSnapshot(task: ScheduledTask): TaskSnapshot {
  const { ownerSessionFile: _o, pending: _p, history, ...rest } = task
  return { ...rest, history: history.slice() }
}

/**
 * TaskSnapshot → ScheduledTask（replay 侧重建）：pending 不持久化故不恢复，
 * ownerSessionFile 由调用方（replay applyUpsert）从 op 顶层补回。history 逐项深拷贝——
 * 避免恢复出的运行时 task 与快照共享数组/元素引用（task 后续被 mutate 时不污染快照）。
 */
export function snapshotToTask(snapshot: TaskSnapshot): ScheduledTask {
  return {
    id: snapshot.id,
    name: snapshot.name,
    prompt: snapshot.prompt,
    kind: snapshot.kind,
    schedule: snapshot.schedule,
    model: snapshot.model,
    enabled: snapshot.enabled,
    createdAt: snapshot.createdAt,
    nextRunAt: snapshot.nextRunAt,
    expiresAt: snapshot.expiresAt,
    runCount: snapshot.runCount,
    lastRunAt: snapshot.lastRunAt,
    lastStatus: snapshot.lastStatus,
    lastError: snapshot.lastError,
    history: snapshot.history.map(h => ({ ...h })),
  }
}

// ── 持久化 ──

export interface SchedulerStore {
  /**
   * 形状忠实保留（ext-simplify-08 L8）：旧 store 文件（npm 0.1.1 store.ts）顶层携带
   * version:1，importer 只读 tasks、version 零读点——字段是磁盘格式的文档而非消费面，
   * 删除会让类型与迁移源文件的真实形状静默漂移。
   */
  version: 1
  tasks: ScheduledTask[]
}

// ── 添加选项 ──

export interface AddOptions {
  name?: string
  kind?: TaskKind
  expires?: string
  /** 任务执行模型（scoped model id，provider/model）；缺省 = 跟随会话当前模型 */
  model?: string
}
