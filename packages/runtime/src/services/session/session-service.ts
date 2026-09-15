/**
 * SessionService — Facade(门面)。
 *
 * 组合 lifecycle/dispatcher/scanner 三子模块,实现 ISessionService(对外)与三窄接口
 * ILifecycleSessionOps/IDispatcherSessionOps/IScannerSessionOps(对内,按消费者收窄——
 * 见 session-internal.ts;单一实现即编译期防签名漂移守卫)。
 *
 * sessions Map 所有权在 SessionLifecycle(S3 写点归位,设计 D2②:Map 连同写点 3 处
 * registerSession.set/removeEntry.delete/clear 迁入 lifecycle);本 Facade 残余域的
 * Map 读点统一经 lifecycle 的 ISessionRegistry 只读查询面(get/has/keys/values),
 * 对外查询方法退化为一行委托。写/删操作(removeSessionEntry 级)不经 Registry,由
 * Facade 委托 lifecycle(Map 所有者)。
 *
 * 共享 helper(toSummary/findScannedSession)留 Facade,子模块经各自窄接口调用 ——
 * 打断模块环(子模块 → 窄接口 → Facade implements,单向)。launch 参数组装四方法
 * (getSkillPaths/getExtensionPaths/getReplaceSystemPrompt/getLaunchPresetOptions)S6 迁出
 * launch-params.ts 纯函数族,本 Facade 保留一行委托(窄接口声明不变)。
 * onSessionRegistered 订阅接线在构造器(组装根):S5/S6 后订阅者是 projection/records
 * 域模块自身(设计 D2③「换订阅者」),Facade 仅保留 reconciler 对账订阅;按迁移前
 * initializeManagedSession 体内顺序执行(播种 → record 注册 → reconciler)。
 *
 * onSessionExit 回调留构造函数:协调 lifecycle/scanner/broker 多方,不归属任一子模块。
 *
 * removeSessionEntry 销毁收敛链（唯一完成入口,四路删除路径汇聚）:[T8 有限拆分 2026-09]
 * 编排段（D1 台账 → checkpoint/mirror 摘除 → Map 删 → respawn.cancel → 销毁扇出 → 四域
 * dispose → bus.clearSession 全序列）已行为保持抽取至 session-entry-removal.ts——
 * **removeSessionEntry 顺序约束 SSOT（步骤序列 + 与 lifecycle.delete B5 段「didDestroy
 * 先行 → tombstone → dropPartition → trash」的跨文件顺序 + B5 禁止挂回本汇聚链）在该
 * 文件头**;本文件保留公开 wrapper（调用面与测试锁定面不变）。
 */
import { existsSync } from 'node:fs'
import type { SessionSummary, SessionGroup, ServerMessage, ServerMessageMap, SubagentRecord, WorkflowRunRecord, BatchDeleteResult, SegmentsMetadataEntry, ProviderId } from '@xyz-agent/shared'
import type { SubagentEngineConfigView } from '@xyz-agent/extension-protocol'
import type {
  ISessionService, IMessageBroker, SessionCreateOptions,
  IEventAdapter, IExtensionService, IConfigService,
} from '../../interfaces.js'
import type { ILifecycleSessionOps, IDispatcherSessionOps, IScannerSessionOps, ISessionRegisterDeps } from './session-internal.js'
import type { IProcessManager, IPiEngine, PiCommandInfo } from '../ports/pi-engine.js'
import { TraceSync } from './trace-sync.js'
import type { SessionTraceSnapshot } from './trace-sync.js'
import { SessionRecords } from './session-records.js'
import { SessionModelControl } from './session-model-control.js'
import { SessionHistoryReader } from './history-rebuild-cache.js'
import type { HistoryFileReadResult, HistoryWindowResult } from '../session-history.js'
import { resolveSkillPaths, resolveExtensionPaths, resolveReplaceSystemPrompt, resolveLaunchPresetOptions } from './launch-params.js'
// 行为保持抽取的实现体外移（max-lines 门禁）：summary 投影 / projection bus 视图构建，
// Facade 保留一行委托，语义注释见各新模块。
import { buildSessionSummary } from './session-summary.js'
import { createProjectionBusView } from './projection-bus-view.js'
import { persistModelBinding, readModelBinding } from '../../infra/pi/session-file-utils.js'
// D1 台账（crash-forensics §3.3 D1）：crash / deleted 事件的 runtime 侧双写源。
import { getCrashJournal } from '../../infra/crash-journal.js'
// D3 checkpoint（crash-forensics §3.3 D3，u4）：活跃 session 清单持续交接——attach /
// respawn（经 registerSession 汇聚）/ detach / reclaim 四类生命周期事件处增量维护。
import { getRuntimeCheckpointStore } from './runtime-checkpoint.js'
// D5 在途镜像（crash-forensics §3.3 D5，u7b API + 偏差 #20 生命周期接线）：attach 预置 0 /
// detach、reclaim 摘除——挂点与 checkpoint 同点位（同一收敛面，无双写）。
import { inflightMirror } from './inflight-mirror.js'
// main（file-lock-unification reaper 下沉，D2 触发面 A）：removeSessionEntry 汇聚点收殓
// 孤儿后台任务——[T8 有限拆分 2026-09] 调用点随销毁收敛链编排迁入 session-entry-removal.ts
// （模块单例直接 import，语义不变），本 Facade 不再消费。
// 后台任务数据域（background-task-sidebar D1/D2/D3/D8，u-runtime-rpc 组装）：
// registry 读 + mtime 轮询 + kill 矩阵实现在 services/background-task/（u-runtime-svc），
// 本 Facade 只做组装接线（组装点注释见构造器 backgroundTasks 赋值处）。
import { BackgroundTaskService } from '../background-task/background-task-service.js'
// [B5 触发面收窄 2026-09-15] plugin sessionData 清理分发已从本模块迁出——真删除路径
// （lifecycle.delete）侧 import 并调用（见 session-lifecycle.ts delete 内 B5 注释）；本模块
// 的 removeSessionEntry 汇聚点同时收三条 session 存活路径（pi 崩溃 exit / forceQuit /
// restore 清场），不得在此触发插件数据清理。
// [T8 有限拆分 2026-09] getPiAgentDir 仅剩的消费点（reaper 收殓入参）随销毁收敛链迁入
// session-entry-removal.ts，本 Facade 不再消费（下方 B5 注释保留为语义登记）。
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore, SessionOutcome } from '../ports/session.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import type { IManagedSessionView, ScannedSession, SendMessageHook, SessionOccupancy } from './types.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { SessionLifecycle } from './session-lifecycle.js'
import type { ReclaimSessionDeps } from './session-lifecycle.js'
// [T8 有限拆分 2026-09] removeSessionEntry 销毁收敛链编排（顺序约束 SSOT，含文件头收敛
// 说明）——行为保持抽取，本 Facade 保留公开 wrapper（测试 spyOn 锁定面）。
import { SessionEntryRemovalOrchestrator } from './session-entry-removal.js'
// 空闲回收占座原语与等待观测超时（idle-pi-reclamation D6-2，u2）。type-only import：
// Seat 实例由 u3 组合根创建后 setter 注入，本模块不持有创建权（不引入运行时依赖环）。
import type { ReclaimSeat } from './idle-pi-reaper.js'
import { RECLAIM_SEAT_WAIT_OBSERVE_MS } from './idle-pi-reaper.js'
import { RespawnOrchestrator } from './pi-respawn.js'
import { MessageDispatcher } from './message-dispatcher.js'
import { applySessionOccupancyTransition, userStoppedGate } from './event-interpreter.js'
import { SessionScanner } from './session-scanner.js'
import { AttachmentStore } from './attachment-store.js'
import { SessionStateProjection, type SessionReplicatedStates } from './session-state-projection.js'
import { PresetService, type PresetResolution } from '../preset-service.js'
// MessageBus（wave:runtime-wiring）：per-session 消息广播核心。setter 注入（同 setConfigService 模式），
// 未注入时所有 bus 调用 no-op（this.messageBus?.publish）。type-only import 避免运行时环
//（MessageBus 不反向依赖 SessionService）。
import type { IMessageBus } from '../message-bus/message-bus.js'
import type { ForceQuitSource, UserStoppedMarkStore } from './types.js'

/**
 * userStopped 标记宿主（session-dead-structural-fixes D4）：sessionId 键控的模块级独立 Map。
 * 数据源登记 = 主表 #30（docs/architecture/data-source-registry.md，2026-09-10 u3b 补登）。
 *
 * 为什么是模块级、为什么独立于 ManagedSession：forceQuit 尾步 removeSessionEntry 会删
 * sessions Map 条目、销毁 session 对象，而标记必须存活到后续 restore（用户点开 dead session
 * 时 restoreSession 读它决定是否 restore-abort）——挂在 session 对象 / 实例字段上都会随条目
 * 删除消亡。清理路径全列（D4）：restore 收敛消费（gate 静默窗满清，主路径）/ delete /
 * destroyAll / 进程退出（内存态整体消亡，天然清理）；removeSessionEntry 刻意不清（forceQuit
 * 尾步经过它，只停收敛环定时器，见 gate.disposeForEntryRemoval）。
 *
 * 子模块（dispatcher/lifecycle/interpreter 挂点）不直接 import 本模块（模块依赖单向性：
 * 本 Facade 值导入全部子模块，反向 import 成环），统一经 event-interpreter.ts 的
 * userStoppedGate 门面存取——本构造器经 gate.configure 注入下方 store 实现与 abort 能力。
 */
const userStoppedMarks = new Map<string, { source: ForceQuitSource; markedAt: number }>()

/** 宿主 Map 的存取实现（gate.configure 注入 + 测试直断言用）。 */
export const userStoppedMarkStore: UserStoppedMarkStore = {
  markUserStopped(sessionId: string, source: ForceQuitSource): void {
    userStoppedMarks.set(sessionId, { source, markedAt: Date.now() })
    console.warn(`[session-service] userStopped mark set (sessionId=${sessionId}, source=${source})`)
  },
  hasUserStoppedMark(sessionId: string): boolean {
    return userStoppedMarks.has(sessionId)
  },
  clearUserStoppedMark(sessionId: string): void {
    userStoppedMarks.delete(sessionId)
  },
  clearAllUserStoppedMarks(): void {
    userStoppedMarks.clear()
  },
}

export class SessionService implements ISessionService, ILifecycleSessionOps, IDispatcherSessionOps, IScannerSessionOps {
  /**
   * in-flight 恢复注册表已迁 pi-respawn 编排器（u8，D7-③ join 状态 SSOT——自动恢复与
   * 惰性恢复共享，join 语义见 RespawnOrchestrator.ensureRestored）。
   */
  private readonly lifecycle: SessionLifecycle
  private readonly dispatcher: MessageDispatcher
  private readonly scanner: SessionScanner
  /** 附件存储域（S1 迁出，零耦合子模块——无 Facade 状态依赖，故不注入 this） */
  private readonly attachmentStore = new AttachmentStore()
  /**
   * 状态投影域（S5 迁出至 session-state-projection.ts）：replicated states 快照投影族 +
   * context/usage 副作用域。onSessionRegistered 订阅者 = projection 自身（构造器组装期
   * 先于本 Facade 剩余订阅体注册，播种顺序与迁移前逐一等价）；销毁经 onSessionDisposed
   * 由 removeSessionEntry 第 ⑤ 步直调。
   */
  private readonly projection: SessionStateProjection
  /** trace/system-prompt 同步域（S4 迁出，构造器内组装 deps——见构造器注释） */
  private readonly traceSync: TraceSync
  /**
   * 模型/思考等级控制域（S6 迁出至 session-model-control.ts）：switchModel /
   * setThinkingLevel 的 RPC + 回执普查 + 实例失效 + 直写双投影。销毁无域状态（不持
   * per-session Map），无 onSessionDisposed。
   */
  private readonly modelControl: SessionModelControl
  /**
   * ConfigService 引用（组合根注入）。getReplaceSystemPrompt 委托用——
   * spawn pi 时透传用户配置的替换系统提示词。经 setter 注入而非构造参数，与
   * setModelContextWindowResolver 同模式，避免破坏 SessionService 的 18+ 测试调用点。
   * 未注入时 getReplaceSystemPrompt 返回 undefined（pi 走默认系统提示词）。
   */
  private configService: IConfigService | null = null
  /**
   * PresetService 引用（组合根注入）。getLaunchPresetOptions 委托用——
   * spawn pi 时按用户选定的 launch preset 构建 extension/skill/tool args。
   * 经 setter 注入（同 setConfigService 模式），未注入时 getLaunchPresetOptions
   * 返回 undefined（调用方 session-lifecycle fallback 到现有 getExtensionPaths/getSkillPaths）。
   * 见 pi-launch-presets 设计文档 §8.1。
   */
  private presetService: PresetService | null = null
  /**
   * U6：能力对账回调（组合根绑 modelService.reconcileModelCapabilities，附着路径调用）。
   */
  private modelCapabilityReconciler: ((sessionId: string) => Promise<unknown>) | null = null

  /**
   * W5：message.complete 广播回调（组合根注入 ReloadOrchestrator.onMessageComplete）。
   * 经 setter 注入（同 setConfigService 模式），避免构造参数环
   * （orchestrator 依赖 sessionService，sessionService 不能反向依赖 orchestrator 具体类型）。
   * 未注入时 message.complete 广播无额外副作用（reload 编排不生效）。
   */
  private onMessageComplete: ((sessionId: string) => void) | null = null
  /**
   * R3：session 删除回调（组合根注入 ReloadOrchestrator.clearPending）。
   * 主动 delete（lifecycle.delete）和进程异常退出（onSessionExit）均经 removeSessionEntry
   * 汇聚触发，清掉 pendingReload 残留（running session 入队后被删，永不发 message.complete）。
   */
  private onSessionDelete: ((sessionId: string) => void) | null = null
  /**
   * S3-W2：session 创建回调（PluginService 注入——session 事件注册表定向投递）。
   * 全部创建入口（lifecycle create/restoreSession/forkSession）经
   * notifySessionCreated 收敛触发。回调异常不外抛（创建主流程优先）。
   */
  private onSessionCreated: ((summary: SessionSummary) => void) | null = null
  /**
   * S3-W2：session 销毁回调（同上）。全部删除路径汇聚于 removeSessionEntry
   * （lifecycle.delete 主动删 / onSessionExit 进程退出 / restore 清场），触发点在彼处。
   *
   * D6a（integrity-hardening §3.6）：升级为回调列表。该槽原是单函数槽且已被
   * PluginService（didDestroy 投递）占用，挂起 UI 请求清理（server 的
   * extensionTimeoutMgr 汇聚清理）无处可挂——单槽语义下后注册者会覆盖前者。
   * 列表语义允许多方注册，既有注入方（PluginService）行为不变，逐个隔离异常。
   */
  private readonly onSessionDestroyedHandlers: Array<(summary: SessionSummary) => void> = []
  /**
   * MessageBus 引用（组合根注入，wave:runtime-wiring）。
   *
   * session 级消息（带 sessionId payload）单通道走 bus.publish（per-session 单调 seq +
   * ring buffer + 订阅者广播；wave:perf-w09 D1-2 删双写后唯一通道），全局消息（无 sessionId）
   * 仍走 broker.broadcast 盲广播。session 销毁时调 bus.clearSession 彻底清理
   * （removeSessionEntry 触发，所有删除路径汇聚处）。
   *
   * 经 setter 注入（同 setConfigService/setPresetService/setOnMessageComplete 模式），
   * 避免破坏 SessionService 的 25+ 测试构造调用点。未注入时所有 bus 调用 no-op（this.messageBus?.*）。
   */
  private messageBus: IMessageBus | null = null
  /**
   * 写 2 挂钩的投影专用 bus 视图缓存：getter 每次 publish 都会读，按底层 bus 身份
   * memoize（setMessageBus 晚期注入/替换后自动重建）。
   */
  private projectionBusView: { bus: IMessageBus; wrapped: IMessageBus } | null = null
  /**
   * composer-gen-stats（u3 写 2）：state_changed 发布后置 tap（重登记 sid→modelKey 映射
   * + 推新模型快照帧）。经 setter 注入（组合根绑 GenStatsService.onModelSwitched，
   * 同 setConfigService 模式——GenStatsService 依赖 sessionService，构造注入会成环）。
   * 未注入时挂钩 no-op（既有行为不变）。
   */
  private genStatsModelSwitchTap: ((sessionId: string, modelId: string) => void) | null = null
  /**
   * 后台任务数据域（background-task-sidebar，u-runtime-rpc 组装；实现在 u-runtime-svc）。
   *
   * 公有成员（非 ISessionService 接口面）：SessionMessageHandler 经 ctx 的结构化可选属性
   * （SessionHandlerContext.sessionService 交叉类型）读取 3 RPC 消费端口——组合根 server.ts
   * 的 ctx 字面量静态类型是 ISessionService，可选属性结构兼容使其零改动通过类型检查。
   *
   * 接线三件事（构造器组装 + removeSessionEntry 退订）：
   * ① onTasksChanged → publishBackgroundTasksUpdate：组装 backgroundTask:updated payload
   *    经 messageBus session 级 publish（单 payload 对象、sessionId 必带，规则 1/7）；
   * ② start()：2s mtime 轮询（D2 触发面①；事件钩子触发面②的组合根接线在 index.ts
   *    adapterFactory——EventAdapter 第三参，非本文件领地）；
   * ③ removeSessionEntry 汇聚点 unwatch（D8③，与 reaper 触发面 A 同挂点）。
   */
  readonly backgroundTasks: BackgroundTaskService
  /**
   * history 读编排域（S6 迁出至 history-rebuild-cache.ts）：getHistory 三分支重建
   * （缓存增量/RPC 全量/尾读降级）+ [u6] 游标翻页 + inflight 合并（getFullHistory 文件
   * 直读已随全量通路退役）。销毁经 onSessionDisposed 由 removeSessionEntry 第 ⑤ 步直调
   * （与 traceSync/projection/records 并列）。
   */
  private readonly historyReader: SessionHistoryReader
  /**
   * subagent/workflow 记录域（S6/D2③ 迁出至 session-records.ts）：W18 派生缓存族 +
   * 磁盘读侧/动作/引擎配置。onSessionRegistered 订阅者 = records 自身（构造器组装期
   * 注册顺序在 projection 之后、reconciler 之前——播种 → record 注册 → 对账，与迁移前
   * Facade 订阅体内顺序逐一等价）；销毁经 onSessionDisposed 由 removeSessionEntry
   * 第 ⑤ 步直调（与 traceSync/projection 并列）。
   */
  private readonly records: SessionRecords
  /**
   * pi 崩溃自动恢复编排（crash-resilience §3.3 D7，u8-pi-respawn）。构造器内组装（deps 窄
   * 注入，同 traceSync/records 形态），三条挂点：
   * - 调度 = 本构造器 pm.onSessionExit 链尾部（该链只对非主动退出通知；forceQuitSession
   *   在 dispatcher 手工编排、exit 事件被双层守卫拦截不经此链——挂错会把用户强制退出的
   *   session 自动复活，设计 A7 反向验收）；
   * - 取消 = removeSessionEntry 汇聚点（主动删 / 进程退出 / forceQuit / restore 清场全覆盖，
   *   与 bus.clearSession / reaper 同挂点先例）；
   * - 全量取消 = shutdown 序列（组合根 index.ts，先于 server.stop 内的 destroyAll）。
   * messageBus 经 getter 动态读（setMessageBus 晚期注入语义，同 registerDeps 模式——未注入
   * 时 publish no-op）。
   */
  private readonly respawn: RespawnOrchestrator
  /**
   * 销毁收敛链编排（T8 有限拆分 2026-09，行为保持抽取）：removeSessionEntry 汇聚链的
   * 编排段（D1 台账 → checkpoint/mirror 摘除 → … → bus.clearSession 全序列 + 跨文件 B5
   * 顺序约束说明）。顺序约束 SSOT 与 deps 接口（= 销毁扇出合作方清单）见
   * session-entry-removal.ts 文件头；本 Facade 只保留公开 wrapper（四路删除路径的调用面
   * 与测试 spyOn 锁定面不变）。构造器尾部组装（deps 闭包全部惰性动态读，组装位置仅求
   * 阅读顺序自然）。
   */
  private readonly entryRemoval: SessionEntryRemovalOrchestrator
  /**
   * per-sid 最近查看时间戳（idle pi reclamation 设计 D2 #6，u1b）。
   *
   * 存储位置钉死 session-service 侧 per-sid Map——形态先例 ActiveSessionResolver
   * （plugin-service/api/session-api.ts）：可注入实例持有状态，收口模块级可变全局
   * （测试隔离、随实例生命周期生灭）。写方 = session.switch 处理器（不依赖 RPC
   * touch——switch 不必然伴随 RPC 调用）；读方 = 空闲 reaper 的查看豁免判定
   * （u2，30 分钟窗口内不回收）。
   *
   * 不能用 MessageBus 订阅者信号替代：renderer 对侧栏 list 全量订阅
   * （useSessionStreamSync），hasSubscribers(sid) 恒真，reaper 会永不回收（设计 §1.1 事实 4）。
   *
   * 刻意不在本单元做删除清理：清理挂点 = lifecycle.delete（removeSessionEntry 汇聚
   * 点），该领地归 u2 的 session-lifecycle.ts（计划 R4 登记）；回收态保留条目是设计
   * 意图——非候选无害（豁免判定只会多豁免不会误杀），恢复后继续有效；量级每 sid 一个数字。
   */
  private readonly lastViewedAtBySession = new Map<string, number>()
  /**
   * 空闲回收占座（idle-pi-reclamation D6-2，u2）。u3 组合根经 setReclaimSeat 注入与
   * reaper/reclaimManagedSession 共享的同实例；缺省 null = 行为不变（ensureActive 无
   * 让路逻辑）——不破坏既有测试构造点（同 setConfigService 的 setter 注入模式）。
   */
  private reclaimSeat: ReclaimSeat | null = null
  constructor(
    private readonly pm: IProcessManager,
    private readonly broker: IMessageBroker,
    private readonly adapterFactory: (sessionId: string, send: (msg: ServerMessage) => void, cwd?: string) => IEventAdapter,
    private readonly projectRoot: string,
    private readonly extensionService: IExtensionService,
    private readonly configStore: IConfigStore,
    private readonly sessionStore: ISessionStore,
    private readonly gitInfoReader: IGitInfoReader,
    private readonly workspaceService: WorkspaceService,
    messageBus?: IMessageBus,
  ) {
    // 子模块注入 this(Facade 半构造时仅存引用,其方法在 Facade 完全构造后才被调用)。
    // registerDeps(S3/D2②):registerSession 装配依赖窄注入——send 闭包对晚期注入状态
    // (messageBus/onMessageComplete)经 getter 每次调用动态读,与原 Facade 内联闭包捕获
    // this 的语义逐字等价。
    const registerDeps: ISessionRegisterDeps = {
      adapterFactory: this.adapterFactory,
      getMessageBus: () => this.messageBus,
      broadcastGlobal: (msg) => this.broker.broadcast(msg),
      notifyMessageComplete: (sessionId) => this.onMessageComplete?.(sessionId),
    }
    this.lifecycle = new SessionLifecycle(this, this.pm, this.configStore, this.sessionStore, this.workspaceService, registerDeps, {
      // D4：restore-abort 失败（abort RPC 超时/断链）的强杀收敛兜底——复用 dispatcher.forceQuit
      // （幂等：进程已死时成功返回；进程活着时走 forceQuitSession 完整收敛链 = K 语义日志 +
      // 置标记 + 全复位广播）。闭包惰性求值：lifecycle 先于 dispatcher 构造，调用发生在
      // restore 时（dispatcher 已就绪）。
      forceQuitFallback: (sessionId) => this.dispatcher.forceQuit(sessionId),
    })
    // D4 收敛环接线：宿主 Map 存取（上方 store）+ abort 能力（dispatcher.abort 完整链——
    // 成功收口广播 / 失败超时强杀收敛）。gate 未 configure 时全部 no-op/抛错，本构造器是
    // 生产唯一接线点（测试可经 resetForTest + 局部 configure 替换）。
    // [U2 修复] source='convergence'：收敛环掐的是 runtime 自动收敛的补发 turn（非用户
    // 操作），终态 reason 写 'Convergence abort (auto)' 与用户 abort 可区分（日志/终态
    // 不得谎报用户语义；aborted 完成帧广播保持不变——前端 no-op）。
    userStoppedGate.configure({
      marks: userStoppedMarkStore,
      abortSession: (sessionId) => this.dispatcher.abort(sessionId, 'convergence'),
    })
    // trace/system-prompt 同步域（S4 迁出至 trace-sync.ts）：deps 窄注入——session 查询经
    // lifecycle（Map 所有者）只读面，messageBus 经 getter 每次调用动态读（setter 晚期注入
    // 语义与原 Facade 字段直读逐字等价，未注入时广播 no-op）。
    this.traceSync = new TraceSync({
      pm: this.pm,
      sessionStore: this.sessionStore,
      getSession: (sessionId) => this.lifecycle.get(sessionId),
      getMessageBus: () => this.messageBus,
    })
    // 模型控制域（S6 迁出至 session-model-control.ts）：deps 窄注入——session 定位经
    // lifecycle 只读面、实例失效经 projection、trace 补拉经 traceSync（全部既有公有面）。
    this.modelControl = new SessionModelControl({
      pm: this.pm,
      getSession: (sessionId) => this.lifecycle.get(sessionId),
      getReplicatedStates: (sessionId) => this.projection.getReplicatedStates(sessionId),
      syncTraceEntries: (sessionId, trigger) => this.traceSync.syncTraceEntries(sessionId, trigger),
    })
    // history 读编排域（S6 迁出至 history-rebuild-cache.ts）：deps 窄注入——pm（活跃判定
    // + RPC client）与 sessionStore（重建/尾读/全量文件读转换链），无私有状态耦合。
    this.historyReader = new SessionHistoryReader({
      pm: this.pm,
      sessionStore: this.sessionStore,
    })
    // 状态投影域（S5 迁出至 session-state-projection.ts）：deps 窄注入——session 查询经
    // lifecycle（Map 所有者）只读面，messageBus 经 getter 每次调用动态读（setter 晚期注入
    // 语义与原 Facade 字段直读逐字等价）；fetchContext / persistSessionOutcome /
    // tryPersistProjectBinding 留 Facade（ISessionService 契约 / dispatcher 窄接口单一实现 /
    // 私有 helper），经回调闭包注入（registerDeps 同款模式）。
    this.projection = new SessionStateProjection({
      pm: this.pm,
      getSession: (sessionId) => this.lifecycle.get(sessionId),
      hasSession: (sessionId) => this.lifecycle.has(sessionId),
      // composer-gen-stats（u3 写 2）：投影用带 state_changed 后置 tap 的 bus 视图（其余
      // 消费方 registerDeps/traceSync/records 保持裸 bus——tap 只需挂在真汇聚点上）
      getMessageBus: () => this.getProjectionBusWithGenStatsTap(),
      fetchContext: (sessionId) => this.fetchContext(sessionId),
      persistSessionOutcome: (sessionId, outcome, reason) => this.persistSessionOutcome(sessionId, outcome, reason),
      tryPersistProjectBinding: (session) => this.tryPersistProjectBinding(session),
      tryPersistModelBinding: (session) => this.tryPersistModelBinding(session),
    })
    // subagent/workflow 记录域（S6 迁出至 session-records.ts）：deps 窄注入——session 存在性
    // 经 lifecycle（Map 所有者）只读面，messageBus 经 getter 每次调用动态读（setter 晚期注入
    // 语义与原 Facade 字段直读逐字等价）。
    // [W8] deprecated 死键 getExtensionPaths 已删除（W4 冷启动回退源单源化为
    // readDiscoveredEnginesFallback 后无消费方，构造点随 W8 宿主接线同批收口）。
    this.records = new SessionRecords({
      pm: this.pm,
      sessionStore: this.sessionStore,
      hasSession: (sessionId) => this.lifecycle.has(sessionId),
      getMessageBus: () => this.messageBus,
    })
    // pi 崩溃自动恢复编排组装（u8，D7）：restore 复用既有惰性恢复内核（facade.restoreSession
    // → lifecycle.restoreSession，附着自动走 u4c 预算化 restore 路径——⑤档超阈值走逆序分块
    // 最小规范化（流式 strip + 首行 cwd fallback，见 restore-seeding.normalizeLargeSessionFileMinimal）。
    this.respawn = new RespawnOrchestrator({
      // isActive 守卫走可选调用：挂点在崩溃收敛链（onSessionExit）内，任何异常都会打断
      // exitCallbacks 多播——守卫是 best-effort 优化（attemptRespawn 触发时还有复查 +
      // restore 失败链兜底），port 缺失时按「不活跃」继续，不让守卫本身成为新故障源。
      isActive: (sessionId) => this.pm.hasClient?.(sessionId) ?? false,
      restore: (sessionId) => this.restoreSession(sessionId),
      publish: (sessionId, msg) => this.messageBus?.publish(sessionId, msg),
    })

    // 创建侧订阅接线(组装根,S3 seam→S5/S6 换订阅者,设计 D2②):onSessionRegistered 同步直发按
    // 订阅顺序执行——projection 先订阅(W7 播种,registerReplicatedStates)→ records 订阅
    // (ensureRecordEntriesCache(W18))→ reconciler 对账(U6,fire-and-forget .catch 降级——现状
    // 如此)。订阅扇出不设异常隔离、异常直接传播(与迁移前 Facade 订阅体内顺序调用等价)。
    this.projection.subscribe(this.lifecycle)
    this.records.subscribe(this.lifecycle)
    this.lifecycle.onSessionRegistered((sessionId) => {
      // U6（D2②）：session 附着触发能力对账（getAvailableModels vs 配置聚合，drift 经
      // setCapabilityDriftSink 上报 + runtime 日志）。一次调用，fire-and-forget——对账是
      // 纯旁路诊断，失败绝不阻断附着（内部已降级，catch 双保险）。
      if (this.modelCapabilityReconciler) {
        this.modelCapabilityReconciler(sessionId).catch(() => { /* 降级吞错：附着主链路优先 */ })
      }
    })
    // D3 checkpoint（crash-forensics §3.3 D3，u4）attach / respawn 成功挂点：onSessionRegistered
    // 是 create / restore（含自动 respawn 与惰性恢复）/ fork 三入口的注册汇聚点（session-lifecycle
    // registerSession 在 sessions.set 之后同步直发），**一个挂点覆盖四类事件中的全部「附着」
    // 形态**——respawn 成功即 pi 重新附着，无需在 restore 链路另设挂点（单一收敛点 = 无双写）。
    // 元数据取既有读面：filePath/occupancy 来自 lifecycle 条目，lastActivityAt 取 pi client
    // 空闲信号（u1a，attach 瞬间读不到则用本模块时钟兜底），lastViewedAt 取 per-sid 查看表。
    // 台账/checkpoint 都是旁路设施，本订阅体自带异常隔离（异常不外抛——否则会打断
    // registerSession 主链，把旁路故障放大成创建/恢复失败）。
    this.lifecycle.onSessionRegistered((sessionId) => {
      try {
        const session = this.lifecycle.get(sessionId)
        const occupancy = session?.occupancy
        getRuntimeCheckpointStore().upsertSession({
          sessionId,
          filePath: session?.sessionFilePath ?? null,
          activityAt: this.pm.getClient(sessionId)?.lastActivityAt,
          viewedAt: this.getSessionLastViewedAt(sessionId),
          occupancy: occupancy && (occupancy.turn !== 'idle' || occupancy.compacting || occupancy.bash)
            ? 'occupied'
            : 'idle',
        })
      } catch (e: unknown) {
        // best-effort 降级：checkpoint 是崩溃恢复的旁路设施，写入异常绝不外抛——
        // 外抛会打断 registerSession 主链，把旁路故障放大成创建/恢复失败。
        console.error(`[session-service] checkpoint attach update failed (sessionId=${sessionId}):`, e)
      }
    })
    // D5 mirror 预置 0（crash-forensics §3.3 D5，偏差 #20 接线）：五 spawn 形态（新 session /
    // respawn / reattach / lazy restore / fork）的条目建立腿——与上一挂点同一 registerSession
    // 收敛面（fork 产生新 sessionId，同点覆盖），一挂点覆盖全部附着形态。presetZero = 新
    // reporting epoch（inFlight=0 + 清 hasEverReported，不触碰 injected——spawn 装配顺序
    // 无关，语义见 inflight-mirror.ts 文件头）。独立第二订阅而非并入 checkpoint 订阅体：
    // 两个旁路设施各自 best-effort 异常隔离，故障日志可归因、互不放大。
    this.lifecycle.onSessionRegistered((sessionId) => {
      try {
        inflightMirror.presetZero(sessionId)
      } catch (e: unknown) {
        // best-effort 降级：mirror 是 errs 判别的旁路设施，预置异常绝不外抛——
        // 外抛会打断 registerSession 主链，把旁路故障放大成创建/恢复失败。
        console.error(`[session-service] mirror preset failed (sessionId=${sessionId}):`, e)
      }
    })
    this.dispatcher = new MessageDispatcher(this, this.pm, this.workspaceService, messageBus)
    this.scanner = new SessionScanner(this, this.sessionStore, this.gitInfoReader)

    // 后台任务域组装（u-runtime-rpc①②）：广播回调经 this.messageBus 动态读（getter 语义，
    // 与 registerDeps/traceSync 的晚期注入同款——setMessageBus 后置注入前触发时 publish
    // no-op；组合根在 setServices 前注入 bus，晚于首个 2s 轮询拍）。piAgentDir 用默认
    // getPiAgentDir() 动态推导（生产正确；测试经 vi.mock pi-paths 指向 tmp）。
    this.backgroundTasks = new BackgroundTaskService({
      onTasksChanged: (sessionId) => this.publishBackgroundTasksUpdate(sessionId),
    })
    this.backgroundTasks.start()

    // 销毁收敛链编排组装（T8 有限拆分）：deps 窄注入 = 销毁扇出合作方清单（逐项语义见
    // SessionEntryRemovalDeps docstring）。晚期注入状态（messageBus / onSessionDelete /
    // onSessionDestroyedHandlers）经闭包每次调用动态读——setter 后置注入语义与原字段直读
    // 逐字等价；模块单例（crash journal / checkpoint / mirror / gate / reaper）由编排器
    // 直接 import，不经本组装面。
    this.entryRemoval = new SessionEntryRemovalOrchestrator({
      getSession: (sessionId) => this.lifecycle.get(sessionId),
      removeEntry: (sessionId) => this.lifecycle.removeEntry(sessionId),
      toSummary: (session) => this.toSummary(session),
      cancelRespawn: (sessionId) => this.respawn.cancel(sessionId),
      clearSessionViewed: (sessionId) => this.clearSessionViewed(sessionId),
      fireOnSessionDelete: (sessionId) => this.onSessionDelete?.(sessionId),
      getOnSessionDestroyedHandlers: () => this.onSessionDestroyedHandlers,
      unwatchBackgroundTasks: (sessionId) => this.backgroundTasks.unwatch(sessionId),
      disposeHistoryReader: (sessionId) => this.historyReader.onSessionDisposed(sessionId),
      disposeTraceSync: (sessionId) => this.traceSync.onSessionDisposed(sessionId),
      disposeProjection: (sessionId) => this.projection.onSessionDisposed(sessionId),
      disposeRecords: (sessionId) => this.records.onSessionDisposed(sessionId),
      clearMessageBusSession: (sessionId) => this.messageBus?.clearSession(sessionId),
    })

    // 进程崩溃清理:协调 adapter detach / Map 删 / 列表刷新 / session.exited 广播
    this.pm.onSessionExit((sessionId, code, stderr) => {
      const session = this.lifecycle.get(sessionId)
      if (!session) return
      // D1 台账（crash-forensics §3.3 D1 写入点矩阵「pi crash」行）：onSessionExit 链是 pi
      // 意外死亡的唯一通知路径（intentional destroy 被 process-manager 进程表守卫拦截不经
      // 此链），在此记 crash 与既有 session.exited 推送同点双写。stderr 为 rpc-client 透传的
      // 尾部 10 行摘要（getStderrTail 同源形态）；exitCode=null 表达信号致死（回调链不携带
      // signal 名，digest 兜底行注明形态）。fire-and-forget，不阻塞死亡清理链。
      getCrashJournal().append({
        layer: 'pi',
        event: 'crash',
        sessionId,
        exitCode: code,
        detailDigest: buildCrashDetailDigest(code, stderr),
      })
      session.adapter.detach()

      // 构建人类可读的退出原因（含 stderr 尾部，诊断价值 > 敏感性风险，本地工具场景）
      const reason = stderr
        ? `Session process exited (code: ${code})\n\n${stderr}`
        : `Session process exited (code: ${code})`

      // wave:perf-w07（D1-1）：session.exited 补 bus publish（stream 类：分配 seq 入 ring）。
      // 顺序约束：必须在 removeSessionEntry 之前——它内部调 bus.clearSession 清订阅者集合，
      // clearSession 之后再 publish 等于送空集合，订阅 renderer 一条也收不到（进程退出标记
      // dead + toast 丢失）。wave:perf-w09（D1-2）：broadcast 腿已删，publish 是唯一通道
      //（renderer 全量订阅覆盖 list 内全部 session，见 useSessionStreamSync）。
      const exitedMsg: ServerMessage = { type: 'session.exited', payload: { sessionId, code, reason } }
      this.messageBus?.publish(sessionId, exitedMsg)

      // occupancy #10（session-dead-structural-fixes D2 挂点迁移，u3b；失败路径进程异常退出腿）：
      // 占用中 pi 死亡时 agent_settled / compaction_end 永不会发出（二者只从 pi run/compact
      // finally 触发），'full-reset' 行兜底——turn/compacting/bash 三维全复位 + 三布尔派生同步
      // 复位（结构上不再有「只复位一边」），否则重连 renderer 经 stateSnapshot 回放恢复的是
      // 永久的占用投影。须在 removeSessionEntry（内部 bus.clearSession）之前。
      applySessionOccupancyTransition(session, this.messageBus, 'full-reset')

      // 注意：此处 session 是 delete 前缓存的引用，removeSessionEntry 后 Map 条目已删除
      // 统一经 removeSessionEntry（触发 onSessionDelete 清 pendingReload 等残留）
      this.removeSessionEntry(sessionId)

      // W4：进程异常退出写 stopped 终态（在 Map 条目删除后，直接用已取的 session 对象，
      // 不走 persistSessionOutcome 的内部 get——删除后 get 返回 undefined）
      if (session.sessionFilePath) {
        // W2-5/W8：已有任意终态（done/error/stopped）则不覆盖。
        // 正常 turn 完成时 handleTurnEndSideEffects 已写 'done'；随后 pi 进程正常退出触发本回调，
        // 此处若再写 'stopped' 会覆盖已写入的 'done'。进程退出是正常结束的副作用，非用户中止。
        // W8：abort 路径 dispatcher 已写 'stopped' + 原始 abort reason，随后进程退出触发本回调时，
        // 若再次用「Process exited (code: N)」覆盖，会丢失 dispatcher 写入的原始 abort reason——
        // 第一个终态优先（abort 是用户主动行为，reason 比 process exit 更具诊断价值）。
        const existingOutcome = this.sessionStore.extractSessionOutcome(session.sessionFilePath)
        if (existingOutcome !== 'done' && existingOutcome !== 'error' && existingOutcome !== 'stopped') {
          this.sessionStore.persistSessionEnd(
            session.sessionFilePath,
            'stopped',
            `Process exited (code: ${code})`,
          )
        }
      }

      this.broker.broadcast({ type: 'config.sessions', payload: { groups: this.listPersistedSessions() } })
      // session.exited（独立事件，区别于 message.error 的「单次消息失败」语义）：
      // 前端据此标记 session dead 态 + 插入 error 消息 + toast 提示。
      //（wave:perf-w09：exitedMsg 的 broadcast 腿已删——session 级单通道，上方 publish 唯一出口。）

      // u8（crash-resilience D7-①②）：非主动退出 → 5s 延迟自动恢复。挂在本链（而非
      // session.exited 消息生产点）是设计裁决：本链天然不含 forceQuitSession（dispatcher
      // 手工编排 + exit 事件双层守卫拦截）与 intentional destroy（process-manager 按
      // processes.has 拦截）——用户手动强制退出的 session 构性不触发自动恢复（A7 反向验收）。
      // 启动前守卫（active / restoringSessions in-flight / 熔断）在 schedule 内。
      this.respawn.schedule(sessionId)
    })
  }

  /**
   * 注入 ConfigService（组合根在所有服务构造后调用）。
   * getReplaceSystemPrompt 委托用——spawn pi 时透传用户配置的替换系统提示词。
   */
  setConfigService(configService: IConfigService): void {
    this.configService = configService
  }

  /**
   * 注入 PresetService（组合根在所有服务构造后调用）。
   * getLaunchPresetOptions 委托用——spawn pi 时按 launch preset 构建 args。
   * 与 setConfigService 同模式（setter 注入，避免破坏现有测试构造点）。
   */
  setPresetService(presetService: PresetService): void {
    this.presetService = presetService
  }

  /** W5：注入 message.complete 回调（组合根绑 ReloadOrchestrator.onMessageComplete）。 */
  setOnMessageComplete(handler: (sessionId: string) => void): void {
    this.onMessageComplete = handler
  }

  /** R3：注入 session 删除回调（组合根绑 ReloadOrchestrator.clearPending）。 */
  setOnSessionDelete(handler: (sessionId: string) => void): void {
    this.onSessionDelete = handler
  }

  /** S3-W2：注入 session 创建回调（PluginService 绑 session 事件注册表投递）。 */
  setOnSessionCreated(handler: (summary: SessionSummary) => void): void {
    this.onSessionCreated = handler
  }

  /**
   * S3-W2：注入 session 销毁回调（触发点 removeSessionEntry）。
   * D6a：追加式注册（非覆盖）——回调列表语义，PluginService 的 didDestroy 投递与
   * transport 层的挂起 UI 请求清理（server.ts setServices 注册）互不挤占。
   */
  setOnSessionDestroyed(handler: (summary: SessionSummary) => void): void {
    this.onSessionDestroyedHandlers.push(handler)
  }

  /**
   * U6（D2② 在线对账）：注入能力对账回调（组合根绑 modelService.reconcileModelCapabilities）。
   * session 附着路径（registerSession 的 onSessionRegistered 订阅,S3 前为 initializeManagedSession
   * 体内调用）fire-and-forget 调用——失败不阻断附着（内部降级：引擎不可用 / RPC 失败一律
   * 返回空）。窄回调签名避免 SessionService 反向持有 ModelService 引用（modelService 依赖
   * sessionService，构造注入会成环）。
   */
  setModelCapabilityReconciler(reconciler: (sessionId: string) => Promise<unknown>): void {
    this.modelCapabilityReconciler = reconciler
  }

  /**
   * 注入 MessageBus 单例（组合根在所有服务构造后调用，wave:runtime-wiring）。
   *
   * session 级消息（带 sessionId payload）单通道走 bus.publish（wave:perf-w09 D1-2 删双写后
   * 唯一通道）；session 销毁时 removeSessionEntry 调 bus.clearSession。未注入时所有 bus 调用
   * no-op，与 setConfigService/setOnMessageComplete 同模式（nullable 注入，不破坏现有测试构造点）。
   *
   * bus 有两条注入通道：①构造参数（index.ts 构造 SessionService 时传入，经构造器传导给
   * dispatcher）；②本 setter（后置注入）。走 ② 时 dispatcher 已在构造器中创建（持有旧 bus
   * 或 undefined），故此处必须同步回填 dispatcher.setMessageBus——否则 dispatcher 的全部
   * session 级发布静默 no-op（null-safe 但消息丢失）。组合根两条通道都走（幂等：回填同一
   * 引用无副作用）。
   */
  setMessageBus(bus: IMessageBus): void {
    this.messageBus = bus
    this.dispatcher.setMessageBus(bus)
  }

  /**
   * composer-gen-stats（u3 写 2，MF9 固定帧序）：注入「state_changed 发布后置 tap」。
   * 投影每次 publish session.state_changed 后同步调 tap(sid, modelId)——tap 内重登记
   * GenStatsService 的 sid→modelKey 映射并推新模型快照帧。帧序构造性成立：bus.publish
   * 同步完成 WS 送达后才进 tap（单 WS 连接有序送达：先 state_changed → 后 stats_update），
   * 插件路径 renderer 的 modelId 先由 state_changed 帧更新，快照帧不会被前端校验误丢。
   */
  setGenStatsModelSwitchTap(tap: (sessionId: string, modelId: string) => void): void {
    this.genStatsModelSwitchTap = tap
  }

  /**
   * 投影专用 bus 视图：透传全部 IMessageBus 方法，仅在 publish session.state_changed
   * 后同步触发写 2 tap（重登记+推快照帧）。全 runtime 唯一 state_changed 生产点 =
   * 投影的 publishStateChangedFromSnapshot（publish 前有同值 diff 抑制），故「bus 边界
   * 拦截该 type」≡「在 state_changed 广播处挂接」——不触碰 session-state-projection.ts
   * 即可拿到真汇聚点（composer-gen-stats 设计 D4 写 2 挂接点的实装核实结论）。
   */
  private getProjectionBusWithGenStatsTap(): IMessageBus | null {
    if (!this.messageBus) return null
    if (this.projectionBusView?.bus !== this.messageBus) {
      const bus = this.messageBus
      // wrapped 构建迁 projection-bus-view.ts（createProjectionBusView，行为保持抽取）；
      // tap 闭包保留动态读 this.genStatsModelSwitchTap（晚期注入语义与原内联逐字等价）。
      this.projectionBusView = {
        bus,
        wrapped: createProjectionBusView(
          bus,
          (sessionId, modelId) => this.genStatsModelSwitchTap?.(sessionId, modelId),
        ),
      }
    }
    return this.projectionBusView.wrapped
  }

  // ── ISessionService:纯委托(lifecycle / dispatcher / scanner)─────

  async create(cwd?: string, label?: string, options?: SessionCreateOptions): Promise<SessionSummary> { return this.lifecycle.create(cwd, label, options) }
  async delete(sessionId: string): Promise<void> { return this.lifecycle.delete(sessionId) }
  async deleteByCwd(cwd: string): Promise<BatchDeleteResult> { return this.lifecycle.deleteByCwd(cwd) }
  async renameSession(sessionId: string, newName: string): Promise<void> { return this.lifecycle.renameSession(sessionId, newName) }
  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const summary = await this.lifecycle.restoreSession(sessionId)
    // u8（crash-resilience D7 熔断语义）：任一恢复成功（自动 respawn / 用户手动 / 惰性
    // ensureActive）→ 清零连续失败计数，保证未来崩溃获得全新自动恢复额度（熔断只针对
    // 连续失败，成功即出清；唯一清零入口，与 pi-respawn.cancel 只清 timer 不清计数配套）。
    this.respawn.notifyRestored(sessionId)
    return summary
  }
  async forkSession(
    srcSessionId: string,
    fromPiEntryId: string | undefined,
    includeFrom: boolean,
    label?: string,
    opts?: {
      fromMessageTimestamp?: number
      fromMessageRole?: string
      /** Staging Mode（ADR-0056）：composer 暂存的模型覆盖，优先于源 preset.modelOverride。 */
      modelOverride?: string
      /** Staging Mode（ADR-0056）：composer 暂存的思考等级覆盖，优先于源 preset.thinkingLevel。 */
      thinkingOverride?: string
    },
  ): Promise<SessionSummary> {
    // 编排半截（find 合并 + timestamp 解析）S6 迁入 lifecycle.forkSession（始与终同模块，
    // 失败模式 B 消除）；本委托透传原始参数，语义详见 session-lifecycle.ts。
    return this.lifecycle.forkSession(srcSessionId, fromPiEntryId, includeFrom, label, opts)
  }

  async sendMessage(sessionId: string, content: string, images?: Array<{ data: string; mimeType: string }>, clientUuid?: string): Promise<{ blocked: boolean; rejected?: boolean }> { return this.dispatcher.sendMessage(sessionId, content, images, clientUuid) }
  // [HISTORICAL] sendSubagentMessage（marker 半成品通道）已删除（composer 四符号设计 D2）：
  // base64 隐藏注释前缀在 extension 侧零消费方，且经主 agent 转发违背
  // 「直达 subagent」目标——定向消息改走 subagentAction(message/start)。
  async abort(sessionId: string): Promise<void> { return this.dispatcher.abort(sessionId) }
  /** 强制退出卡死 session（sidebar 右键入口，杀 pi 进程 + stopped 收敛）。 */
  async forceQuit(sessionId: string): Promise<void> { return this.dispatcher.forceQuit(sessionId) }
  async sendBash(sessionId: string, command: string, excludeFromContext?: boolean): Promise<{ blocked: boolean; rejected?: boolean }> {
    return this.dispatcher.sendBash(sessionId, command, excludeFromContext)
  }
  async abortBash(sessionId: string): Promise<{ sent: boolean }> { return this.dispatcher.abortBash(sessionId) }
  /**
   * W1（fix-chat-flow-order 探针 ②）：run 级联结束（pi agent_settled，晚于 pi finally 的
   * bash 落盘 flush）→ dispatcher 按序发布 per-session bash 待落列（D2 双分支延迟的 flush 腿）。
   * 经 EventInterpreter.onAgentSettled 回调注入（组合根 index.ts）。
   */
  flushPendingBashResults(sessionId: string): void { this.dispatcher.flushPendingBashResults(sessionId) }
  async steerMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.steerMessage(sessionId, content) }
  async followUpMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.followUpMessage(sessionId, content) }
  async compact(sessionId: string, customInstructions?: string): Promise<void> { return this.dispatcher.compact(sessionId, customInstructions) }
  setSendMessageHook(hook: SendMessageHook): void { this.dispatcher.setSendMessageHook(hook) }
  listPersistedSessions(): SessionGroup[] { return this.scanner.listPersistedSessions() }

  // ── ISessionService:Facade 直接实现(查 sessions / 经 rpc,轻量)─────

  /** 切换模型（实现迁 session-model-control.ts：set RPC + 回执普查 + 三实例失效 + 直写）。 */
  async switchModel(sessionId: string, provider: ProviderId, modelId: string): Promise<string> { return this.modelControl.switchModel(sessionId, provider, modelId) }
  /** 设置思考档并返回 pi 生效值（实现迁 session-model-control.ts：钳制读回 + 直写）。 */
  async setThinkingLevel(sessionId: string, level: string): Promise<string> { return this.modelControl.setThinkingLevel(sessionId, level) }

  /**
   * 更新活跃 session 的 label（内存态）——session_info_changed 事件路径的唯一写方（PR #185 MF1）。
   *
   * 调用方：pi session_info_changed 事件到达时（pi extension auto-rename，经组合根
   * onSessionRenamed 回调）。另一写方 = renameSession 活跃分支（set_session_name RPC
   * 成功后直写 session.label，见 session-lifecycle.ts，两者写点同源 pi 权威）。
   * 不持久化——pi 侧已写 session_info，此处只同步内存态（toSummary/config.sessions
   * 的即时数据源）。label 的 ReplicatedState 实例已撤销（.get() 零消费、拉取纯浪费
   * RPC，见 SessionReplicatedStates 注释 [HISTORICAL] 段）。
   */
  setLabelCache(sessionId: string, label: string): void {
    const session = this.lifecycle.get(sessionId)
    if (session) session.label = label
  }

  hasActiveSession(sessionId: string): boolean { return this.pm.hasClient(sessionId) }

  /** 活跃 session id 列表（含公共 session，供 SkillRegistry 计算 skill 变更广播范围）。 */
  getActiveSessionIds(): string[] {
    return Array.from(this.lifecycle.keys())
  }

  /** 取 session cwd（未激活/不存在返回 undefined，供 SkillRegistry 按项目 skill 变更定位受影响 session）。 */
  getSessionCwd(sessionId: string): string | undefined {
    return this.lifecycle.get(sessionId)?.cwd
  }

  /**
   * 可能返回已死 client（exited=true），业务入口（prompt / subagent / auto-restore）
   * 应走 ensureActive（死 client 视同无 client 走 restore）；直接调用方需自行处理 exited
   * （handoff-service 等依赖裸 client 观察 exited，故本方法不改语义只标注契约）。
   */
  getRpcClient(sessionId: string): IPiEngine | undefined { return this.pm.getClient(sessionId) }

  /**
   * W7/W8：per-session 实例组访问器。消费方：
   * - 组合根（index.ts）：interpreter 的失效回调延迟解析（markDirty，thinkingLevel）；
   * - session-service 自身（W8）：usage / commands 失效接线（applyContextUpdate /
   *   getCommands）；
   * - 测试：断言 switchModel 后 modelId 实例 markDirty、事件路径写点后 usage/commands markDirty。
   * session 未注册（非活跃 / 已销毁）返回 undefined，调用方安全跳过。
   * 方法名沿用 W7 的 ScalarReplicatedStates 语义（index.ts 组合根接线稳定，四实例后为
   * 全量实例组访问器——结构收窄不破坏既有消费方）。
   */
  getScalarReplicatedStates(sessionId: string): SessionReplicatedStates | undefined {
    return this.projection.getReplicatedStates(sessionId)
  }

  // ── lastViewedAt 查看时间戳（idle pi reclamation D2 #6，u1b；存储语义见字段注释）──

  /** 记录一次查看（session.switch 处理器调用；时间戳 = 记录时刻）。 */
  markSessionViewed(sessionId: string): void {
    this.lastViewedAtBySession.set(sessionId, Date.now())
  }

  /**
   * 查询最近查看时间戳。未记录的 sid 返回 undefined——reaper 豁免判定侧语义为
   * 「从未被查看」（等同长期空闲），不是 0（0 是合法的 epoch 时间戳，误用会豁免全部 session）。
   */
  getSessionLastViewedAt(sessionId: string): number | undefined {
    return this.lastViewedAtBySession.get(sessionId)
  }

  /**
   * 删除查看时间戳条目（R4 清理挂点：removeSessionEntry 汇聚点调用）。真删除时清条目；
   * 回收态（reclaimManagedSession）刻意**不**清——回收态保留条目是设计 D2 #6 意图：
   * 非候选无害（豁免判定只会多豁免不会误杀），恢复后继续有效。
   */
  clearSessionViewed(sessionId: string): void {
    this.lastViewedAtBySession.delete(sessionId)
  }

  /**
   * 查询 session 占用状态投影（idle pi reclamation D2 #1 豁免信号，u3a 只读访问器）。
   *
   * occupancy 是运行时内部态（IManagedSessionView.occupancy，事件驱动幂等投影，
   * 唯一写方 updateSessionOccupancy；不进 toSummary——对外只经 session.occupancy
   * state 帧），本方法是其唯一外部只读读点：委托 lifecycle Map（所有权在 lifecycle，
   * S3 单写者约定）取条目读字段。
   * 未附着 / 已摘除（含回收后）返回 undefined——reaper 侧语义「无条目即无占用信号」，
   * 回收安全由 reclaimManagedSession 的最终同步豁免块兜底（与 getClientActivity 的
   * 「宁漏不误杀」同向）。
   */
  getSessionOccupancy(sessionId: string): SessionOccupancy | undefined {
    return this.lifecycle.get(sessionId)?.occupancy
  }

  /**
   * 查询 session 是否处于 restore 进行中（idle pi reclamation D2 #7 豁免信号，u3b 装配）。
   *
   * 恢复注册表的所有权在 RespawnOrchestrator（u8 join 状态 SSOT），其实例是本类 private
   * 字段——本方法是其唯一外部只读读点（与上方 getSessionOccupancy 同构的薄委托：内部态
   * 无公开访问器时在 Facade 加只读口，组合根 reaper 豁免装配消费）。
   */
  isSessionRestoring(sessionId: string): boolean {
    return this.respawn.isRestoring(sessionId)
  }

  /**
   * 注入空闲回收占座（idle-pi-reclamation D6-2，u3 组合根装配）。必须传与 reaper 判定
   * 循环 / reclaimManagedSession 相同的 ReclaimSeat 实例——三处共享同一互斥状态。
   */
  setReclaimSeat(seat: ReclaimSeat): void {
    this.reclaimSeat = seat
  }

  /**
   * 空闲回收执行入口（u3 装配：reaper options.reclaim 绑定本方法）。委托 lifecycle 的
   * 七步最小摘除编排——进程处置语义收口在 Map 所有者（D3），Facade 只做一行委托。
   * 返回 false = 未回收（占座被占 / 最终豁免拦截 / 代际校验取消）。
   *
   * D3 checkpoint（u4）reclaim 成功挂点：回收**不是销毁**（removeSessionEntry 刻意不经
   * 此路径），但该 session 已摘出活跃 Map → 不再属「活跃 session 清单」，从 checkpoint
   * 摘除条目（文件本身不删——删除属主在 main 退出链与 u5 reattach 编排）。挂 ok 分支：
   * 未回收路径零改动，防误摘（与 reclaimed 台账行同抑制语义）。
   */
  async reclaimSession(sessionId: string, deps: ReclaimSessionDeps): Promise<boolean> {
    const reclaimed = await this.lifecycle.reclaimManagedSession(sessionId, deps)
    if (reclaimed) {
      try {
        getRuntimeCheckpointStore().removeSession(sessionId)
      } catch (e: unknown) {
        // best-effort 降级：摘除条目失败不影响回收主流程（回收已完成的事实不变）。
        console.error(`[session-service] checkpoint reclaim removal failed (sessionId=${sessionId}):`, e)
      }
      // D5 mirror（偏差 #20 接线）：回收 ≠ 销毁（刻意不经 removeSessionEntry 汇聚点）但该
      // session 已摘出活跃清单，mirror 条目与 checkpoint 同语义同步摘除；恢复后经预置 0
      // 重建（新 reporting epoch）。挂 ok 分支：未回收路径零改动，防误摘（与 checkpoint 同型）。
      try {
        inflightMirror.dropSession(sessionId)
      } catch (e: unknown) {
        // best-effort 降级：摘除条目失败不影响回收主流程（回收已完成的事实不变）。
        console.error(`[session-service] mirror reclaim removal failed (sessionId=${sessionId}):`, e)
      }
    }
    return reclaimed
  }

  // ── W18：record entry 派生缓存（S6 迁出至 session-records.ts；interpreter 经组合根
  // index.ts:406 经本委托到达——u-s5 同款形态）──

  /** W18：record entry 失效信号入口（实现迁 session-records.ts，防抖与 cursor 三路径详见该模块）。 */
  invalidateRecordEntries(sessionId: string, customType: string): void {
    return this.records.invalidateRecordEntries(sessionId, customType)
  }

  /**
   * 确保会话活跃;不存在则自动 restore。
   *
   * 并发语义（crash-resilience D7-③，u8 join 改造）：[HISTORICAL] 原对并发调用直接
   * throw「already being restored」——自动恢复落地后恢复窗口内用户发消息是常态路径
   * （T4：恢复进行中用户发消息 → 等待恢复完成后继续，不报错不双跑）。现改为 join：
   * 并发调用等待同一 in-flight Promise（只 spawn 一个 pi）；实现随 in-flight 注册表
   * 迁入 pi-respawn 编排器（ensureRestored，join 状态单一所有者）。
   */
  async ensureActive(sessionId: string): Promise<IPiEngine> {
    const existing = this.pm.getClient(sessionId)
    // 纵深防御（pi-exit-notification-and-respawn §6.6）：上游清理（onSessionExit）出现竞态时
    // processes Map 可能残留已死 client——视同无 client 走下方 restoreSession（其内部对
    // existing sessions 条目已有 detach + safeDestroy + removeSessionEntry 清场），
    // 不把死 client 交给 prompt。
    if (existing && !existing.exited) return existing
    // 占座让路（idle-pi-reclamation D6-2）：回收编排进行中（seat 命中）→ 等待释放后走
    // 既有 restore，绝不抢跑——抢跑的 restoreSession 对未完成摘除的 session 走 existing
    // 清场分支 = 死亡清理汇聚点被完整触发（bus.clearSession 断流 + destroyPty 连杀 +
    // didDestroy 投递，被否谱系「超时抢跑」）。等待的确定性由 reclaim 的 finally 释放保证。
    // [u2 回归根因] 同步短路守卫：seat 未命中时必须零微任务让步。awaitReclaimSeatRelease
    // 是 async 函数，无条件 `await` 即使内部同步 return 也让 restore 入口晚一个微任务，
    // 「seat 缺省 = 行为不变」的 u2 契约在微任务粒度被破坏——ensureActive() 调用不再
    // 同步进入 respawn.ensureRestored→restoreSession（join 语义本体未坏，restoringSessions
    // 注册表照常去重），但测试构造依赖同步进入时序（同步断言 spy 次数 / ③b 的 deferred
    // 注册窗口），Gate A 5 例 join 失败均源于此。isHeld 为纯同步查询，命中路径行为与
    // 原 awaitReclaimSeatRelease 内部检查逐微任务等价（内部检查保留作双保险）。
    if (this.reclaimSeat?.isHeld(sessionId)) {
      await this.awaitReclaimSeatRelease(sessionId)
    }
    await this.respawn.ensureRestored(sessionId)
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error('Restore succeeded but client not available')
    return client
  }

  /**
   * 等待回收占座释放（D6-2「等待方永不抢跑」硬约束的实现）。
   *
   * 占座区间天然有界（最坏 ~2-3s：kill 硬上限 2s + 同步摘除），且由 reclaimManagedSession
   * 的 finally 结构性保证终将释放——所以本等待的语义是「等到为止」：单轮观测超时
   * （RECLAIM_SEAT_WAIT_OBSERVE_MS，5s）只记 ERROR（占座实现有 bug 的信号），随后继续
   * 等待，绝不调用任何销毁语义或直接走 restore。
   */
  private async awaitReclaimSeatRelease(sessionId: string): Promise<void> {
    const seat = this.reclaimSeat
    if (!seat || !seat.isHeld(sessionId)) return
    let waitedMs = 0
    while (seat.isHeld(sessionId)) {
      const released = await seat.waitRelease(sessionId, RECLAIM_SEAT_WAIT_OBSERVE_MS)
      if (released) return
      waitedMs += RECLAIM_SEAT_WAIT_OBSERVE_MS
      console.error(
        `[session-service] ensureActive has waited ${waitedMs}ms for reclaim seat release `
        + `(sessionId=${sessionId}) — seat held longer than the bounded reclaim window is a bug `
        + `signal, continuing to wait (never preempt, D6-2)`,
      )
    }
  }

  // ── history 读编排域（S6 迁出至 history-rebuild-cache.ts；三分支重建/inflight 合并/尾读降级详见该模块）──

  /**
   * 拉取 session 历史（缓存增量三分支重建 + 双预算窗口，实现迁 history-rebuild-cache.ts）。
   * [u6] query 透传游标翻页参数（cursor/limitTurns/maxBytes，crash-resilience §3.3 D4 中期）。
   * [u6] getFullHistory 全量通路已退役（「加载更早」改走本方法的游标翻页，游标翻页完全替代）。
   */
  async getHistory(sessionId: string, query?: { cursor?: string; limitTurns?: number; maxBytes?: number }): Promise<HistoryWindowResult> { return this.historyReader.getHistory(sessionId, query) }

  /**
   * 清空全部历史重建缓存（u7c：crash-forensics D4 memory-relief 可回收物 ① 的透传
   * 出口——组合根 watchdog onRelief 接线调此方法，偏差 #28①；实现与语义见
   * history-rebuild-cache.ts SessionHistoryReader.clearHistoryCache）。
   */
  clearHistoryRebuildCache(): number { return this.historyReader.clearHistoryCache() }

  /**
   * 驱逐单 session 的历史重建缓存条目（B8，memory-leak-remediation §3.3-B8 候选 C）。
   * 回收≠销毁：不走 removeSessionEntry 汇聚点；驱逐后重激活走单次全量重建（P7 张力
   * 四要素显式登记的代价）。组合根 reclaim 装配消费——ReclaimSessionDeps.
   * evictHistoryRebuildCache 绑本方法（实现与语义见 history-rebuild-cache.ts
   * SessionHistoryReader.onSessionReclaimed）。
   */
  evictHistoryRebuildCache(sessionId: string): void { this.historyReader.onSessionReclaimed(sessionId) }

  // ── subagent/workflow 记录域（S6 迁出至 session-records.ts；磁盘扫描/引擎配置/动作详见该模块）──

  /** subagent 列表（冷启动磁盘扫描，实现迁 session-records.ts）。 */
  async getSubagents(sessionId: string): Promise<SubagentRecord[]> { return this.records.getSubagents(sessionId) }
  /** subagent 对话流历史（record.sessionFile 直读 + 非 pi 引擎降级链，实现迁 session-records.ts）。 */
  async getSubagentHistory(sessionId: string, subagentId: string): Promise<HistoryFileReadResult> { return this.records.getSubagentHistory(sessionId, subagentId) }
  /** [U7] 引擎配置视图（engines.json + config.json，实现迁 session-records.ts）。 */
  async getSubagentEngineConfig(): Promise<SubagentEngineConfigView> { return this.records.getSubagentEngineConfig() }
  /** [U7] 设置默认引擎（带跨进程锁的 RMW + 原子写，实现迁 session-records.ts）。 */
  async setSubagentDefaultEngine(engineId: string): Promise<void> { return this.records.setSubagentDefaultEngine(engineId) }
  /** workflow 列表（冷启动磁盘扫描，实现迁 session-records.ts）。 */
  async getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> { return this.records.getWorkflows(sessionId) }

  /**
   * session-trace 台账全量拉取（RPC 混合路由 → 文件降级 → empty 空态）。
   * 实现在 trace-sync.ts（S4 迁出），路由与失败路径详见该模块。
   */
  async getTraceEntries(sessionId: string): Promise<SessionTraceSnapshot> {
    return this.traceSync.getTraceEntries(sessionId)
  }

  /**
   * session-trace 增量腿补拉（触发事件/lifecycle RPC 成功后 since 拉取 + 广播）。
   * 实现在 trace-sync.ts（S4 迁出）：无基线 no-op、串行链防 burst，详见该模块。
   */
  syncTraceEntries(sessionId: string, trigger: string): void {
    this.traceSync.syncTraceEntries(sessionId, trigger)
  }

  /**
   * 现取当前 system prompt（常驻扩展通道：prompt 命令 → 轮询 get_entries 命中 custom entry）。
   * 实现在 trace-sync.ts（S4 迁出），busy 预检与轮询时序详见该模块。
   */
  async fetchCurrentSystemPrompt(sessionId: string): Promise<ServerMessageMap['session.currentSystemPrompt']> {
    return this.traceSync.fetchCurrentSystemPrompt(sessionId)
  }

  /** agent call 对话流（agent call 本质是 subagent，record 查找路径详见 session-records.ts）。 */
  async getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<HistoryFileReadResult> { return this.records.getAgentCallHistory(sessionId, agentCallSessionId) }
  /** agent call JSONL 路径（展示型，找不到返回空串；实现迁 session-records.ts）。 */
  async getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string> { return this.records.getAgentCallFilePath(sessionId, agentCallSessionId) }
  /** workflow 生命周期操作（经扩展 slash command，实现迁 session-records.ts）。 */
  async workflowAction(sessionId: string, action: 'pause' | 'resume' | 'abort', runId: string): Promise<void> { return this.records.workflowAction(sessionId, action, runId) }
  /** subagent 生命周期/定向消息操作（encodeDirectiveText 编码，实现迁 session-records.ts）。 */
  async subagentAction(
    sessionId: string,
    action: 'cancel' | 'message' | 'start',
    params: { subagentId?: string; text?: string; slug?: string; task?: string },
  ): Promise<void> { return this.records.subagentAction(sessionId, action, params) }

  /**
   * W5：session 是否处于可 reload 的空闲态（进程存活且非生成中）。
   * 供 ReloadOrchestrator 判断 skill 变更时是立即 reload 还是排队。
   */
  isSessionIdle(sessionId: string): boolean {
    const session = this.lifecycle.get(sessionId)
    return !!session && !session.isGenerating
  }

  /**
   * W5：session 是否仍存活（sessions Map 含此 id，进程未退出 / 未被 delete）。
   * 供 ReloadOrchestrator 检测排队期 session 删除，避免对已死 session 发 reload。
   */
  hasSession(sessionId: string): boolean {
    return this.lifecycle.has(sessionId)
  }

  /**
   * W5：向 session 发 `/__xyz_reload__` 触发 pi reload（重扫 skill + 重建 runtime）。
   * 对称 workflowAction 的转发模式：直接 client.prompt 绕过 dispatcher busy 预检 / hook，
   * 专用于 internal reload action（builtin extension 注册，不经 LLM）。client 不存在或
   * prompt 抛错向上抛，由 ReloadOrchestrator 降级 catch（best-effort，不阻塞）。
   */
  async promptReload(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    // 维护通道标记（idle-pi-reclamation D1 / R2 接线）：skill 目录任一文件变动会对全部
    // 活跃 session 触发本 prompt，若计入 touch，skill 开发常态下全部空闲时钟被周期性
    // 重置、回收饿死且不体现为豁免命中（日志看不到）——maintenance 标记让 RpcClient
    // 跳过 lastActivityAt 刷新（u1a 的 SendCommandOptions 通道）。
    await client.prompt('/__xyz_reload__', undefined, undefined, { maintenance: true })
  }

  /**
   * U3（composer 四符号 §3.3.5）：reload 完成后失效 commands 快照（slash 列表动态刷新
   * 链路闭合点）。失效点挂在这里的时机依据（设计 F8）：pi 对 extension 命令
   * `await _tryExecuteExtensionCommand`（agent-session.js:800），promptReload resolve 即
   * reload 已完成；而 `session_start(reason='reload')` 事件是 extension-only 不出 stdout
   * （agent-session.js:2072），runtime 侧不存在可订阅的 reload 完成事件。
   *
   * 事件只做失效（对齐 applyContextUpdate 范式）——markDirty 置 dirty + 防抖重拉
   * get_commands（commands 实例唯一数据写路径），重拉成功后经既有挂钩
   * fetchCommandsSnapshot 内的 publishCommandsSnapshot 自动广播 session.commands，
   * 本方法无需额外广播。
   */
  handleSessionReloaded(sessionId: string): void {
    this.projection.getReplicatedStates(sessionId)?.commands.markDirty()
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const session = this.lifecycle.get(sessionId)
    return session ? this.toSummary(session) : undefined
  }

  /**
   * W10：inputTokens 读点唯一化——usage 实例快照派生（fetch get_session_stats 写入的唯一
   * 数据源）。旧 session.inputTokens 缓存直写（applyContextUpdate / fetchContext 回写，
   * 及已删除的外部 setter）已删，sessions Map 内字段退化为恒 0 的派生基线（types 必填
   * 字段，读点全部走本方法）。
   */
  getInputTokens(sessionId: string): number {
    return this.projection.getReplicatedStates(sessionId)?.usage.get()?.inputTokens ?? 0
  }

  /**
   * 处理 context.update（事件只失效 usage 实例，发布归快照挂钩——语义注释随实现迁
   * session-state-projection.ts）。组合根 index.ts onContextUpdate 经本委托消费。
   */
  applyContextUpdate(sessionId: string, inputTokens: number, totalTokens?: number): void {
    this.projection.applyContextUpdate(sessionId, inputTokens, totalTokens)
  }

  /** turn_end 单 turn 副作用（project sidecar 兜底；语义注释随实现迁 session-state-projection.ts）。 */
  handleTurnUsageSideEffects(sessionId: string): void {
    this.projection.handleTurnUsageSideEffects(sessionId)
  }

  /** agent_end 副作用（isGenerating 复位 + sidecar 兜底 + session_end 终态；语义注释随实现迁 session-state-projection.ts）。 */
  handleTurnEndSideEffects(sessionId: string, stopReason?: string): void {
    this.projection.handleTurnEndSideEffects(sessionId, stopReason)
  }

  /**
   * agent_settled 副作用（run 级联结束 → isGenerating 复位；session-dead 2026-09-10 补丁，
   * 语义注释随实现迁 session-state-projection.ts）。组合根 index.ts onAgentSettled 经本委托消费。
   */
  handleAgentSettledSideEffects(sessionId: string): void {
    this.projection.handleAgentSettledSideEffects(sessionId)
  }

  /**
   * 写 session_end 终态 entry（W4，ADR 0042）。
   * 3 个终态点复用：正常完成（handleTurnEndSideEffects）/ abort（message-dispatcher）/ 进程崩溃（onSessionExit）。
   * sessionFilePath 不存在时静默跳过（首 turn 前崩溃 / pi 延迟写入窗口）。
   */
  persistSessionOutcome(sessionId: string, outcome: SessionOutcome, reason?: string): void {
    const session = this.lifecycle.get(sessionId)
    if (!session?.sessionFilePath) return
    this.sessionStore.persistSessionEnd(session.sessionFilePath, outcome, reason)
  }

  /**
   * W10：取 session 当前 usagePercent——usage 实例快照派生（pi 权威 percent 投影）。
   * 旧实现按「缓存 inputTokens + resolver 窗口」本地重算（computeUsage），W10 起快照
   * 已持有 pi 侧按当前模型窗口算出的权威 percent，读点直接派生；dirty 期间返回上次
   * 快照（核心不变量 2 的 UI 语义）。
   */
  getUsagePercent(sessionId: string): number {
    return this.projection.getReplicatedStates(sessionId)?.usage.get()?.usagePercent ?? 0
  }

  async destroyAll(): Promise<void> {
    for (const session of this.lifecycle.values()) {
      session.adapter.detach()
    }
    await this.pm.destroyAll()
    // shutdown 路径：只清 sessions Map（Map 所有者执行），刻意不触发 dispose/销毁通知
    // ——进程将亡，缓存随进程同灭（迁移前行为保持，设计 D2②）。
    this.lifecycle.clear()
    // D4 清理路径：shutdown 全量清 userStopped 标记 + 停全部收敛环定时器（与 sessions Map
    // 同因——进程将亡，内存态随进程消亡；显式清防测试环境单例跨实例残留）。
    userStoppedGate.disposeAll()
  }

  /**
   * 取消全部 pending 自动恢复 timer（crash-resilience D7-② shutdown 取消语义；组合根
   * index.ts 的 shutdown 序列专用——必须先于 server.stop 内的 destroyAll 调用：若 destroyAll
   * 之后 pending timer 仍可触发，shutdown 中途会 spawn 新孤儿 pi，收割器只在下次启动后
   * 5s 跑一次，用户直接退出 app 则孤儿无限存活烧 token。对齐 u5b stopMemoryWatermarkTimer
   * 的 shutdown 先取消先例）。
   */
  cancelAllPendingRespawns(): void {
    this.respawn.cancelAll()
  }

  // ── 内部协议（lifecycle/dispatcher/scanner 窄接口 + 过渡宽接口）:子模块经此访问 sessions / 共享 helper ──

  /** 有效 skill 路径（实现迁 launch-params.ts：cwd resolve + existsSync 过滤 + expandHome）。 */
  getSkillPaths(cwd: string): string[] { return resolveSkillPaths(this.configStore, cwd) }
  /** 有效 extension 路径（实现迁 launch-params.ts：断链 fail-fast + 其余降级空列表）。 */
  async getExtensionPaths(cwd?: string): Promise<string[]> { return resolveExtensionPaths(this.extensionService, cwd) }
  /** 替换系统提示词（实现迁 launch-params.ts；未注入 ConfigService 时 undefined）。 */
  getReplaceSystemPrompt(): string | undefined { return resolveReplaceSystemPrompt(this.configService) }
  /** launch preset 解析（实现迁 launch-params.ts：builtin:full fallback 语义详见该模块）。 */
  async getLaunchPresetOptions(presetId: string, cwd: string): Promise<PresetResolution | undefined> { return resolveLaunchPresetOptions(this.presetService, presetId, cwd) }

  findScannedSession(sessionId: string): ScannedSession | undefined {
    // wave:perf-w26（D9-1 消费方分层，plan M-3）：本方法的全部消费方（rename/delete/restore/
    // fork 的源文件解析、setProject 的 sidecar 写入）都是单 session 路径解析——统一 force
    // 旁路 TTL，刚落盘 session 在窗口内也能解析到。
    return this.sessionStore.scanSessions({ force: true }).find(s => s.id === sessionId)
  }

  /**
   * 手动归类（D14 语义修正，2026-08-04）：写 session 归属 project 到 `.project.json` sidecar。
   *
   * active session 同步内存态（toSummary 从内存透传，广播后 summary 立即携带新归属）；
   * 磁盘 session 经扫描拿 filePath 写 sidecar（scanner 下次扫描读到）。
   * 空 projectId = 归回默认项目（等价删除绑定，persistProjectBinding 空值守卫跳过）。
   * session 不存在/文件未落盘（延迟写入窗口）→ 静默跳过（不阻断归类流程，下次 create 兑底）。
   */
  async setProject(sessionId: string, projectId: string): Promise<void> {
    const active = this.lifecycle.get(sessionId) as (IManagedSessionView & { projectId?: string }) | undefined
    if (active) {
      active.projectId = projectId || undefined
      if (active.sessionFilePath) {
        this.sessionStore.persistProjectBinding(active.sessionFilePath, projectId)
      }
      return
    }
    const scanned = this.findScannedSession(sessionId)
    if (scanned?.filePath) {
      this.sessionStore.persistProjectBinding(scanned.filePath, projectId)
    }
  }

  toSummary(s: IManagedSessionView): SessionSummary {
    // 实现迁 session-summary.ts（buildSessionSummary，行为保持抽取）：纯投影不依赖
    // Facade 其余状态，gitInfoReader / replicated states 读点参数化后模块级化。
    return buildSessionSummary(s, this.gitInfoReader, (id) => this.projection.getReplicatedStates(id))
  }

  getSession(sessionId: string): IManagedSessionView | undefined { return this.lifecycle.get(sessionId) }

  /**
   * M3：标记源 session 已交接给新 session。
   *
   * 把 handedOffTo 的写入（内存 + 磁盘 handoff_marker）收归 SessionService（拥有 sessions Map
   * 与 sessionFilePath），避免 handoff-service 直接改内部对象（srcSession.handedOffTo = newId）
   * 绕过所有权——getSession 未来若返回防御性副本会让外部直接写入静默失效。
   *
   * 仅处理 active session（sessions Map 命中）：内存写 handedOffTo（toSummary 透传到
   * SessionSummary，活跃态立即生效不等 scanner 重扫）+ 磁盘写 handoff_marker（scanner
   * 读后填 SessionSummary.handedOffTo，前端跳转/标记用）。
   *
   * handoff 编排保证源 session 在交接时仍 active（由前端触发跳转前 pi turn 已结束、进程未退出），
   * 故非 active 路径（已被删 / 纯 RPC）按 no-op 处理。若未来需支持非 active 源 session 交接，
   * 此处应通过 findScannedSession(srcSessionId)?.filePath 解析路径后补写磁盘。
   */
  markHandedOff(srcSessionId: string, newSessionId: string): void {
    const session = this.lifecycle.get(srcSessionId)
    if (session) {
      session.handedOffTo = newSessionId
    }
    if (session?.sessionFilePath) {
      this.sessionStore.persistHandoffSidecar(session.sessionFilePath, newSessionId)
    }
  }
  /**
   * S3-W2：session 创建通知（lifecycle 全部创建入口收敛点：create / restoreSession /
   * forkSession 三处 spawn 路径的 return 前调用）。触发 onSessionCreated →
   * PluginService session 事件注册表定向投递插件 didCreate。回调异常不外抛。
   */
  notifySessionCreated(summary: SessionSummary): void {
    try {
      this.onSessionCreated?.(summary)
      // catch 内有 console.error（非 silent catch），无需 no-silent-catch 豁免。
    } catch (e: unknown) {
      // 降级策略（best-effort）：插件回调异常不阻断创建主流程，仅落日志供排查
      console.error(`[session-service] onSessionCreated listener error (sessionId=${summary.id}):`, e)
    }
  }

  /**
   * 销毁收敛链唯一完成入口（四路删除路径汇聚：lifecycle.delete 主动删 / onSessionExit
   * 进程退出 / forceQuit / restore 清场）。[T8 有限拆分 2026-09] 编排段（步骤序列 + 全部
   * 旁路设施挂点 + 销毁扇出）已整体迁入 session-entry-removal.ts——**顺序约束 SSOT 与
   * 收敛说明（含与 lifecycle.delete B5 段的跨文件顺序、B5 禁止挂回）在该文件头**。
   * 本 wrapper 只保留公开签名：四路调用面与测试 vi.spyOn 锁定面在此，行为 = 一行委托。
   */
  removeSessionEntry(sessionId: string): void {
    this.entryRemoval.remove(sessionId)
  }

  getSessionByClient(client: IPiEngine): IManagedSessionView | undefined {
    const id = this.pm.getSessionIdByClient(client)
    return id ? this.lifecycle.get(id) : undefined
  }

  detachSession(sessionId: string): void {
    const session = this.lifecycle.get(sessionId)
    if (!session) return
    session.adapter.detach()
  }

  getActiveSummaries(): SessionSummary[] {
    return Array.from(this.lifecycle.values()).map(s => this.toSummary(s))
  }

  getActiveFilePaths(): Set<string> {
    const filePaths = new Set<string>()
    for (const s of this.lifecycle.values()) {
      if (s.sessionFilePath) filePaths.add(s.sessionFilePath)
    }
    return filePaths
  }

  /**
   * 初始化 ManagedSession（S3/D2② 迁入 lifecycle.registerSession 后的兼容委托——
   * 生产注册路径 = lifecycle create/restore/fork 内部直调 this.registerSession；
   * 本方法保留给测试/历史调用点，行为与迁移前等价：session 构造 + sessions Map 写入 +
   * onSessionRegistered 同步直发（订阅者 = 本 Facade 构造器接线的各域注册）。
   */
  async initializeManagedSession(
    id: string, client: IPiEngine, cwd: string, label: string, sessionFilePath?: string, hidden?: boolean,
    parentSession?: string, forkEntryId?: string, modelOverride?: string,
    metaOverride?: { modelId?: string; thinkingLevel?: string },
    spawnExtensionPaths?: readonly string[],
  ): Promise<IManagedSessionView> {
    return this.lifecycle.registerSession(id, client, cwd, label, sessionFilePath, hidden, parentSession, forkEntryId, modelOverride, metaOverride, spawnExtensionPaths)
  }

  // ── 私有协作者 ────────────────────────────────────────────────

  /**
   * backgroundTask:updated 广播组装（background-task-sidebar D3，u-runtime-rpc①）：
   * onTasksChanged（mtime 轮询 / 自写自检触发）时重读该 session registry 全量 → messageBus
   * session 级 publish（Server→Client 冒号 camelCase，对齐 plugin:statusBarUpdate 命名规则；
   * stream 类入 ring，晚订阅 renderer 由 snapshot 重放兜底）。bus 未注入时 no-op（nullable
   * 注入语义与域内其余 publish 点一致）。entry 形状为 extension-protocol 契约，shared 侧
   * 逐字段镜像（u-proto D9，结构兼容直赋）。
   */
  private publishBackgroundTasksUpdate(sessionId: string): void {
    const { entries, corrupted } = this.backgroundTasks.listTasks(sessionId)
    const msg: ServerMessage = {
      type: 'backgroundTask:updated',
      payload: { sessionId, tasks: entries, corrupted },
    }
    this.messageBus?.publish(sessionId, msg)
  }

  /**
   * 归属 project sidecar 延迟写入兑底（D14 语义修正，2026-08-04）。
   *
   * [V9-④ 根修后] create 路径 persistProjectBinding 已传 skipJsonlExistsGuard 放行
   * 守卫直接落盘，本补偿退化为异常时序兜底：仅 sessionFilePath 缺失（pi 异常未返回
   * 路径，create 写点无从落盘）等场景，在 turn_end（主路径）/ agent_end（兑底）时
   * 补写——此时文件存在（或仍不存在 → 跳过，下次兑底）。无归属（undefined）跳过。
   *
   * 用 projectBindingPersisted 标记防重复写（session 级运行时标记，不进 toSummary）。
   */
  private tryPersistProjectBinding(s: IManagedSessionView): void {
    const projectId = (s as IManagedSessionView & { projectId?: string }).projectId
    const persisted = (s as IManagedSessionView & { projectBindingPersisted?: boolean }).projectBindingPersisted
    if (persisted || !projectId || !s.sessionFilePath || !existsSync(s.sessionFilePath)) return
    this.sessionStore.persistProjectBinding(s.sessionFilePath, projectId)
    ;(s as IManagedSessionView & { projectBindingPersisted?: boolean }).projectBindingPersisted = true
  }

  /**
   * model binding sidecar 补写兜底（D1 写点③延迟 flush 语义修正，Gate B 端到端实证，
   * 2026-09-04）。镜像 tryPersistProjectBinding（D14 同款问题同款解法）。
   *
   * 背景：写点③（lifecycle create 路径）受 pi 延迟写入窗口约束——create 瞬间
   * sessionFilePath 路径有值但 .jsonl 文件未 flush（pi 0.84.4 实装：SessionManager
   * 构造即生成确定性路径），persistModelBinding 内部 existsSync 守卫恒跳过，且 pi flush
   * 后没有任何补写点。真实 app 实证：新建并对话过的 session 目录里无 .model.json，重启后
   * composer 回落全局默认（内存生效值丢失）；同 session 内显式切模型（写点①）立即产出
   * sidecar，证明写点本身工作、缺的只是 create 窗口的补写时机。
   * [V9-④ 根修注] preset/project/agent 三绑定已放行 create 写点（skipJsonlExistsGuard），
   * model 写点保留守卫语义不改——本补偿已实测工作（V1 文件断言由其满足），无需扩大
   * create 时序行为面。
   *
   * 本方法在 turn_end（主路径）/ agent_end（兜底）时补写——此时 pi 已完成 flush，文件
   * 存在，写 sidecar 安全。文件仍不存在 → 跳过（下次兜底）。
   *
   * 缺失才写：readModelBinding 命中（写点①⑤写的新值或历史值）→ 视为已有，打标跳过
   * 不覆写——sidecar 新鲜度归写点①⑤所有，本方法只补「从没写过的空洞」。
   *
   * 用 modelBindingSidecarEnsured 标记防重复写（session 级运行时标记，同
   * projectBindingPersisted 形态，不进 toSummary）。
   */
  private tryPersistModelBinding(s: IManagedSessionView): void {
    const view = s as IManagedSessionView & { modelBindingSidecarEnsured?: boolean }
    if (view.modelBindingSidecarEnsured || !s.modelId || !s.sessionFilePath || !existsSync(s.sessionFilePath)) return
    if (!readModelBinding(s.sessionFilePath)) {
      persistModelBinding(s.sessionFilePath, s.modelId, s.thinkingLevel ?? '')
    }
    view.modelBindingSidecarEnsured = true
  }

  /**
   * 查询 session 的扩展命令（pi getCommands）。纯查询，无副作用。
   * 用于 renderer 切 session 后主动拉取（修复 broadcast 与订阅时序竞争）。
   *
   * W8 commands 失效接线：本方法是 commands 失效信号的全部汇聚点（W12 起激活发布路径
   * 已删——播种 fetch 经 fetchCommandsSnapshot 挂钩发布，仅剩 renderer 的 session.getCommands
   * RPC 查询路径经此）——查询即失效，markDirty 触发 commands 实例防抖重拉 get_commands
   * 快照（实例唯一数据写路径），重拉完成后经挂钩刷新 session.commands last-value，
   * RPC 响应本身不直写实例数据、也不直接 publish。
   *
   * @throws session 未激活或 pi getCommands 失败时抛（调用方 try-catch）
   */
  async getCommands(sessionId: string): Promise<PiCommandInfo[]> {
    // W8：对齐现有发布路径的事件源全集（激活发布 + 主动查询），失效信号在 RPC 调用前发。
    this.projection.getReplicatedStates(sessionId)?.commands.markDirty()
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`session ${sessionId} not active`)
    return client.getCommands()
  }

  /**
   * 查询 pi 当前上下文占用（get_session_stats.contextUsage），返回 context.update payload。
   * 用于 session 恢复后拉取用量——pi 从历史估算，重启后旧 session 也能显示当前占用。
   * 复用 context.update 契约（inputTokens/contextLimit/usagePercent）。
   * contextUsage.tokens=null（compaction 后未跑新 turn）或 session 未激活时返回 null。
   * @throws session 未激活或 pi rpc 失败时抛（调用方 try-catch）
   */
  async fetchContext(sessionId: string): Promise<{
    inputTokens: number; contextLimit: number; usagePercent: number
  } | null> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`session ${sessionId} not active`)
    const stats = await client.getSessionStats()
    const cu = stats.contextUsage
    // pi 的 contextUsage 在 compact 后无新 turn 时返回 tokens=null（保守设计：
    // compact 前 last assistant usage 反映压缩前 context size，不可信；只有 compact 后
    // 产生新 assistant usage 才能算出真实 context 占用）。
    // 此时不应 fallback 到 tokens.total——那是 session 全生命周期的 token 累加
    // （含 cacheRead），远大于当前 context 占用，会显示荒谬的百分比（如 compact 后 978%）。
    // 正确行为：返回 null，前端不显示 ctx 用量，等用户发消息后 turn_end 刷成精确值。
    if (cu && cu.tokens != null) {
      // W10：restore 拉取写点 = usage 失效源（session 激活后 context 权威值可能已变——markDirty
      // 防抖重拉 get_session_stats 快照刷新 usage 实例，快照是 inputTokens 唯一数据源）。
      // 旧外部 setter 缓存回写已删：switchModel → broadcastSessionState 读实例快照，
      // 注册播种（registerReplicatedStates refetch）已保证快照非空，不再依赖本方法回写。
      this.projection.getReplicatedStates(sessionId)?.usage.markDirty()
      return {
        inputTokens: cu.tokens,
        contextLimit: cu.contextWindow,
        usagePercent: Math.round(cu.percent ?? 0),
      }
    }
    return null
  }

  /**
   * 拉取上下文用量并触发广播（restoreSession / forkSession 兜底用；语义注释随实现迁
   * session-state-projection.ts）。ILifecycleSessionOps 声明保持，单一实现 = 本委托。
   */
  async fetchAndBroadcastContext(sessionId: string): Promise<void> {
    return this.projection.fetchAndBroadcastContext(sessionId)
  }

  // ── 附件存储（S1 迁出至 attachment-store.ts；安全校验语义 TC3 零削弱，回归见该模块头注释）──
  async writeImage(
    sessionId: string,
    base64: string,
    mimeType: string,
    name: string,
  ): Promise<{ path: string; fileName: string; displayName: string; id: string; persisted: boolean }> {
    return this.attachmentStore.writeImage(sessionId, base64, mimeType, name)
  }

  async migrateImage(
    fromPath: string,
    sessionId: string,
    fileName: string,
  ): Promise<{ path: string }> {
    return this.attachmentStore.migrateImage(fromPath, sessionId, fileName)
  }

  async writeSegmentsMetadata(sessionId: string, entry: SegmentsMetadataEntry): Promise<void> {
    return this.attachmentStore.writeSegmentsMetadata(sessionId, entry)
  }
}

// ── D1 台账 helper（crash-forensics §3.3 D1 防漏设计①）───────────────────────

/** 台账 detailDigest 内嵌上限（设计 D1：「末 10 行 stderr 摘要内嵌（≤2KB）」）。 */
const CRASH_DETAIL_DIGEST_MAX_CHARS = 2048

/**
 * crash 事件的 detailDigest：stderr 尾部摘要截断内嵌（取尾不取头——崩溃根因通常在输出末尾，
 * 与 rpc-client getStderrTail 的尾部形态同向）。stderr 为空（信号死亡无输出）时兜底一行
 * 退出形态描述——digest 恒非空，崩溃行的最小归因信息不因 stderr 缺失而全空。
 */
function buildCrashDetailDigest(code: number | null, stderr: string | undefined): string {
  const tail = (stderr ?? '').trim()
  const digest = tail
    || (code === null
      ? 'process died by signal (no stderr captured)'
      : `process exited with code ${code} (no stderr captured)`)
  // 超限取尾部（保留最接近崩溃现场的输出），换行结构原样保留
  return digest.length > CRASH_DETAIL_DIGEST_MAX_CHARS
    ? digest.slice(-CRASH_DETAIL_DIGEST_MAX_CHARS)
    : digest
}
