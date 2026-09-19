/**
 * Facade 暴露给 session/ 子模块（lifecycle / dispatcher / scanner）的内部协议。
 *
 * ISP 化终态（session-service-deepening 设计 D2①/S2）：按逐文件去重调用点实测
 * （grep 'this.svc.'）拆三个窄接口——lifecycle 10 / dispatcher 6 / scanner 2 方法。
 * 跨消费者共享 2 方法（removeSessionEntry 为 lifecycle+dispatcher 共用，
 * getActiveSummaries 为 lifecycle+scanner 共用）按消费者在多个窄接口**重复声明、
 * 单一实现**——SessionService implements 三窄接口即编译期防签名漂移守卫
 * （真 ISP：每个消费者可见面 = 实际消费面）。
 *
 * 原宽接口 21 方法中 4 个不进任何窄接口：applyContextUpdate（声明于 ISessionService，
 * 组合根以具体类接线）、handleTurnUsageSideEffects / handleTurnEndSideEffects
 * （event-interpreter 经组合根回调注入消费，回调类型为内联函数签名，不走本文件接口）、
 * markHandedOff（已迁 ISessionService，handoff-service 绑具体类）。
 *
 * S3 写点归位（设计 D2②）：initializeManagedSession 从 ILifecycleSessionOps 移除
 * （迁入 SessionLifecycle 内部 registerSession，不再经 svc 回调）；sessions Map
 * 所有权迁 SessionLifecycle，本文件新增 ISessionRegistry（只读查询面，供 Facade
 * 残余域读点改道）与 ISessionRegisterDeps（registerSession 的装配依赖窄注入）。
 *
 * 打断模块级循环：子模块 `import type { I*SessionOps } from './session-internal.js'`，
 * Facade `implements` 这些接口 —— 子模块 → 接口 → Facade 单向，无 import 环。
 * （运行期 Facade 调子模块、子模块经接口回调 Facade 是调用环，非依赖环。）
 *
 * sessions Map 单写者：SessionLifecycle 唯一持有（S3 起所有者从 Facade 迁入），
 * 写点 3 处全在 lifecycle（registerSession.set / removeEntry.delete / clear）；
 * Facade 与其余子模块只经 ISessionRegistry 只读查询 + 窄接口拿到元素引用做字段更新。
 *
 * 叶子模块：仅 `import type`，不引入项目内运行时依赖。
 */
import type { IPiEngine } from '../ports/pi-engine.js'
import type { SessionSummary, ServerMessage } from '@taiji/shared'
import type { SessionOutcome } from '../ports/session.js'
import type { IEventAdapter } from '../../interfaces.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import type { IManagedSessionView, ScannedSession } from './types.js'
import type { PresetResolution } from '../preset-service.js'

/**
 * sessions Map 元素类型（原 Facade 私有 ManagedSession 的运行时句柄半段，S3 随 Map
 * 所有权迁 lifecycle 落入共享契约）。binding 扩展字段（launchPresetId / projectId /
 * spawnSource / parentAgentSessionId）由 hydrateBindingMeta 动态 patch，类型面经
 * as 转换读写（lifecycle fork / Facade toSummary 的既有模式），不入本形状。
 */
export interface IManagedSessionRecord extends IManagedSessionView {
  /** EventAdapter 运行时句柄（pi 事件订阅唯一持有者，detach 即收口）。 */
  adapter: IEventAdapter
}

// 自 session-service.ts 原样迁移（max-lines 行为保持抽取）：类型随消费者归位内部协议
// 文件（toSummary 实现体迁 session-summary.ts 后经本文件共享），仅加 export 供跨文件
// 引用，字段与语义零改动。
/** Facade 内部完整 session:Registry 记录(adapter 句柄)+ binding 扩展字段(hydrateBindingMeta 动态 patch)。 */
export interface ManagedSession extends IManagedSessionRecord {
  adapter: IEventAdapter
  /**
   * launch preset id 的内存态持有（W-RT-4，设计文档 §4.2）。
   *
   * create 路径 sidecar 已随 V9-④ 根修放行 existsSync 守卫落盘（2026-09-09）；
   * 仅 sessionFilePath 缺失（pi 异常未返回路径）等异常时序下 .preset.json 缺失，
   * 此时内存态兜底持有 presetId，供 forkSession 在 active 期读源 session preset（W-RT-5）。
   *
   * 不放 IManagedSessionView（types.ts 非 slice 范围）也不入 IManagedSessionRecord
   * （binding 扩展字段归 Facade 域）：session-lifecycle 经 Registry get(id) 拿到
   * 记录后，as 转换读写此字段（patch 模式，见 lifecycle W-RT-4/5 实现注释）。
   * toSummary 一并透传到 SessionSummary.launchPresetId。
   */
  launchPresetId?: string
  /**
   * restore 回落事实的内存态持有（F1，设计 `.tmp/tech-design/mode-system-composer-density.md` §7.5 E4）。
   *
   * 语义 = **本进程本次运行**的事实：restore 时 sidecar 里的 presetId 定义不可得
   * （`fellBackFromPresetId` 非空）→ 本次 pi 已回落 `builtin:full` 启动。
   * **不持久化**（不写 sidecar）：回落是「本进程本次运行」的内存态事实，进程重开、
   * 未 restore 时并不成立——持久化会让未重启的会话产生假陈述。
   *
   * 与 launchPresetId 同模式：不入 IManagedSessionView / IManagedSessionRecord，
   * 由 session-lifecycle restore 路径 as 转换写入，toSummary 透传到
   * SessionSummary.launchPresetFallbackTo（UI 披露位仅 restore 置位）。
   */
  launchPresetFallbackTo?: string
  /**
   * 归属 project id 的内存态持有（D14 语义修正，2026-08-04）。
   *
   * 与 launchPresetId 同模式：create 路径 sidecar 已放行落盘（V9-④ 根修），仅异常时序
   * 下 .project.json 缺失，内存态兑底持有 projectId，供 forkSession 继承 / toSummary
   * 透传 / setProject 同步。
   */
  projectId?: string
  /**
   * agent-managed session 标记的内存态持有（B-2）。
   *
   * 与 launchPresetId/projectId 同模式：create 路径 sidecar 已放行落盘（V9-④ 根修），
   * 仅异常时序下 .agent.json 缺失，内存态兑底持有，
   * 供 session-manager list 按 spawnSource 过滤 / toSummary 透传（前端 AI badge）。
   */
  spawnSource?: 'user' | 'agent'
  /** agent-managed session 的父 session id（内存态持有，语义同上 spawnSource） */
  parentAgentSessionId?: string
}

/**
 * sessions Map 只读查询面（设计 D2②：Map 所有权迁 SessionLifecycle 后，Facade 残余域
 * ~30 处读点的统一通道）。**Map 结构只读**——无 set/delete/clear（写点 3 处全在
 * lifecycle 所有者）；元素视图沿用现状可变语义：调用方拿到记录引用可直接读写字段
 * （ADR-0049 per-session Map 分区范式的既有约定），不包不可变壳。
 */
export interface ISessionRegistry {
  /** 只读查 Map（active 判定 + 元素字段读改；含 adapter 句柄）。 */
  get(sessionId: string): IManagedSessionRecord | undefined
  /** Map 是否含此 id（销毁后防 publish 守卫 / hasSession）。 */
  has(sessionId: string): boolean
  /** 全部 session id 迭代（getActiveSessionIds）。 */
  keys(): IterableIterator<string>
  /** 全部 session 记录迭代（getActiveSummaries / getActiveFilePaths / destroyAll detach 扇出）。 */
  values(): IterableIterator<IManagedSessionRecord>
}

/**
 * registerSession（原 Facade.initializeManagedSession，S3/D2② 迁入 lifecycle）的装配
 * 依赖。adapterFactory 与 send 闭包随迁，但 send 对 Facade 晚期注入状态（messageBus /
 * onMessageComplete）与 broker 的依赖经本窄接口收敛：Facade 每次调用动态读自身当前值，
 * 与原内联闭包捕获 this 引用的语义逐字等价（setter 注入前后行为一致）。
 */
export interface ISessionRegisterDeps {
  /** EventAdapter 工厂（Facade 构造参数原样透传）。 */
  adapterFactory: (sessionId: string, send: (msg: ServerMessage) => void, cwd?: string) => IEventAdapter
  /** MessageBus 当前值（setter 晚期注入，未注入时 null）。 */
  getMessageBus(): IMessageBus | null
  /** 全局消息盲广播（broker.broadcast：无 sessionId payload 消息的防御兜底通道）。 */
  broadcastGlobal(msg: ServerMessage): void
  /** message.complete 广播后通知 reload-orchestrator（未注入时 no-op）。 */
  notifyMessageComplete(sessionId: string): void
}

/**
 * lifecycle 消费的窄接口（SessionLifecycle.svc，10 方法，调用点实测）。
 *
 * S3 写点归位（设计 D2②）：initializeManagedSession 移出本接口——注册逻辑迁入
 * SessionLifecycle.registerSession（sessions Map 所有者内部直调），lifecycle 不再
 * 经 svc 回调 Facade 完成注册（「回调 hub」引力以新形式残留的被否形态）。
 * detachSession / getSession 同理不在本接口——S3 后 lifecycle 经所有权自查收口
 * （this.detachSession / this.get，Registry 面），两者仅 dispatcher+组合根消费。
 *
 * 含跨消费者共享方法（重复声明、单一实现）：removeSessionEntry（dispatcher
 * 共用）、getActiveSummaries（scanner 共用）。
 */
export interface ILifecycleSessionOps {
  /** 将 ManagedSession 转为对外 SessionSummary（含 git 信息）。 */
  toSummary(s: IManagedSessionView): SessionSummary
  /** 从 scanPiSessions 结果中按 id 查找持久化 session。 */
  findScannedSession(sessionId: string): ScannedSession | undefined
  /** 收集有效的 skill 路径（pi-provider-store + 存在性过滤）。 */
  getSkillPaths(cwd: string): string[]
  /** 收集有效的 extension 路径（经 ExtensionService）。cwd 用于解析相对的 discovery extension 目录。 */
  getExtensionPaths(cwd?: string): Promise<string[]>
  /** 当前生效的替换系统提示词（委托 ConfigService.getReplaceSystemPrompt）。 */
  getReplaceSystemPrompt(): string | undefined
  /**
   * 按 launch presetId 解析 pi 启动参数（委托 PresetService.resolve）。
   * 返回 undefined 时调用方 fallback 到现有 getExtensionPaths/getSkillPaths。
   * 见 SessionService.getLaunchPresetOptions 实现注释 + pi-launch-presets 设计文档 §8.1。
   */
  getLaunchPresetOptions(presetId: string, cwd: string): Promise<PresetResolution | undefined>
  /**
   * 拉取上下文用量并广播 context.update（restoreSession/forkSession 兜底用）。
   * fire-and-forget 语义：失败不阻塞 session 恢复（前端主动拉是主路径）。
   */
  fetchAndBroadcastContext(sessionId: string): Promise<void>
  /** 从 Map 删除条目（仅删条目，不 detach adapter / 不 destroy 进程）。 */
  removeSessionEntry(sessionId: string): void
  /**
   * S3-W2：session 创建事件通知（lifecycle 全部创建入口的收敛点：create /
   * restoreSession / forkSession 的 return 前调用）。Facade 内部触发
   * onSessionCreated → PluginService session 事件注册表定向投递。
   */
  notifySessionCreated(summary: SessionSummary): void
  /** 当前活跃会话的 summary 列表（已含 git 信息）。 */
  getActiveSummaries(): SessionSummary[]
}

/**
 * dispatcher 消费的窄接口（MessageDispatcher.svc，6 方法，调用点实测）。
 *
 * 含跨消费者共享方法（重复声明、单一实现）：removeSessionEntry（lifecycle 共用）。
 * detachSession / getSession 仅本接口+组合根消费（S3 后 lifecycle 走所有权自查）。
 */
export interface IDispatcherSessionOps {
  /** 确保会话活跃，必要时自动 restore。 */
  ensureActive(sessionId: string): Promise<IPiEngine>
  /** 按 RPC client 反查 managed session（更新 lastActiveAt / isGenerating 用）。 */
  getSessionByClient(client: IPiEngine): IManagedSessionView | undefined
  /**
   * 写 session_end 终态 entry（W4，ADR 0042）。3 个终态点复用。
   */
  persistSessionOutcome(sessionId: string, outcome: SessionOutcome, reason?: string): void
  /** 只读查 Map，返回 managed session 视图（active 判定 + 字段读改）。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** 从 Map 删除条目（仅删条目，不 detach adapter / 不 destroy 进程）。 */
  removeSessionEntry(sessionId: string): void
  /** Detach adapter（按 id 查 Map）。pi 事件订阅经 EventAdapter 唯一持有，detach 即收口。 */
  detachSession(sessionId: string): void
}

/**
 * scanner 消费的窄接口（SessionScanner.svc，2 方法，调用点实测）。
 *
 * getActiveSummaries 与 lifecycle 共用（重复声明、单一实现）。
 */
export interface IScannerSessionOps {
  /** 当前活跃会话的 summary 列表（已含 git 信息）。 */
  getActiveSummaries(): SessionSummary[]
  /** 当前活跃会话占用的 session 文件路径集合（去重用）。 */
  getActiveFilePaths(): Set<string>
}
