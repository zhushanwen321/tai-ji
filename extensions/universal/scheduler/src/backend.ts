import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { filterActivePath } from '@zhushanwen/pi-session-path'

import { replayFoldEntries, type SchedulerEntryLike } from './replay.js'
import { TASK_ENTRY_TYPE } from './types.js'
import type {
  ScheduledTask,
  SchedulerCurrentModel,
  SchedulerEntryOp,
  SchedulerProviderOverride,
} from './types.js'

// ── SchedulerBackend 接口 ──

/**
 * sendMessage 的 msg 形状（ext-simplify-17 B5）：与 pi 的 CustomMessage 鸭子对齐
 * （customType/display 必填）——pi 根入口不导出 CustomMessage，鸭子解耦只能文件内收敛，
 * 接口与实现两处共用（测试 mock-backend 持结构兼容的内联签名，不引用本 alias）。
 */
interface SchedulerMessage {
  content: string
  customType: string
  display: boolean
}

/** sendMessage 的 opts 形状：steer 直投选项（scheduler-steer-direct-dispatch 投递模型）。 */
interface SchedulerSendOptions {
  deliverAs?: 'steer'
  triggerTurn?: boolean
}

/**
 * 运行时协作后端抽象（依赖反转）。SchedulerRuntime 只依赖此接口：
 * 不触碰 session JSONL、不持有 pi。
 *
 * - sendMessage: 到期 dispatch 的消息注入（生产实现委托 pi.sendMessage）
 * - appendEntry: 按 op 写 TASK_ENTRY_TYPE custom entry（event sourcing）。
 *   生产实现委托 pi.appendEntry（同步落盘）。失败必须被调用方 try-catch（ER-APPEND-FAIL：
 *   runtime 捕获后 logger.warn + 不 rethrow，内存态已更新，at-least-once 已知恶化窗口）
 * - getSessionFile: 当前 session JSONL 路径（addTask 构建 upsert op 的 ownerSessionFile 用；
 *   --no-session 模式返回 undefined，调用方 ?? '' 兜底）
 * - now: 时间源（测试可注入固定值）
 *
 * 读路径不在接口：loadTasks 由 PiSchedulerBackend 类方法承担（非接口成员），内部委托
 * replayFoldEntries（折叠当前 session 的 custom entries 恢复任务），index.ts 装配点调用后
 * 经 runtime.loadTasks(tasks) 注入。append-only 模型无需全量 persist——runtime 按 op 调
 * appendEntry，replay 重放恢复，故 persist/persistSync 已移除。
 *
 * sendMessage 的 msg 签名与 pi 的 CustomMessage 对齐（customType/display 必填）：
 * 调用方必须显式提供，PiSchedulerBackend 直接透传无需兜底默认值。
 *
 * delivery handle 不在本接口（ext-simplify-08 L2）：backend 自身不消费，曾以
 * setDeliveryHandle/getDeliveryHandle 中转给 runtime 属穿层传参——现由装配点经
 * SchedulerRuntime 构造器直传。
 */
export interface SchedulerBackend {
  sendMessage(msg: SchedulerMessage, opts?: SchedulerSendOptions): Promise<void>
  appendEntry(op: SchedulerEntryOp): void
  getSessionFile(): string | undefined
  now(): number
  /**
   * 注册/覆盖 provider（ack 合成轮用）：转发 pi.registerProvider(providerId, config)。
   * config 只带 api + streamSimple，不带 models（不改变模型清单）。失败语义由调用方
   * try-catch 分诊（E1）；本方法不吞错。
   */
  registerProvider(providerId: string, config: SchedulerProviderOverride): void
  /** 注销 provider（ack 覆写 one-shot 自撤 / turn_end 安全网用）：转发 pi.unregisterProvider。 */
  unregisterProvider(providerId: string): void
  /**
   * 当前 session 的 entries 快照（只读；pi 实装返回 `SessionEntry[]`）。
   * 不触发任何写入（项目规则 #6）。
   */
  getEntries(): SchedulerEntryLike[]
  /**
   * U6c：session_tree（树回退）重折叠订阅。生产实现（PiSchedulerBackend）注册
   * pi.on('session_tree')，事件到达时按活跃路径重折叠任务集并回调 listener——
   * 落点是 SchedulerRuntime 的内存任务 Map（runtime 构造时订阅，backend 不能反向
   * 持有 runtime）。测试替身可不实现（构造侧 ?. 订阅为 no-op，既有单测路径不变）。
   */
  onSessionTree?(listener: (tasks: ScheduledTask[]) => void): void
}

/**
 * ctx.sessionManager 的最小可识别形状（duck-typed）。真实 ExtensionContext.sessionManager
 * 返回 pi 的 SessionManager（getEntries(): SessionEntry[]、getSessionFile(): string|undefined），
 * 结构兼容本接口。PiSchedulerBackend 只依赖这两个方法。
 */
export interface SchedulerBackendCtx {
  sessionManager: {
    getEntries(): SchedulerEntryLike[]
    getSessionFile(): string | undefined
    /**
     * 当前叶子 entry id（U6c 活跃路径回溯锚）。可选：真实 ExtensionContext 恒存在
     * （ReadonlySessionManager Pick 清单含 getLeafId）；最小 duck-typed ctx（单测）
     * 缺失时按文件尾回退——session_start 时点与 pi 树重放规则（叶子 = 文件最后
     * 一条 entry）等价，session_tree 时点由生产 ctx 携带精确锚。
     */
    getLeafId?(): string | null
  }
  /**
   * 会话是否空闲（not streaming）。真实 ExtensionContext 保证存在（SDK
   * core/extensions/types.d.ts:232 `isIdle(): boolean`）；声明为可选只为让 duck-typed
   * 最小 ctx（单测 / 新宿主）不必补全，缺失由 PiSchedulerBackend.isIdle() 以 fail-safe 兜底
   * （视作「有轮在跑」⇒ ack 不介入——失败方向是少做事，不是多做错事）。
   */
  isIdle?(): boolean
  /**
   * 会话当前模型（真实 ExtensionContext.model: Model<any> | undefined，结构兼容此处最小投影）。
   * 可选 = 无模型会话（ExtensionContext.model 本身可为 undefined）。
   */
  model?: SchedulerCurrentModel
}

// ── 活跃路径裁剪（U6c）──

// 活跃路径裁剪（leafId 沿 parentId 回溯，撤回后被撤子树的任务 op 不进折叠输入，
// 被撤任务不得恢复 pending、到点触发真实 turn——A14）收敛于
// @zhushanwen/pi-session-path 单一实现（四包同构副本收编，防御语义与回退口径见
// 该包 filterActivePath 注释；runtime 侧 entry-tree-builder 保持独立——extension
// 不能 import runtime 包）。

// ── 生产实现 ──

/**
 * 生产后端：pi.appendEntry（写 custom entry 到 owner session JSONL）+ pi.sendMessage + Date.now()。
 *
 * 任务状态以 append-only event sourcing 持久化：runtime 各操作调 appendEntry 写 op，
 * session_start 时 loadTasks 经 replayFoldEntries 折叠历史 entries 恢复。不再持有 store 文件、
 * 不再全量 persist/persistSync。
 */
export class PiSchedulerBackend implements SchedulerBackend {
  private ctx: SchedulerBackendCtx
  private pi: Pick<
    ExtensionAPI,
    'sendMessage' | 'appendEntry' | 'registerProvider' | 'unregisterProvider'
  > & {
    /**
     * U6c session_tree 订阅面：可选——测试最小 pi / 新宿主缺省时跳过注册（其余能力
     * 不变，fail-safe 方向 = 少做事）。生产装配点（index.ts session_start）传完整
     * ExtensionAPI，恒携带。
     */
    on?: ExtensionAPI['on']
  }
  private sessionTreeListener: ((tasks: ScheduledTask[]) => void) | null = null

  constructor(
    ctx: SchedulerBackendCtx,
    pi: Pick<
      ExtensionAPI,
      'sendMessage' | 'appendEntry' | 'registerProvider' | 'unregisterProvider'
    > & { on?: ExtensionAPI['on'] },
  ) {
    this.ctx = ctx
    this.pi = pi
    // U6c：session_tree（树回退——撤回 __taiji_nav__ → navigateTree / 用户树跳转）
    // → 重折叠。为什么注册在 backend 而非装配点 index.ts：backend 持有 pi 引用且与
    // ctx 同生命周期（每 session_start 一代）；pi 对 extension 的 API 对象每代新建
    // （pi loader.js initializeExtension 每次 factory 运行建全新 handlers Map，0.84.4
    // 实装核对），不会跨代累积 handler。
    // 纯重建体：只按活跃路径重折叠任务集（loadTasks）并回调 runtime 换 Map——不做
    // 任何 sendMessage / appendEntry / tickTimer 启停（tick 常驻循环照常消费新任务集，
    // 被撤子树任务不在集内即到点不触发，A14）。
    pi.on?.('session_tree', () => {
      this.sessionTreeListener?.(this.loadTasks())
    })
  }

  /** U6c：SchedulerRuntime 构造时订阅重折叠回调（见 SchedulerBackend.onSessionTree）。 */
  onSessionTree(listener: (tasks: ScheduledTask[]) => void): void {
    this.sessionTreeListener = listener
  }

  /**
   * 读路径：折叠当前 session 的 TASK_ENTRY_TYPE custom entries 恢复任务（非接口成员，
   * 由装配点 session_start / session_tree 重折叠调用）。replayFoldEntries 内部含 fork
   * owner 过滤与异常兜底。U6c：折叠输入接活跃路径裁剪——从 leafId 沿 parentId 回溯，
   * 被撤子树的任务 op 不再恢复 pending（否则被撤任务到点照常触发真实 turn，A14）。
   */
  loadTasks(): ScheduledTask[] {
    return [
      ...replayFoldEntries(
        filterActivePath(this.ctx.sessionManager),
        this.ctx.sessionManager.getSessionFile(),
      ).values(),
    ]
  }

  async sendMessage(msg: SchedulerMessage, opts?: SchedulerSendOptions): Promise<void> {
    await this.pi.sendMessage(msg, opts)
  }

  appendEntry(op: SchedulerEntryOp): void {
    this.pi.appendEntry(TASK_ENTRY_TYPE, op)
  }

  getSessionFile(): string | undefined {
    return this.ctx.sessionManager.getSessionFile()
  }

  now(): number {
    return Date.now()
  }

  registerProvider(providerId: string, config: SchedulerProviderOverride): void {
    this.pi.registerProvider(providerId, config)
  }

  unregisterProvider(providerId: string): void {
    this.pi.unregisterProvider(providerId)
  }

  /** 读当前 session 的 entries 快照（pi 实装返回数组，原样透传，零拷贝）。 */
  getEntries(): SchedulerEntryLike[] {
    return this.ctx.sessionManager.getEntries()
  }

  /**
   * 会话是否空闲（**类方法，非 SchedulerBackend 接口成员**——唯一消费者是装配点
   * index.ts 经具体类调用；放接口会逼每个替身实现一个用不到的成员）。
   *
   * ctx.isIdle 缺失（最小 duck ctx）时保守返回 false（视作「有轮在跑」）：ack 机制的
   * fail-safe 方向是「不确定则不介入」——运行中的轮次会自然产出 assistant 消息、打开会话
   * 落盘闸门（设计 §3.3 D4 / G4），而未知状态下注入合成轮反而可能吞掉用户消息。
   */
  isIdle(): boolean {
    return this.ctx.isIdle ? this.ctx.isIdle() : false
  }

  /**
   * 会话当前模型的最小投影（**类方法，非接口成员**，理由同 isIdle）；ctx.model 缺失/
   * undefined（无模型会话）时返回 undefined。
   */
  getCurrentModel(): SchedulerCurrentModel | undefined {
    return this.ctx.model
  }
}
