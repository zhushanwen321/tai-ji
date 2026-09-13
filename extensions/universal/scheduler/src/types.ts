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
  enabled: boolean
  force: boolean                    // true = 即使 agent busy 也 dispatch
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
 * （onDispatchSuccess / handleSettled）与 replay 侧 advance 折叠共用同一上限——
 * 双处各持字面量会漂移（曾 runtime.ts / replay.ts 各写一份 20），收敛到 types.ts 单点导出。
 */
export const HISTORY_LIMIT = 20

// ── CustomEntry event sourcing（append-only 任务存储）──

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
  enabled: boolean
  force: boolean
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
 * pi.appendEntry('pi-scheduler:task', SchedulerEntryOp) 写入 session JSONL 的 op 联合类型。
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
  force?: boolean
}
