/**
 * RuntimeServer — 编排层：路由表装配（D1）+ service 编排 + 连接/消息协调。
 *
 * C2 拆分后只保留传输编排职责：
 * - 组合 ConnectionManager（连接生命周期 + 心跳 + 连接池）与 ServerMessageBroker（发送/广播/initial state）。
 * - D1 中央分发表：handler 的 handles 清单 + Map spread → O(N→M) 路由映射（亮点，勿动）。
 * - setServices：四阶段编排（assignServices → createBroker → assembleHandlers → buildRoutes），
 *   装配全部 message handler 并注入各 handler 的 context（messaging + 领域依赖）。
 * - extension timeout / bridge 请求的对外委托入口（event-adapter 经 index.ts 调用）。
 *
 * 业务逻辑在 services，经 handler 调用；本类不含领域计算，只做路由与编排。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, RollingRestartStatusPayload, ServerMessage, ServerMessageType, SkillCacheScope } from '@taiji/shared'
import { EXTENSION_EVENTS, OUTBOUND_FRAME_WARN_BYTES, OUTBOUND_FRAME_TRUNCATE_BYTES } from '@taiji/shared'
import type { SessionManagerAction } from '@zhushanwen/extension-protocol'
import type { ISessionService, IConfigService, IModelService, IMessageBroker, IExtensionService, IPluginService, IAuthService } from '../interfaces.js'

/** authService 未注入时的兜底（组合根必传；防御性空实现防 handler 空指针） */
const noopAuthService: IAuthService = {
  login: () => ({ started: false, error: 'OAuth 不可用（authService 未装配）' }),
  cancel: () => ({ cancelled: false }),
  hasOAuth: async () => false,
  logout: async () => { throw new Error('OAuth 不可用（authService 未装配）') },
  getCredential: async () => undefined,
  saveCredential: async () => { throw new Error('OAuth 不可用（authService 未装配）') },
}
import type { GitService } from '../services/git-service.js'
import type { FileService } from '../services/file-service.js'
import type { SkillRegistry } from '../services/skill-registry.js'
// IMessageBus（wave:perf-w09 接口收敛）：注入到 SessionMessageHandler ctx（subscribe RPC）+
// ConnectionManager.onDisconnect 清理 + changeSetInvalidated 定向发布。
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import { createSessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
import type { SessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
import { ExtensionTimeoutManager } from '../services/extension-timeout-manager.js'
import type { PendingUIRequest, PendingUIRequestResolved } from '../services/extension-timeout-manager.js'
import { ConnectionManager } from './connection-manager.js'
import { ServerMessageBroker } from './message-broker.js'
import { BridgeHandler } from './bridge-handler.js'
import { SettingsMessageHandler } from './settings-message-handler.js'
import { SessionMessageHandler } from './session-message-handler.js'
import { ExtensionMessageHandler } from './extension-message-handler.js'
import { PluginMessageHandler } from './plugin-message-handler.js'
import { GitMessageHandler } from './git-message-handler.js'
import { FileMessageHandler } from './file-message-handler.js'
import { WorkspaceMessageHandler } from './workspace-message-handler.js'
import { ProjectMessageHandler } from './project-message-handler.js'
import { WorktreeMessageHandler } from './worktree-message-handler.js'
import { TerminalMessageHandler } from './terminal-message-handler.js'
import { QuotaMessageHandler } from './quota-message-handler.js'
import { UsageMessageHandler } from './usage-message-handler.js'
import { PresetMessageHandler } from './preset-message-handler.js'
import { SessionManagerHandler } from './session-manager-handler.js'
import { BtwMessageHandler } from './btw-message-handler.js'
// BtwRoutingDeps（btw-question M2-b / B1 授权）：组合根构造 BtwService 后经 optional.btw 注入。
import type { BtwRoutingDeps } from './btw-message-handler.js'
import type { MessageHandlerContext, ErrorDetails } from './message-context.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { ProjectStore } from '../services/project/project-store.js'
import type { IWorktreeService } from '../services/ports/worktree-service.js'
import type { HandoffService } from '../services/handoff-service.js'
import type { ImportService } from '../services/session/import-service.js'
// GenStatsService（composer-gen-stats u3）：session.getGenStats 恢复腿 RPC 路由依赖。
import type { GenStatsService } from '../services/session/gen-stats-service.js'
import type { ITerminalService } from '../services/ports/terminal-service.js'
import type { QuotaService } from '../services/quota-service.js'
import type { IProviderCredentialResolver } from '../services/ports/provider-credential-resolver.js'
import type { IModelConnectionTester } from '../services/ports/model-connection-tester.js'
import { UsageStatsService } from '../services/usage/usage-stats-service.js'
import type { PresetService } from '../services/preset-service.js'
import { toErrorMessage } from '../utils/errors.js'
// warn-once（MF-1-8）：invalidatePendingUiRequests 的 bus 缺失分支显形（RT-4#9 同款纪律）。
import { warnOnce } from '../utils/warn-once.js'

/**
 * setServices 的全部可选依赖（PR #189 review：签名从 18 个位置参数收敛为聚合对象，
 * 成员可省略语义与原可选参数一致——漏传不再是「错位静默」，装配面一目了然）。
 */
export interface RuntimeServerOptionalServices {
  extension?: IExtensionService
  plugin?: IPluginService
  git?: GitService
  file?: FileService
  workspace?: WorkspaceService
  appInfo?: { appVersion: string; piVersion: string }
  skillRegistry?: SkillRegistry
  worktree?: IWorktreeService
  terminal?: ITerminalService
  quota?: QuotaService
  handoff?: HandoffService
  preset?: PresetService
  auth?: IAuthService
  /**
   * Provider 凭据解析唯一通道（D3 收口，链 2 消费点）。
   * 组合根（index.ts）经本 optional 对象注入，assembleCoreHandlers 透传给
   * SettingsMessageHandler ctx（M2fg 删降级后 ctx 必需——生产恒注入，ctx 装配处断言非空）。
   */
  providerCredentialResolver?: IProviderCredentialResolver
  /**
   * 测试连接 HTTP 适配器（M3a / D-21 端口化）：组合根（index.ts）构造 infra 实现
   * ModelConnectionTester 经本对象注入，assembleCoreHandlers 透传给 SettingsMessageHandler
   * ctx（discoverModels mode=test 路由依赖）。生产恒注入，ctx 装配处断言非空。
   */
  connectionTester?: IModelConnectionTester
  project?: ProjectStore
  delivery?: SessionDeliveryRegistry
  /** 导入 pi 会话服务（import-session D5/U2）：session.importCandidates / session.import 路由依赖。可选：未注入时该 case 报 unsupported。 */
  importService?: ImportService
  /** 生成指标服务（composer-gen-stats D4）：session.getGenStats 恢复腿路由依赖。可选：未注入时该 case 报 unsupported。 */
  genStats?: GenStatsService
  /**
   * reply 通路出站守卫的 session 文件路径解析器（u8 与 push 通路对称接线：push 经
   * MessageBus 构造注入，reply 经 broker 构造注入，组合根两处共用同一 resolver 实例）。
   * 可选：未注入时 reply 超限占位文案退化为「（见 runtime 日志）」，阈值仍用默认常量。
   */
  replyGuardResolver?: (sessionId: string) => string | null | undefined
  /**
   * btw 线三帧路由（btw-question M2-b，B1 授权）：BtwService 窄面 + 主会话解析。
   * 组合根（index.ts）构造 BtwService 后注入，assembleOptionalHandlers 据此构造
   * BtwMessageHandler 并在 buildRoutes 展开 handles（缺省 = 不装配，btw.* 落 unknown_type——
   * 生产组合根恒注入，缺省语义服务存量测试装配）。
   */
  btw?: BtwRoutingDeps
}

export class RuntimeServer implements IMessageBroker {
  private projectRoot: string
  private conn: ConnectionManager
  private broker!: ServerMessageBroker

  private sessionService!: ISessionService
  private configService!: IConfigService
  private modelService!: IModelService
  private extensionService?: IExtensionService
  private pluginService!: IPluginService
  private gitService?: GitService
  private fileService?: FileService
  /** fast-handoff 编排层（session.handoff / session.abortHandoff 路由用）。 */
  private handoffService?: HandoffService
  /** W4：skillRegistry（可选，landing 全局/项目 skill 缓存源） */
  private skillRegistry?: SkillRegistry
  /** 导入 pi 会话服务（import-session U2）：可选，setServices 注入后经 sessionHandler ctx 触达。 */
  private importService?: ImportService
  /** 生成指标服务（composer-gen-stats u3）：可选，setServices 注入后经 sessionHandler ctx 触达。 */
  private genStatsService?: GenStatsService
  /**
   * MessageBus 单例（wave:runtime-wiring）：注入到 SessionMessageHandler ctx，
   * 供 session.subscribe/unsubscribe RPC 注册/取消订阅。ws 断开时 onDisconnect 回调调
   * bus.unsubscribeAll(ws) 清理订阅。经 setMessageBus 注入（组合根在 setServices 前调）。
   */
  private messageBus?: IMessageBus

  // ── Message handlers (extracted) ────────────────────────────────
  // Constructed in setServices() — not at field-init time — so `this` is fully
  // initialized and each handler receives an explicit context object rather than
  // the `as unknown as XxxHandlerContext` cast the field-initializer needed.
  private extensionTimeoutMgr = new ExtensionTimeoutManager()
  private bridgeHandler!: BridgeHandler
  private settingsHandler!: SettingsMessageHandler
  private sessionHandler!: SessionMessageHandler
  private extensionHandler!: ExtensionMessageHandler
  private pluginMessageHandler!: PluginMessageHandler
  private gitMessageHandler?: GitMessageHandler
  private fileMessageHandler?: FileMessageHandler
  private workspaceMessageHandler!: WorkspaceMessageHandler
  private projectMessageHandler!: ProjectMessageHandler
  private worktreeMessageHandler?: WorktreeMessageHandler
  private terminalMessageHandler?: TerminalMessageHandler
  private quotaMessageHandler!: QuotaMessageHandler
  private usageMessageHandler!: UsageMessageHandler
  private presetMessageHandler!: PresetMessageHandler
  private sessionManagerHandler!: SessionManagerHandler
  /** btw 三帧 handler（btw-question M2-b）：optional.btw 注入时装配（可选批次）。 */
  private btwMessageHandler?: BtwMessageHandler

  /**
   * u7c（crash-forensics D5）：滚动重启状态只读查询 provider（组合根 setRollingRestartStatusProvider
   * 注入；未注入时路由回 idle 形态——renderer 拉到 idle 即「横幅不重现」，协议注释同源）。
   */
  private rollingRestartStatusProvider?: () => RollingRestartStatusPayload

  /**
   * D1: 中央分发表。此前是 55 行 switch，每个 case 纯转发、零逻辑。
   * 改成 Map<ClientMessageType, (msg,ws)=>Promise<unknown>> 后：
   * - 加新消息类型只改一个 handler 的 handles 清单，不碰路由（开闭原则）。
   * - ping/file.read 走内联（无对应 handler），settings 走兜底（return false 表示未认领）。
   * 注意：handler 内部的 switch 保留——它们提供编译期类型收窄 + 含真实领域逻辑。
   */
  private routes!: Map<ClientMessageType, (msg: ClientMessage, ws: WsType) => Promise<unknown> | unknown>

  constructor(port: number, projectRoot?: string, authToken: string | null = null) {
    this.projectRoot = projectRoot ?? process.cwd()
    // ConnectionManager 注入回调：连接通过 auth → broker 推送 initial state；
    // 消息到达（必然 authed）→ server.handleMessage 路由；解析/兜底错误 → broker.sendError；
    // 连接关闭 → bus.unsubscribeAll(ws) 清理该 ws 的所有 session 订阅（wave:runtime-wiring）。
    // authToken 缺省 null = fail-closed（S1-W1：组合根 index.ts 经 resolveRuntimeToken
    // 显式传入 env/文件解析出的 token；直接构造不传 token 的调用方将被拒绝连接）。
    this.conn = new ConnectionManager(port, {
      onConnect: (ws) => this.broker.sendInitialState(ws),
      onMessage: (msg, ws) => this.handleMessage(msg, ws),
      sendError: (ws, code, message, id, details) => this.broker.sendError(ws, code, message, id, details),
      onDisconnect: (ws) => this.messageBus?.unsubscribeAll(ws as unknown as import('../services/message-bus/types.js').BusClient),
    }, authToken)
  }

  /**
   * 注入 MessageBus 单例（wave:runtime-wiring）：供 SessionMessageHandler 的 subscribe/
   * unsubscribe RPC 用 + ConnectionManager.onDisconnect 调 unsubscribeAll。
   * 必须在 setServices 前调（setServices 装配 sessionHandler 时读 this.messageBus）。
   */
  setMessageBus(bus: IMessageBus): void {
    this.messageBus = bus
  }

  /**
   * setServices 主编排（复杂度债清偿 U07）：按「装配服务字段 → 构造 broker → 组装
   * handlers → 建分发表」四阶段提私有 helper，本函数只留阶段顺序。各阶段内部与原
   * 实现逐行等价——赋值顺序、条件守卫、context 字面量、事件注册时序均未动。
   */
  setServices(session: ISessionService, config: IConfigService, model: IModelService, optional: RuntimeServerOptionalServices = {}): void {
    this.assignServices(session, config, model, optional)
    this.createBroker(optional.appInfo, optional.replyGuardResolver)
    this.assembleHandlers(optional)
    this.routes = this.buildRoutes()
  }

  /**
   * u7c（crash-forensics D5）：注入滚动重启状态只读查询 provider（rollingRestart.status
   * 路由消费；u7b 已钉协议类型，transport 路由面由本 setter 补挂——只读 RPC 供 renderer
   * 重连/刷新后拉取恢复横幅，「broadcast 时序竞争」教训）。
   */
  setRollingRestartStatusProvider(provider: () => RollingRestartStatusPayload): void {
    this.rollingRestartStatusProvider = provider
  }

  /** 阶段 1：核心 service 字段装配（含 D6a onSessionDestroyed 汇聚清理注册）。 */
  private assignServices(session: ISessionService, config: IConfigService, model: IModelService, optional: RuntimeServerOptionalServices): void {
    // genStats（composer-gen-stats D4）：恢复腿 RPC 路由依赖（sessionHandler ctx 读
    // this.genStatsService）；其余可选服务由 assembleOptionalHandlers 按域自行解构。
    const { extension, plugin, git, file, skillRegistry, handoff, importService, genStats } = optional
    this.gitService = git
    this.fileService = file
    this.handoffService = handoff
    this.genStatsService = genStats
    this.sessionService = session
    // D6a（integrity-hardening §3.6）：挂起 UI 请求的汇聚清理。extensionTimeoutMgr 的
    // per-session 残留（pendingRequests / bridgeRequestIds / session 跟踪）此前只在
    // session 删除分支直接清理，pi 意外退出的收敛链（onSessionExit → removeSessionEntry）
    // 不触碰它——挂起的 ask-user 弹窗在 restore 后重弹，作答发给新进程被静默丢弃（M8 幽灵
    // 弹窗）。挂到 onSessionDestroyed（removeSessionEntry 触发，覆盖主动删 / 进程退出 /
    // restore 清场全部销毁路径）成为单一清理入口；session-message-handler 删除分支的
    // 既有直接调用点已随之移除。setOnSessionDestroyed 是追加式注册，PluginService 后续
    // 注册的 didDestroy 投递不受影响。
    this.sessionService.setOnSessionDestroyed((summary) => {
      // P2-2 失效链：摘除 + 广播（原 clearForSession 只清不广播——renderer 屏上的挂起
      // 审批条/表单不知道请求已死）。覆盖主动删 / 进程退出 / restore 清场全部销毁路径。
      this.invalidatePendingUiRequests(summary.id, 'session-destroyed')
      this.clearExtensionTimeoutsForSession(summary.id)
    })
    // P2-2 失效链（MF-1-7 abortPlan 编排下沉）：session.abortPlan prompt 成功后经回调
    // 上抛至此——失效链消费保持 server.ts 单一出口（与 session-destroyed 同点注册）。
    this.sessionService.setOnPlanAborted((sessionId) => {
      this.invalidatePendingUiRequests(sessionId, 'plan-aborted')
    })
    this.configService = config
    this.modelService = model
    this.skillRegistry = skillRegistry
    this.importService = importService
    if (extension) this.extensionService = extension
    if (plugin) this.pluginService = plugin
    //（wave:perf-w09 接口收敛）plugin.setMessageBus 的 wire 已归位组合根（index.ts，
    // 与 sessionService.setMessageBus 并列）——services 间依赖注入不经 transport 层中转。
    // server 保留的 bus 消费只剩自身 transport 职责：sessionHandler ctx（subscribe RPC）、
    // onDisconnect 清理、changeSetInvalidated 定向发布。
  }

  /** 阶段 2：broker 构造（依赖 services + 连接池，appInfo 缺省 unknown 占位）。 */
  private createBroker(
    appInfo: RuntimeServerOptionalServices['appInfo'],
    replyGuardResolver?: RuntimeServerOptionalServices['replyGuardResolver'],
  ): void {
    this.broker = new ServerMessageBroker(this.conn, {
      sessionService: this.sessionService,
      configService: this.configService,
      modelService: this.modelService,
      pluginService: this.pluginService,
      extensionService: this.extensionService,
      projectRoot: this.projectRoot,
      appInfo: appInfo ?? { appVersion: 'unknown', piVersion: 'unknown' },
    // u8 对称接线：resolver 存在时传第三参（阈值仍用默认常量）；缺省时不传（broker 构造
    // 默认值——阈值同为默认常量、resolver 为 undefined），测试默认行为不变。
    }, replyGuardResolver !== undefined ? {
      warnBytes: OUTBOUND_FRAME_WARN_BYTES,
      truncateBytes: OUTBOUND_FRAME_TRUNCATE_BYTES,
      resolveSessionFilePath: replyGuardResolver,
    } : undefined)
  }

  /** 阶段 3：handler 组装——messaging 共享实现 + 核心/可选/SessionManager 三批，构造顺序不变。 */
  private assembleHandlers(optional: RuntimeServerOptionalServices): void {
    // ── Assemble handlers with explicit context objects ──────────────
    // Each object literal is structurally checked against its HandlerContext
    // interface at the call site — no `as unknown as`, no relying on private
    // members being visible across class boundaries.
    const messaging = this.createMessaging()
    this.assembleCoreHandlers(messaging, optional)
    this.assembleOptionalHandlers(messaging, optional)
    this.assembleSessionManagerHandler(optional)
  }

  /**
   * `messaging` 是 MessageHandlerContext 的共享实现（D7：send/sendError/reply 三方法
   * 逐字相同，此前在 4 个 context 对象里复制了 4 份）。每个 handler 的 context 由
   * `...messaging` 铺底 + 各自的领域依赖组成。
   */
  private createMessaging(): MessageHandlerContext {
    return {
      send: (ws, msg) => this.broker.send(ws, msg),
      sendError: (ws, code, message, id, details) => this.broker.sendError(ws, code, message, id, details),
      reply: (ws, id, type, payload) => this.broker.reply(ws, id, type, payload),
    }
  }

  /** 核心 handler 批：bridge / settings / session / extension / plugin（无条件装配）。 */
  private assembleCoreHandlers(messaging: MessageHandlerContext, optional: RuntimeServerOptionalServices): void {
    const { auth, providerCredentialResolver, connectionTester } = optional
    // 第二参注入 extensionTimeoutMgr：marker 通道（method 恒 'select'）识别出的 bridge
    // 请求由 BridgeHandler 入口登记进 bridgeRequestIds（impl-plan 偏差 #5——生产装配点
    // 必须传，否则前端误发 ui_response 的拦截依据丢失）。
    this.bridgeHandler = new BridgeHandler(this.pluginService ?? null, this.extensionTimeoutMgr)
    this.settingsHandler = new SettingsMessageHandler({
      ...messaging,
      configService: this.configService,
      sessionService: this.sessionService,
      modelService: this.modelService,
      authService: auth ?? noopAuthService,
      // D3 链 2（M2c 接线）：discover 凭据回查经组合根注入的唯一通道（M2fg 删降级后无回退，
      // 恒注入前提同上 skillRegistry——组合根 index.ts 保证传入，setServices 编排保证）。
      providerCredentialResolver: providerCredentialResolver!,
      // D-21 端口化：测试连接 HTTP 适配器经组合根注入（恒注入前提同上——
      // 组合根 index.ts 保证传入，setServices 编排保证；transport 不 import infra 实现）。
      connectionTester: connectionTester!,
      // W4：skillRegistry 必须注入（settings-handler 的 config.getGlobalSkills/getProjectSkills 依赖）。
      // 组合根 index.ts 保证传入；此处断言非空（setServices 编排保证）。若未来 skillRegistry 可选，handler 需守卫。
      skillRegistry: this.skillRegistry!,
      projectRoot: this.projectRoot,
      nextPushId: () => this.broker.nextPushId(),
      broadcast: (msg) => this.broker.broadcast(msg),
      broadcastProviderList: () => this.broker.broadcastProviderList(),
      broadcastSkillList: () => this.broker.broadcastSkillList(),
      broadcastSkillCacheInvalidated: (scope: SkillCacheScope, cwd?: string, partial?: boolean) => this.broker.broadcastSkillCacheInvalidated(scope, cwd, partial),
      broadcastAgentList: () => this.broker.broadcastAgentList(),
      broadcastSkillDirs: () => this.broker.broadcastSkillDirs(),
      broadcastAgentDirs: () => this.broker.broadcastAgentDirs(),
      broadcastExtensionDirs: () => this.broker.broadcastExtensionDirs(),
    })
    this.sessionHandler = new SessionMessageHandler({
      ...messaging,
      sessionService: this.sessionService,
      handoffService: this.handoffService,
      // 导入 pi 会话（import-session D5/U2）：session.importCandidates / session.import 路由依赖。
      importService: this.importService,
      // composer-gen-stats（u3）：session.getGenStats 恢复腿 RPC 路由依赖。
      genStatsService: this.genStatsService,
      // wave:runtime-wiring：注入 MessageBus 供 session.subscribe/unsubscribe RPC 用。
      messageBus: this.messageBus,
      nextPushId: () => this.broker.nextPushId(),
      broadcastSessionList: () => this.broker.broadcastSessionList(),
      broadcast: (msg) => this.broker.broadcast(msg),
      invalidatePendingUiRequests: (sid: string, reason: string) => {
        this.invalidatePendingUiRequests(sid, reason)
      },
    })
    this.extensionHandler = new ExtensionMessageHandler({
      ...messaging,
      sessionService: this.sessionService,
      extensionService: this.extensionService,
      extensionTimeoutMgr: this.extensionTimeoutMgr,
    })
    this.pluginMessageHandler = new PluginMessageHandler({
      ...messaging,
      pluginService: this.pluginService ?? null,
    })
  }

  /**
   * 可选 handler 批：git / file / workspace / project / worktree / terminal / quota /
   * usage / preset——按对应 service 是否注入条件装配，守卫条件与原实现一致。
   */
  private assembleOptionalHandlers(messaging: MessageHandlerContext, optional: RuntimeServerOptionalServices): void {
    const { workspace, project, worktree, terminal, quota, preset, btw } = optional
    if (this.gitService) {
      this.gitMessageHandler = new GitMessageHandler({
        ...messaging,
        sessionService: this.sessionService,
        gitService: this.gitService,
        broadcastChangeSetInvalidated: (sessionId, reason) => {
          // wave:perf-w09（R-08 审计发现的清单外 session 级 push 型消息）：原走
          // broker.broadcast 盲广播，收口为 bus.publish 定向发布（message.changeSetInvalidated
          // 归 stream 类：分配 seq + 入 ring，已订阅该 sid 的连接照常收到，未订阅连接不再被打扰）。
          this.messageBus?.publish(sessionId, {
            type: 'message.changeSetInvalidated',
            id: this.broker.nextPushId(),
            payload: { sessionId, reason },
          })
        },
      })
    }
    if (this.fileService) {
      this.fileMessageHandler = new FileMessageHandler({
        ...messaging,
        fileService: this.fileService,
      })
    }
    if (workspace) {
      this.workspaceMessageHandler = new WorkspaceMessageHandler({
        ...messaging,
        workspaceService: workspace,
      })
    }
    if (project) {
      this.projectMessageHandler = new ProjectMessageHandler({
        ...messaging,
        projectStore: project,
      })
    }
    if (worktree) {
      this.worktreeMessageHandler = new WorktreeMessageHandler({
        ...messaging,
        worktreeService: worktree,
        // perf 03 §5 worktree 检查点闭环（2026-08-17）：worktree.create 成功后按 cwd 失效
        // git 状态缓存。与 GitMessageHandler 共享同一 gitService 实例（组合根注入）；
        // git 未注入时为 null，handler 跳过失效（防御，成功 reply 不受影响）。
        gitService: this.gitService ?? null,
      })
    }
    if (terminal) {
      this.terminalMessageHandler = new TerminalMessageHandler({
        ...messaging,
        terminalService: terminal,
      })
    }
    if (quota) {
      this.quotaMessageHandler = new QuotaMessageHandler({
        ...messaging,
        quotaService: quota,
        // quota.configure 成功后广播 provider 列表（renderer providers 快照即时刷新）
        broadcastProviderList: () => this.broker.broadcastProviderList(),
      })
    }
    // UsageStatsService 构造参数有默认值 getSessionsDir()，无需外部注入
    this.usageMessageHandler = new UsageMessageHandler({
      ...messaging,
      usageStatsService: new UsageStatsService(),
    })
    if (preset) {
      this.presetMessageHandler = new PresetMessageHandler({
        ...messaging,
        presetService: preset,
      })
    }
    if (btw) {
      this.btwMessageHandler = new BtwMessageHandler({
        ...messaging,
        btwService: btw.service,
        resolveMain: btw.resolveMain,
        // state topic 'btw' 广播通道：组合根在 setServices 前已 setMessageBus（与
        // sessionHandler ctx 同款时序前提，server.messageBus 在本阶段恒就绪）。
        messageBus: this.messageBus,
        nextPushId: () => this.broker.nextPushId(),
      })
    }
  }

  /** SessionManagerHandler：agent-managed session 请求处理（select 通道 + SESSION_MANAGER_MARKER）。 */
  private assembleSessionManagerHandler(optional: RuntimeServerOptionalServices): void {
    const { delivery, workspace } = optional
    // 不走 WS 路由表——由 EventInterpreter.onSessionManagerRequest fire-and-forget 调用。
    // sd-u5：delivery（send 排队投递 + create 直投）必注入——组合根装配 sessionId 单例注册表；
    // 缺省时现场构造无 settled 订阅的退化实例（内核自动退化为退避轮询，D8 兜底），仅兜测试装配遗漏。
    // PR #189 review（arch/data-gov）：退化构造必须留痕——静默构造第二个无 settled 订阅的
    // 注册表违反 sessionId 单例约束（design.md §3.4），组合根漏注入时靠本 warn 显形。
    if (!delivery) {
      console.warn('[server] degenerate delivery registry constructed — missing injection?')
    }
    this.sessionManagerHandler = new SessionManagerHandler({
      sessionService: this.sessionService,
      delivery:
        delivery ??
        createSessionDeliveryRegistry({
          getSession: (sid) => this.sessionService.getSession(sid),
          ensureActive: (sid) => this.sessionService.ensureActive(sid),
          subscribeAgentSettled: () => () => {},
          recordWorkspace: (cwd) => workspace?.record(cwd),
          // [A2 D-A2-2] 退化实例无 bus——skill 注入文本处理照常、notice 发布 no-op
          //（与组合根注入的正例形成显式降级，上方 warn 已留痕）。
          getMessageBus: () => null,
        }),
      sendExtensionUiResponse: (sessionId, requestId, response, method) => {
        // requestId 只在发起方 pi 进程的 pending 表有效——按 sessionId 直发，
        // 不能遍历找「第一个可用 client」（多 active session 会错发 → 发起方 select 挂到超时）
        this.sessionService.getRpcClient(sessionId)?.sendExtensionUiResponse(requestId, response, method)
      },
      broadcastSessionList: () => {
        this.broker.broadcastSessionList()
      },
    })
  }

  // ── Build the central dispatch table (D1) ───────────────────────
  // ping 内联（无对应 handler）；file.read 已迁入 fileMessageHandler（W2）；settings 走兜底（见 handleMessage）。
  // git/file handler 可选（取决于 setServices 是否注入对应 service）：捕获到局部变量后判空，
  // 避免 `?.` 在 .map 闭包内类型收窄失效（async 回调里 TS 不保证 this.gitMessageHandler 未变）。
  private buildRoutes(): Map<ClientMessageType, (msg: ClientMessage, ws: WsType) => Promise<unknown> | unknown> {
    const gitHandler = this.gitMessageHandler
    const fileHandler = this.fileMessageHandler
    const workspaceHandler = this.workspaceMessageHandler
    const projectHandler = this.projectMessageHandler
    const worktreeHandler = this.worktreeMessageHandler
    const terminalHandler = this.terminalMessageHandler
    const quotaHandler = this.quotaMessageHandler
    const usageHandler = this.usageMessageHandler
    const presetHandler = this.presetMessageHandler
    const btwHandler = this.btwMessageHandler
    return new Map([
      ['ping', (msg, ws) => this.broker.reply(ws, msg.id, 'pong', {})],
      // u7c（crash-forensics D5）：滚动重启状态只读查询（与 request 同名 reply；provider
      // 缺席回 idle 形态——renderer 拉到 idle 即「横幅不重现」，见 RollingRestartStatusPayload）。
      ['rollingRestart.status', (msg, ws) => this.broker.reply(ws, msg.id, 'rollingRestart.status',
        this.rollingRestartStatusProvider?.() ?? { state: 'idle', inflight: { inFlight: null } })],
      ['session.compact', (msg, ws) => this.sessionHandler.handleSessionCompact(msg as Extract<ClientMessage, { type: 'session.compact' }>, ws)],
      ...this.sessionHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.sessionHandler.handleSessionMessage(msg, ws)] as const),
      ...this.extensionHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.extensionHandler.handleExtensionMessage(msg, ws)] as const),
      ...this.pluginMessageHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.pluginMessageHandler.handlePluginMessage(msg, ws)] as const),
      ...(gitHandler ? gitHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => gitHandler.handleGitMessage(msg, ws)] as const) : []),
      ...(fileHandler ? fileHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => fileHandler.handleFileMessage(msg, ws)] as const) : []),
      ...(workspaceHandler ? workspaceHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => workspaceHandler.handleWorkspaceMessage(msg, ws)] as const) : []),
      ...(projectHandler ? projectHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => projectHandler.handleProjectMessage(msg, ws)] as const) : []),
      ...(worktreeHandler ? worktreeHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => worktreeHandler.handleWorktreeMessage(msg, ws)] as const) : []),
      ...(terminalHandler ? terminalHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => terminalHandler.handleTerminalMessage(msg, ws)] as const) : []),
      ...(quotaHandler ? quotaHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => quotaHandler.handleQuotaMessage(msg, ws)] as const) : []),
      ...usageHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => usageHandler.handleUsageMessage(msg, ws)] as const),
      ...(presetHandler ? presetHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => presetHandler.handlePresetMessage(msg, ws)] as const) : []),
      // btw 三帧（btw-question M2-b / D6）：create/list/remove → BtwMessageHandler。
      ...(btwHandler ? btwHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => btwHandler.handleBtwMessage(msg, ws)] as const) : []),
    ] as Array<[ClientMessageType, (msg: ClientMessage, ws: WsType) => Promise<unknown> | unknown]>)
  }

  // ── IMessageBroker 委托（index.ts 把 server 当 broker 注入 PluginService/SessionService）──

  send(ws: WsType, msg: ServerMessage): void { this.broker.send(ws, msg) }
  broadcast(msg: ServerMessage): void { this.broker.broadcast(msg) }
  sendError(ws: WsType, code: string, message: string, id?: string, details?: ErrorDetails): void {
    this.broker.sendError(ws, code, message, id, details)
  }
  /**
   * fast-handoff（BLOCKER 2 / WARNING nextPushId）：暴露 broker 的 broadcast helper / push id 生成器，
   * 供 index.ts 注入到 HandoffService（与 session-message-handler 的 create/fork/delete/rename 一致）。
   */
  broadcastSessionList(): void { this.broker.broadcastSessionList() }
  /**
   * D8-2：暴露 broker 的 app.info 广播，供 index.ts 在 piVersion 探测完成后补发
   * （版本标签先显示应用版本，探测完成后自动更新）。
   */
  broadcastAppInfo(): void { this.broker.broadcastAppInfo() }
  /**
   * W2：暴露 broker 的 skill 缓存失效广播，供 index.ts 的 skillRegistry.onChange 回调调用
   * （skill 变动 → 广播 config.skillCacheInvalidated 让 landing composable 失效缓存重拉）。
   * partial 透传（RT-1#9 降级补发标注）。
   */
  broadcastSkillCacheInvalidated(scope: SkillCacheScope, cwd?: string, partial?: boolean): void { this.broker.broadcastSkillCacheInvalidated(scope, cwd, partial) }
  nextPushId(): string { return this.broker.nextPushId() }

  // ── Message routing ───────────────────────────────────────────

  private async handleMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    try {
      const route = this.routes.get(msg.type)
      if (route) {
        await route(msg, ws)
        return
      }
      // Settings 是兜底 handler：它内部 switch 命中返回 true，未命中返回 false（→ unknown_type）。
      if (!await this.settingsHandler.handleSettingsMessage(msg, ws)) {
        const rawMsg = msg as { type: string; payload?: { sessionId?: string } }
        this.broker.sendError(ws, 'unknown_type', `Unknown message type: ${rawMsg.type}`, msg.id, { sessionId: rawMsg.payload?.sessionId })
      }
    } catch (e) {
      const message = toErrorMessage(e)
      // RT-1#3：payload 可能缺省/为原始值（畸形帧已过 JSON.parse 层）——`'sessionId' in msg.payload`
      // 在 undefined 上抛 TypeError，会替换掉原 handler 异常（catch 内二次抛）。可选链消除二次抛。
      const sessionId = (msg.payload as { sessionId?: string } | undefined)?.sessionId
      // L4 增强：error 自带 code（如 MODEL_NOT_CONFIGURED）时透传，前端据此差异化引导；否则回退 handler_error。
      const code = (e as Error & { code?: string }).code ?? 'handler_error'
      try {
        this.broker.sendError(ws, code, message, msg.id, sessionId ? { sessionId } : undefined)
      } catch (envelopeError) {
        // error envelope 发送自身失败（ws TOCTOU 已关闭等）：原 handler 异常不能随之丢失——
        // 以 cause 保留上抛（Error options cause，仓内既有范式），由 connection-manager 兜底
        // 漏斗打印 + 补发 sessionId 信封。
        throw new Error(
          `handler error envelope send failed (original: ${message}; envelope error: ${toErrorMessage(envelopeError)})`,
          { cause: e },
        )
      }
    }
  }

  // ── Extension UI request lifecycle delegation ─────────────────────

  registerExtensionTimeout(sessionId: string, requestId: string, method: string, payload: Record<string, unknown>): void {
    // 只做 session 跟踪登记 + pending 缓存：交互式 UI 请求无超时（2026-07-16 取消），
    // block 等待用户决策，session 结束由 clearExtensionTimeoutsForSession 统一清理
    this.extensionTimeoutMgr.trackUiRequest(sessionId, requestId, method)
    // 缓存 pending 请求（ask-user 等阻塞式请求），session 重新激活时推送
    this.extensionTimeoutMgr.cachePendingRequest(sessionId, requestId, method, payload)
  }

  clearExtensionTimeout(requestId: string): void {
    this.extensionTimeoutMgr.clearTimeout(requestId)
  }

  clearExtensionTimeoutsForSession(sessionId: string): void {
    this.extensionTimeoutMgr.clearForSession(sessionId)
  }

  /**
   * 摘除 session 的全部挂起 UI 请求并推送失效帧（P2-2 失效链单一出口）。
   *
   * 非 respond 方式终结挂起（abort turn / 退出 plan / 回收 / session 销毁）时调用：
   * 摘除 runtime pending 缓存 + 发布 extension:requestsInvalidated，renderer 移除本屏
   * 对应审批条/表单。返回被摘清单（空清单不发布——常态 abort 无挂起，帧无意义）。
   */
  invalidatePendingUiRequests(sessionId: string, reason: string): PendingUIRequestResolved[] {
    const invalidated = this.extensionTimeoutMgr.invalidatePendingForSession(sessionId)
    if (invalidated.length > 0) {
      if (this.messageBus) {
        // wave:perf-w09 纪律收口（changeSetInvalidated R-08 同族先例）：payload 带 sessionId
        // 的 session 级 push 型消息必须走 bus.publish——broker.broadcast 会触发哨兵误报
        //（message-broker broadcast 的 session-scoped warn）且不占 seq 不入 ring，断连重连/
        // 切回 session 无法回放。TOPIC_TABLE 登记 stream 档：分配 seq + 入 ring（一次性失效
        // 信号、需可靠送达，session.restored 同款理由；renderer removeRequest 幂等，回放
        // 重复帧无副作用）。
        this.messageBus.publish(sessionId, {
          type: EXTENSION_EVENTS.REQUESTS_INVALIDATED as ServerMessageType,
          id: this.broker.nextPushId(),
          payload: { sessionId, requestIds: invalidated.map((r) => r.requestId), reason },
        })
      } else {
        // MF-1-8：bus 缺失 = 失效帧静默丢失，与上注「一次性失效信号、需可靠送达」矛盾且
        // 不可诊断——warn-once 显形（RT-4#9 未知 customType 同款显形纪律）。组合根 index.ts
        // 恒注入 bus，本分支实际不可达，触达即装配顺序回归性破坏；按 sessionId 去重，
        // 波及面可归因（renderer 侧挂起审批条/表单将残留）。
        warnOnce(
          `invalidate-pending-ui-requests:${sessionId}`,
          `[server] extension:requestsInvalidated not delivered: sessionId=${sessionId} invalidated=${invalidated.length} reason=${reason} — message bus not wired, invalidation frame dropped (expected always-injected by composition root; investigate wiring order)`,
        )
      }
    }
    return invalidated
  }

  /**
   * 只读拉取该 session 的挂起 UI 请求快照（reaper-only，v6 第四案挂起表单豁免）。
   *
   * 与上方三个写口同族的薄委托（不暴露 manager 本体，不提供任何变更能力）；内部调
   * ExtensionTimeoutManager.getPendingRequests——该方法本就是非破坏性只读快照
   * （不消费/不移除），故 reaper 判定不会影响 pending 生命周期，也不影响 busy 预检。
   * scope = 全扩展（confirm/select/input/editor 全在内，不按扩展过滤）。
   */
  getPendingUiRequests(sessionId: string): PendingUIRequest[] {
    return this.extensionTimeoutMgr.getPendingRequests(sessionId)
  }

  async handleBridgeRequest(sessionId: string, requestId: string, method: string, data: Record<string, unknown>): Promise<void> {
    const client = this.sessionService.getRpcClient(sessionId)
    if (!client) {
      console.warn(`[server] bridge request for inactive session: ${sessionId}, method: ${method}`)
      return
    }
    await this.bridgeHandler.handleBridgeRequest(sessionId, requestId, method, data, client)
  }

  handleStatusSetUpdate(payload: { sessionId: string; key: string; text: string; textRaw?: string }): void {
    this.bridgeHandler.handleStatusSetUpdate(payload)
  }

  /**
   * session-manager 请求处理入口。由 EventInterpreter.onSessionManagerRequest fire-and-forget 调用。
   * 委托给 SessionManagerHandler.handle() 异步处理。
   */
  handleSessionManagerRequest(requestId: string, sessionId: string, action: SessionManagerAction | '__malformed__', params: Record<string, unknown>): void {
    this.sessionManagerHandler.handle(requestId, sessionId, action, params)
      .catch((e) => {
        console.error('[server] session-manager request failed:', toErrorMessage(e))
      })
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  start(): Promise<void> {
    return this.conn.start()
  }

  async stop(): Promise<void> {
    if (this.pluginService) await this.pluginService.shutdown()
    await this.sessionService.destroyAll()
    await this.conn.stop()
  }
}
