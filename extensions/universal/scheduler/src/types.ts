import type { ProviderConfig } from '@earendil-works/pi-coding-agent'

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

// ── ack 确认轮（零 token 本地合成轮）契约 ──
//
// ack 机制在命令路径创建任务后跑一次本地合成轮，打开 pi 的会话落盘开关（设计
// scheduler-command-path-persistence §3.3 D3/D4）。以下类型是 backend 依赖反转面与编排
// 之间的共享契约：类型放 types.ts（纯类型/常量，无运行时逻辑），供 PiSchedulerBackend
// 与单测夹具共同消费。

/**
 * ack 触发器 custom message 的 customType 前缀：避让 dispatch 归属前缀 `pi-scheduler:`，
 * 使 `message_start` 武装判别（startsWith）不会把 dispatch / 任务消息误识别为触发器。
 */
export const ACK_CUSTOM_TYPE_PREFIX = 'pi-scheduler-ack:'

/**
 * ack 触发器 customType 单点：派生自前缀，避免「startsWith 判别用前缀、写入/精确匹配用全串」
 * 两处字面量漂移（改一处漏一处会让触发器永不被识别，功能静默失效）。
 */
export const ACK_CUSTOM_TYPE = `${ACK_CUSTOM_TYPE_PREFIX}ack`

/** ack 可用性预计算结果（临界区外算好，武装点同步 registerProvider 无 await）。 */
export type AckAvailability =
  | { available: true }
  | { available: false; reason: AckUnavailableReason }

/**
 * ack 不可用原因：`no-base` = 覆写会在注销时丢失基座的 provider（仅被其它扩展 native
 * 重载注册过）；`toggle-disabled` = 显式禁用开关；`check-failed` = 基座判据导入/读取失败
 * （fail-closed）。三者都走「不覆写 + 如实文案」路径。
 */
export type AckUnavailableReason = 'no-base' | 'toggle-disabled' | 'check-failed'

/**
 * ack 失败分类（错误规格 E1–E8b）。仅少数形态需要用户可见提示，分类纯函数据此分发：
 * `e1-register`（registerProvider 静默回退基座）、`e2-not-hit`（覆写未被调用）、
 * `e3-no-turn`（合成轮未启动）、`e4-provider-error`（provider 抛错）、
 * `e5-interrupted`（轮次被打断）、`e6-unregister`（注销抛错）、
 * `e8-no-base`（无基座不可覆写）、`e8b-hybrid`（hybrid 形态）。
 */
export type AckFailureKind =
  | 'e1-register'
  | 'e2-not-hit'
  | 'e3-no-turn'
  | 'e4-provider-error'
  | 'e5-interrupted'
  | 'e6-unregister'
  | 'e8-no-base'
  | 'e8b-hybrid'

/**
 * ack 模块级编排状态（u-ack-turn 的单例状态域）。类型放此处而非编排模块，便于编排单测
 * 构造夹具与跨模块引用；生命周期由 session_start / session_shutdown 跨代清理。
 */
export interface AckState {
  /** 已注入的触发器（等待命中的 ack 轮）；null = 无待命触发器 */
  pending: { taskId: string; sentAt: number } | null
  /** 当前覆写窗口；`registered` = 覆写是否仍在 pi 注册表（one-shot 自撤后仍非 null 直到 turn_end 安全网） */
  window: { registered: boolean } | null
  /** ack 轮是否已启动（30s 写盘自检的判据之一：文件不存在且未启动才补发告警） */
  ackTurnStarted: boolean
  /** 30s 写盘自检定时器句柄（unref；session_start/shutdown 取消） */
  writeCheckTimer: ReturnType<typeof setTimeout> | null
  /** 本次 ack 触发的任务 id（pending 在 message_start 即清空，30s 自检 / 边界通知仍需它拼去重键）；null = 本会话未发起过 ack */
  taskId: string | null
  /** 本次 ack 触发的任务名（如实通知文案插值；taskId 为兜底） */
  taskName: string
  /** 合成确认行正文（message_start 武装点与 sendMessage 共用，建任务期渲染一次缓存） */
  ackText: string
  /** 建任务期缓存的会话模型（武装点取覆写 provider/api；缺失 = 不注册覆写） */
  model: SchedulerCurrentModel | undefined
  /** 建任务期记录的会话文件路径（30s 自检 / 边界写盘判定的只读观测点；undefined = 记录时文件尚不存在） */
  sessionFile: string | undefined
  /** E6（注销抛错）后标记：下一个清理点重试一次注销 */
  needsRetry: boolean
  /** 可用性预计算结果缓存（每会话/每 provider 一次；providerId 随会话模型切换才失效） */
  availability: { providerId: string; value: AckAvailability } | undefined
}

/**
 * 会话当前模型的最小投影（`SchedulerBackend.getCurrentModel()` 返回值）。
 *
 * 只取 ack 合成轮所需三字段：`api`（registerProvider 覆写 config.api）、`provider`
 * （覆写目标 provider id）、`id`（合成 assistant 行的 model 字段）。`api` 用
 * `NonNullable<ProviderConfig['api']>`（= pi 的 `Api`）而非 `string`——覆写 config 的类型
 * 就是 ProviderConfig，同一类型源避免下游为收窄做断言（禁 any / 免断言）。
 */
export interface SchedulerCurrentModel {
  provider: string
  api: NonNullable<ProviderConfig['api']>
  id: string
}

/**
 * `registerProvider` 的覆写 config 最小面：ack 合成轮只带 `api` + `streamSimple`，不带
 * `models`（覆写不得改变 provider 的模型清单）。
 *
 * 不重定义字段——直接 Pick 自 pi 的 `ProviderConfig`，与 `pi.registerProvider` 的实参类型
 * 同源，保证 `PiSchedulerBackend.registerProvider` 转发零转换；两字段均为可选（api 缺省 =
 * 沿用基座 api）。
 */
export type SchedulerProviderOverride = Pick<ProviderConfig, 'api' | 'streamSimple'>
