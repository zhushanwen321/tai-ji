// entry 契约与折叠器单源于 @zhushanwen/extension-protocol（U2 折叠器下沉：扩展与 taiji plugin
// 同源消费，杜绝双实现漂移）。本文件保持既有 import 路径不变（re-export），仅保留
// 扩展侧写面私有物（toTaskSnapshot / 旧 store 形状 / 工具参数 / ack 机制类型）。

// ack 覆写 config 类型同源自 pi（文件尾 SchedulerCurrentModel / SchedulerProviderOverride 消费）
import type { ProviderConfig } from '@earendil-works/pi-coding-agent'

export {
  appendExecutionRecord,
  HISTORY_LIMIT,
  snapshotToTask,
  TASK_ENTRY_TYPE,
} from '@zhushanwen/extension-protocol'
export type {
  ExecutionRecord,
  ScheduleSpec,
  ScheduledTask,
  SchedulerEntryOp,
  TaskKind,
  TaskSnapshot,
  TaskStatus,
} from '@zhushanwen/extension-protocol'

// 本地保留面（写侧 helper / 旧 store 形状 / 工具参数）签名引用的类型——re-export 不引入作用域，需显式 import
import type { ScheduledTask, TaskKind, TaskSnapshot } from '@zhushanwen/extension-protocol'

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
 * ack 不可用原因：`no-base` = 无可安全覆写的基座，两种形态——①builtin/models.json 皆无
 * provider；②provider 已被其它扩展 native 重载注册（pi registerProvider 注册时即删 native
 * 层且 unregister 不恢复，覆写会静默顶掉第三方注册）；`toggle-disabled` = 显式禁用开关；
 * `check-failed` = 基座判据导入/读取失败（fail-closed）。三者都走「不覆写 + 如实文案」路径。
 */
export type AckUnavailableReason = 'no-base' | 'toggle-disabled' | 'check-failed'

/**
 * 会送达用户的 ack 失败形态（仅此两种；其余形态一律不通知）。
 *
 * 设计错误规格表 E1–E8b 中只有这两个形态该让用户看见：
 * - `e8-no-base`：覆写不可用在开窗之前即确定（无基座 / 显式禁用）⇒ 创建时同步如实告知；
 * - `e3-no-turn`：合成轮未启动，30s 自检确认文件确实不存在后异步补发。
 *
 * 其余形态（e1-register / e2-not-hit / e4-provider-error / e5-interrupted /
 * e6-unregister / e8b-hybrid）**不发用户通知**——它们都意味着真实轮已应答或与落盘无关，
 * 发「未写入」即反向撒谎；可观测性由日志面承担（字符串标签，不实体化为类型成员）。
 * 把「可通知」收窄成类型本身，反向撒谎禁令就成了编译期约束：调用点无法传入不通知的形态。
 * 错误语义的完整 SSOT = 设计 scheduler-command-path-persistence §3.4。
 */
export type AckNotifyReason = 'e3-no-turn' | 'e8-no-base'

/**
 * ack 编排状态（u-ack-turn 的单例状态域；实例持在 globalThis[Symbol.for] 进程槽，
 * development-guide §7.5）。类型放此处而非编排模块，便于编排单测
 * 构造夹具与跨模块引用；生命周期由 session_start / session_shutdown 跨代清理。
 */
export interface AckState {
  /**
   * 当前覆写窗口；非 null = 覆写仍在 pi 注册表。携带 providerId 使自撤点自足（不必
   * 回读会话模型）；one-shot 自撤成功后即置 null，注销抛错（E6）时保留以便下一清理点重试。
   */
  window: { providerId: string } | null
  /** ack 轮是否已启动（session 边界写盘判定的判据之一：文件不存在且未启动才补发告警） */
  ackTurnStarted: boolean
  /** 本次 ack 触发的任务 id（session 边界通知拼去重键用）；null = 未发起过 ack。注意：状态为模块级单例，session_start 时它可能是上一会话的残留——故所有读点都必须先过 taskId !== null 且由边界清理收口 */
  taskId: string | null
  /** 本次 ack 触发的任务名（如实通知文案插值；taskId 为兜底） */
  taskName: string
  /** 合成确认行正文（message_start 武装点与 sendMessage 共用，建任务期渲染一次缓存） */
  ackText: string
  /** 建任务期缓存的会话模型（武装点取覆写 provider/api；缺失 = 不注册覆写） */
  model: SchedulerCurrentModel | undefined
  /** 建任务期记录的会话文件路径（session 边界写盘判定的只读观测点；undefined = 记录时文件尚不存在） */
  sessionFile: string | undefined
  /** 我们的 streamSimple 是否被调用过（E2 归因唯一信号：窗口开着但从未被调用 ⇒ 真实 provider 应答了）*/
  ackStreamCalled: boolean
  /**
   * 可用性判据缓存（建任务期算一次，同会话重复创建直接复用）。缓存键 = providerId +
   * isToggleDisabled（判据的两个输入；env 开关进程内不可变，带上只为键完整）。
   * 真实收益 = 省重复读 models.json 与动态 import；武装点并不读它（武装点只取 model）。
   */
  availability:
    | { providerId: string; isToggleDisabled: boolean; value: AckAvailability }
    | undefined
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
