/**
 * Session message handler for session.* and message.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ServerMessage, PlanStateView, SessionSummary, SessionRevokeMessageReply } from '@taiji/shared'
// hook 否决类分类码值常量（词表 SSOT = shared MessageBlockedCode）：message.send /
// message.bash / delivery.submit 三落码点统一引用，不手抄字面量。
import { MESSAGE_BLOCKED_CODE } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import type { ISessionService } from '../interfaces.js'
import type { HandoffService } from '../services/handoff-service.js'
import type { ImportService } from '../services/session/import-service.js'
// zcode 会话库白名单（MF-3-1 wire 帧加固）：值 import——校验在 transport 边界执行，
// allowlist 推导是 zcode 库路径知识（宿主库/隔离库同文件 SSOT；session-reader-shared-core
// U10 起唯一承载 = @zhushanwen/zcode-session-source）。
import { zcodeImportDbAllowlist } from '@zhushanwen/zcode-session-source'
// BackgroundTaskService（background-task-sidebar D3，u-runtime-rpc）：仅类型 import——
// 实例由 SessionService 构造器组装（session-service 领地），handler 经 ctx 结构读取消费面。
import type { BackgroundTaskService } from '../services/background-task/background-task-service.js'
import { toErrorMessage, isEnoent, errorCodeOf, MODEL_NOT_CONFIGURED, SESSION_NOT_FOUND, RESTORE_FAILED } from '../utils/errors.js'
import type { MessageHandlerContext } from './message-context.js'
// MessageBus（wave:runtime-wiring）：session.subscribe/unsubscribe RPC handler 用它注册订阅。
// type-only import（handler 不持有 bus 实例的创建，只调它的方法）。
import type { IMessageBus } from '../services/message-bus/message-bus.js'
// GenStatsService（composer-gen-stats u3）：session.getGenStats 恢复腿 RPC 的降级链解析
// + 快照构造（写 3 回填在 getSnapshotForSession 内部完成）。可选注入：未注入时该 case 报
// unsupported（组合根保证注入；importService 同款模式）。
import type { GenStatsService } from '../services/session/gen-stats-service.js'
// BusClient（wave:bus-core）：ws 适配为 bus 订阅者的最小契约 { readyState, send }。
// ws 库的 WebSocket 天然满足，但类型不完全一致，用 as unknown as BusClient 显式标记边界（R2）。
import type { BusClient } from '../services/message-bus/types.js'
// delivery 域（投递所有权内核 D5，u3a）：session.delivery state topic 装配 + 四 RPC。
// type-only：注册表由组合根经 server.setServices({ delivery }) 注入（与 SessionManagerHandler
// 同一实例——sessionId 单例约束），transport 不构造它。
import type { SessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
import { SessionDeliveryTopic, frameLaneOf, frameStateOf, stripDeliveryMarkers } from './session-delivery-topic.js'

/**
 * backgroundTask 域 WS 消费端口（background-task-sidebar D3，u-runtime-rpc）：
 * BackgroundTaskService 的 handler 消费面窄视图（Pick 收窄——kill 五分支矩阵 / mtime 轮询
 * 等内部编排不对传输层暴露）。
 */
export type BackgroundTaskRpcPort = Pick<
  BackgroundTaskService,
  'listTasks' | 'getOutputTail' | 'killTask' | 'markWatched'
>

/**
 * backgroundTask.output 的 maxBytes 请求上界（D6 #1，BG-4）：客户端声明的字节窗口超此值
 * 钳制到 1MB（readOutputTail 按窗口 Buffer.alloc，无上界可被单请求打到内存失控）。
 * 与 MAX_FILE_SIZE（file.read 1MB 截断）同量级；导出供测试断言 clamp 行为。
 */
export const OUTPUT_TAIL_MAX_REQUEST_BYTES = 1_048_576

/** Interface for server methods needed by this handler */
export interface SessionHandlerContext extends MessageHandlerContext {
  /**
   * session 服务门面。交叉可选成员 = SessionService 上不在 ISessionService 接口面的
   * 消费端口（可选属性使组合根 server.ts setServices 的 ctx 对象字面量（静态类型
   * ISessionService）经结构兼容零改动通过类型检查——运行时实例恒有该成员；缺省仅出
   * 现在测试最小 mock 中，调用侧判空走防御分支）：
   * - backgroundTasks（background-task-sidebar D3）：BackgroundTaskService 的 handler
   *   消费面窄视图，case 内判空走 background_task_unsupported 防御分支。
   * - markSessionViewed（idle pi reclamation D2 #6，u1b）：session.switch 处理器记录
   *   查看时间戳（存储在 session-service 侧 per-sid Map）。可选链静默跳过而非报错——
   *   记录是 reaper 豁免信号（u2 消费），非 switch 主流程的一部分，最小 mock 缺该
   *   成员不应让 switch 请求失败。
   * - getPlanState（plan 模式重设计 D1⑥）：SessionRecords.getPlanState 冷路径读取
   *   （session-records.ts:510，磁盘 JSONL → scanPlanStateEntries 派生）。SessionService
   *   已按 workflowAction 同款形态转发（session-service.ts getWorkflows 转发区）；可选成员
   *   形态对齐 backgroundTasks 先例，缺省仅出现在测试最小 mock 中。
   * - notifySessionActivated（plugin-header-action-modal-points AP-4/u5a relay ①）：
   *   session.switch 成功分支投递激活信号（PluginService 注册回调 → didActivate 定向投递）。
   *   可选链防御与 markSessionViewed 同款——激活投递是旁路信号，最小 mock 缺该成员不应
   *   让 switch 请求失败。
   * - revokeMessage（message-revoke 设计 §3.3 D2，U4）：session.revokeMessage 七步编排
   *   （RevokeOrchestrator）的转发面。可选成员形态对齐 getPlanState 先例——缺省仅出现
   *   在测试最小 mock 中，case 内判空走 revoke_unsupported 防御分支。
   */
  sessionService: ISessionService & {
    readonly backgroundTasks?: BackgroundTaskRpcPort
    markSessionViewed?(sessionId: string): void
    getPlanState?(sessionId: string): Promise<PlanStateView>
    notifySessionActivated?(summary: SessionSummary): void
    revokeMessage?(sessionId: string, targetId: string): Promise<SessionRevokeMessageReply>
  }
  /** fast-handoff 编排层（session.handoff 路由用）。可选：未注入时该 case 报 unsupported。 */
  handoffService?: HandoffService
  /**
   * 导入 pi 会话服务（import-session D5/U2）：session.importCandidates / session.import 用。
   * 可选：未注入时该 case 报 unsupported（组合根保证注入；case 分发由 u3-rpc-wiring 落地）。
   */
  importService?: ImportService
  /**
   * MessageBus 单例（wave:runtime-wiring）：session.subscribe/unsubscribe RPC 用它注册/取消订阅。
   * 可选：未注入时 subscribe/unsubscribe case 报 unsupported（组合根保证注入）。
   */
  messageBus?: IMessageBus
  /**
   * 生成指标服务（composer-gen-stats u3）：session.getGenStats 恢复腿 RPC 用。
   * 可选：未注入时该 case 报 unsupported（组合根保证注入）。
   */
  genStatsService?: GenStatsService
  /**
   * 投递所有权内核注册表（投递所有权内核 D5，u3a）：delivery.* 四 RPC 与 session.delivery
   * state topic（帧装配数据源）共用。组合根经 server.setServices({ delivery }) 注入
   * （与 SessionManagerHandler 同一实例——registry 的 sessionId 单例约束）。
   * 可选：未注入时 delivery.* 报 delivery_unsupported 防御分支（组合根保证注入；
   * 缺省仅出现在测试最小 mock 中，对齐 backgroundTasks 惯例）。
   */
  deliveryRegistry?: SessionDeliveryRegistry
  nextPushId(): string
  broadcastSessionList(): void
  /** 广播一条 ServerMessage 给所有连接（FR-12：fork 后广播 session.forkNotice）。 */
  broadcast(msg: ServerMessage): void
  /** 摘除 session 挂起 UI 请求并广播失效帧（P2-2 失效链；server.invalidatePendingUiRequests 薄委托） */
  invalidatePendingUiRequests(sessionId: string, reason: string): void
}

/**
 * session/message case 路由表类型：每个消息 type 映射到对应 case 处理器，msg 参数按
 * key 窄化（Extract 收窄与 switch narrowing 行为一致——见 shared protocol.ts 的
 * ClientMessage 派生注释）。表驱动取代原 ~40 分支 switch：主函数只留「查表 + 命中调用」，
 * 每个 case 体是独立私有 helper（行为保持提取，复杂度债务偿还 W1）。
 */
type SessionCaseRoutes = {
  [K in ClientMessageType]?: (msg: Extract<ClientMessage, { type: K }>, ws: WsType) => Promise<void>
}

export class SessionMessageHandler {
  /**
   * session.delivery 帧发布器（D5/D7）：per-session 内核 onChange 订阅 + 全量快照发布。
   * 依赖经 ctx 按调用时刻读取（bus 由 setMessageBus 注入、registry 由 setServices 注入，
   * 均可能晚于本 handler 构造）。
   */
  private readonly deliveryTopic: SessionDeliveryTopic

  constructor(private ctx: SessionHandlerContext) {
    this.deliveryTopic = new SessionDeliveryTopic({
      getRegistry: () => this.ctx.deliveryRegistry,
      getBus: () => this.ctx.messageBus,
      nextPushId: () => this.ctx.nextPushId(),
    })
  }

  /**
   * 解绑某 session 的 session.delivery 订阅（session 销毁清理，由 server 的
   * onSessionDestroyed 汇聚点调用——覆盖主动删 / 进程退出 / restore 清场全部路径，
   * 与 extension timeout 清理同挂点）。幂等；内核条目清理由 registry.dispose 负责。
   */
  releaseDeliveryTopic(sessionId: string): void {
    this.deliveryTopic.release(sessionId)
  }

  /**
   * case 路由表：key 集合与原 switch case 一一对应。未知 type 查表落空即返回
   * （不发任何消息，同原 switch 无 default 的落空行为）。
   */
  private readonly routes: SessionCaseRoutes = {
    'session.create': (msg, ws) => this.handleSessionCreate(msg, ws),
    'session.restore': (msg, ws) => this.handleSessionRestore(msg, ws),
    'session.forceQuit': (msg, ws) => this.handleSessionForceQuit(msg, ws),
    'session.fork': (msg, ws) => this.handleSessionFork(msg, ws),
    'session.handoff': (msg, ws) => this.handleSessionHandoff(msg, ws),
    'session.abortHandoff': (msg, ws) => this.handleSessionAbortHandoff(msg, ws),
    'session.delete': (msg, ws) => this.handleSessionDelete(msg, ws),
    'session.deleteByCwd': (msg, ws) => this.handleSessionDeleteByCwd(msg, ws),
    'config.sessions': (msg, ws) => this.handleConfigSessions(msg, ws),
    'session.switch': (msg, ws) => this.handleSessionSwitch(msg, ws),
    'session.history': (msg, ws) => this.handleSessionHistory(msg, ws),
    'session.getSubagents': (msg, ws) => this.handleSessionGetSubagents(msg, ws),
    'session.getPlanState': (msg, ws) => this.handleSessionGetPlanState(msg, ws),
    'session.abortPlan': (msg, ws) => this.handleSessionAbortPlan(msg, ws),
    'session.getSubagentHistory': (msg, ws) => this.handleSessionGetSubagentHistory(msg, ws),
    'session.getSubagentEngineConfig': (msg, ws) => this.handleSessionGetSubagentEngineConfig(msg, ws),
    'session.setSubagentDefaultEngine': (msg, ws) => this.handleSessionSetSubagentDefaultEngine(msg, ws),
    'session.getWorkflows': (msg, ws) => this.handleSessionGetWorkflows(msg, ws),
    'session.getAgentCallHistory': (msg, ws) => this.handleSessionGetAgentCallHistory(msg, ws),
    'session.getAgentCallFilePath': (msg, ws) => this.handleSessionGetAgentCallFilePath(msg, ws),
    'session.workflowAction': (msg, ws) => this.handleSessionWorkflowAction(msg, ws),
    'session.subagentAction': (msg, ws) => this.handleSessionSubagentAction(msg, ws),
    'session.writeImage': (msg, ws) => this.handleSessionWriteImage(msg, ws),
    'session.migrateImage': (msg, ws) => this.handleSessionMigrateImage(msg, ws),
    'session.writeSegments': (msg, ws) => this.handleSessionWriteSegments(msg, ws),
    'session.subscribe': (msg, ws) => this.handleSessionSubscribe(msg, ws),
    'session.unsubscribe': (msg, ws) => this.handleSessionUnsubscribe(msg, ws),
    'session.getTraceEntries': (msg, ws) => this.handleSessionGetTraceEntries(msg, ws),
    'session.fetchCurrentSystemPrompt': (msg, ws) => this.handleSessionFetchCurrentSystemPrompt(msg, ws),
    'session.getCommands': (msg, ws) => this.handleSessionGetCommands(msg, ws),
    'session.getContext': (msg, ws) => this.handleSessionGetContext(msg, ws),
    'session.getGenStats': (msg, ws) => this.handleSessionGetGenStats(msg, ws),
    'session.rename': (msg, ws) => this.handleSessionRename(msg, ws),
    'session.setProject': (msg, ws) => this.handleSessionSetProject(msg, ws),
    'session.importCandidates': (msg, ws) => this.handleSessionImportCandidates(msg, ws),
    'session.import': (msg, ws) => this.handleSessionImport(msg, ws),
    // 消息撤回（message-revoke 设计 §3.3 D2，U4）：已送达消息的 session 树内回退。
    // reply 与 request 同名（payload 消费型），领域回执（revoked/error 六码，D8 SSOT）
    // 不走 error envelope——六码是设计内回执非传输错误。
    'session.revokeMessage': (msg, ws) => this.handleSessionRevokeMessage(msg, ws),
    'message.send': (msg, ws) => this.handleMessageSend(msg, ws),
    'message.abort': (msg, ws) => this.handleMessageAbort(msg, ws),
    'message.bash': (msg, ws) => this.handleMessageBash(msg, ws),
    'message.abortBash': (msg, ws) => this.handleMessageAbortBash(msg, ws),
    // delivery 域（投递所有权内核 D5，u3a）：四 RPC（reply 与 request 同名，payload 消费型）。
    'delivery.submit': (msg, ws) => this.handleDeliverySubmit(msg, ws),
    'delivery.cancel': (msg, ws) => this.handleDeliveryCancel(msg, ws),
    'delivery.drain': (msg, ws) => this.handleDeliveryDrain(msg, ws),
    'delivery.resync': (msg, ws) => this.handleDeliveryResync(msg, ws),
    // backgroundTask 域（background-task-sidebar D3，u-runtime-rpc）：后台命令拉取/详情/终止 3 RPC。
    // 变更广播不经此处（SessionService 组装的 onTasksChanged → bus.publish 单向推送）。
    'backgroundTask.list': (msg, ws) => this.handleBackgroundTaskList(msg, ws),
    'backgroundTask.output': (msg, ws) => this.handleBackgroundTaskOutput(msg, ws),
    'backgroundTask.kill': (msg, ws) => this.handleBackgroundTaskKill(msg, ws),
  }

  /**
   * D1: 本 handler 认领的 ClientMessageType 清单——派生自 routes 表（S1 收敛：单一事实源，
   * 「只改 handles 漏改 routes」的漂移类结构性消灭，RT-1#6 运行时守卫随之退为纯防御）。
   * 不含 session.compact：它由 server 路由表直接接 handleSessionCompact（不经本表分发），
   * 且 server 装配期 b26-F2 撞键 fail-fast 会把双登记拦死——与退役前手写清单的排除理由一致。
   * 声明必须位于 routes 之后（字段初始化按声明序执行，派生读 this.routes）。
   */
  readonly handles: ClientMessageType[] = Object.keys(this.routes) as ClientMessageType[]

  async handleSessionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    const handler = this.routes[msg.type]
    // RT-1#6：落空不再静默 return——handles 清单与内部 routes 表漂移（漏登记）时，
    // 前端 pending Promise 只能等到泛化超时。显式 error 信封 + error 日志双显形。
    if (!handler) {
      console.error(`[session-handler] no case handler for type "${msg.type}" — handles/routes 表漂移？`)
      const rawSessionId = (msg.payload as { sessionId?: unknown } | undefined)?.sessionId
      return this.ctx.sendError(
        ws,
        'handler_not_registered',
        `No case handler registered for message type: ${msg.type}`,
        msg.id,
        typeof rawSessionId === 'string' && rawSessionId ? { sessionId: rawSessionId } : undefined,
      )
    }
    // 路由表 key 与 msg.type 字面量同源（上方 routes 逐 key 登记），查表命中即类型匹配；
    // TS 无法静态关联索引访问与 key（correlated types，microsoft/TypeScript#30581），
    // `as never` 是该不变式下的类型层收口，运行时分发行为与原 switch 完全一致。
    await handler(msg as never, ws)
  }

  // ── 失败收口 / 可选服务守卫（S3 收敛：catch 尾三连与判空样板单一实现）──

  /**
   * 请求级失败统一收口（D10/P0-B）：toErrorMessage 归一 + console.error 留痕 + error envelope。
   * envelope 四元组（code/message/id/details）与收敛前各 case 逐字节一致；message 覆写槽供
   * 需拼恢复指引的 case 使用（留痕恒记原始 errMsg，与收敛前日志一致）。
   * import 域的「code 透传变体」不入本 helper：其日志嵌 resolved code（errorCodeOf 求值先于
   * sendError），两段式日志形状不同，保留内联。
   */
  private reportFailure(
    ws: WsType,
    msgId: string | undefined,
    code: string,
    e: unknown,
    opts: { scope: string; sessionId?: string; message?: string },
  ): void {
    const errMsg = toErrorMessage(e)
    console.error(`[runtime] ${opts.scope} failed:`, errMsg)
    return this.ctx.sendError(ws, code, opts.message ?? errMsg, msgId, opts.sessionId !== undefined ? { sessionId: opts.sessionId } : undefined)
  }

  /**
   * delivery 域可选注册表守卫（四 RPC 共用）：缺省时回 delivery_unsupported error envelope
   * 并返回 undefined（调用方早退）；命中返回注册表实例。
   */
  private requireDeliveryRegistry(ws: WsType, msg: { id?: string }, sessionId: string): SessionDeliveryRegistry | undefined {
    const registry = this.ctx.deliveryRegistry
    if (!registry) {
      this.ctx.sendError(ws, 'delivery_unsupported', 'delivery registry not available', msg.id, { sessionId })
      return undefined
    }
    return registry
  }

  /**
   * backgroundTask 域可选端口守卫（三 RPC 共用）：缺省时回 background_task_unsupported
   * error envelope 并返回 undefined（调用方早退）；命中返回服务消费面窄视图。
   */
  private requireBackgroundTasks(ws: WsType, msg: { id?: string }, sessionId: string): BackgroundTaskRpcPort | undefined {
    const port = this.ctx.sessionService.backgroundTasks
    if (!port) {
      this.ctx.sendError(ws, 'background_task_unsupported', 'background task service not available', msg.id, { sessionId })
      return undefined
    }
    return port
  }

  // ── case handlers（原 switch case 体逐一提取；语句与注释原样保留，行为保持）──

  private async handleSessionCreate(msg: Extract<ClientMessage, { type: 'session.create' }>, ws: WsType): Promise<void> {
    // B3：透传 modelOverride / thinkingOverride（Landing Chip 覆盖值，设计文档 §5.2）。
    // 优先级：Landing Chip override > preset.modelOverride/thinkingLevel > 全局默认。
    // 之前只透传了 hidden/presetId，覆盖值在 transport 层被丢弃，导致 Landing Chip 选型不生效。
    // projectId：D14 语义修正（2026-08-04），创建时归属当前 activeProject（空 = 默认项目兑底）。
    // 错误路径直通 server 中央 catch（S2 收敛）：create payload 无 sessionId 字段，中央
    // code 透传（含 MODEL_NOT_CONFIGURED L4 差异化引导）产出的信封与原 per-case 特判逐字节一致。
    const session = await this.ctx.sessionService.create(msg.payload.cwd, msg.payload.label, {
      hidden: msg.payload.hidden,
      presetId: msg.payload.presetId,
      projectId: msg.payload.projectId,
      modelOverride: msg.payload.modelOverride,
      thinkingOverride: msg.payload.thinkingOverride,
    })
    this.ctx.reply(ws, msg.id, 'session.created', { session })
    this.ctx.broadcastSessionList()
  }

  private async handleSessionRestore(msg: Extract<ClientMessage, { type: 'session.restore' }>, ws: WsType): Promise<void> {
    try {
      const session = await this.ctx.sessionService.restoreSession(msg.payload.sessionId)
      this.ctx.reply(ws, msg.id, 'session.created', { session })
      this.ctx.broadcastSessionList()
    } catch (e) {
      const code = (e as Error & { code?: string }).code
      if (code === MODEL_NOT_CONFIGURED) {
        this.ctx.sendError(ws, MODEL_NOT_CONFIGURED, toErrorMessage(e), msg.id)
        return
      }
      if (code === SESSION_NOT_FOUND) {
        this.ctx.sendError(ws, SESSION_NOT_FOUND, toErrorMessage(e), msg.id)
        return
      }
      // spawn pi / switchSession / initialize 失败统一归为 restore_failed
      this.ctx.sendError(ws, RESTORE_FAILED, toErrorMessage(e), msg.id)
    }
  }

  private async handleSessionForceQuit(msg: Extract<ClientMessage, { type: 'session.forceQuit' }>, ws: WsType): Promise<void> {
    // 强杀 pi 进程 + stopped 收敛（终态经 session.exited 广播推回，不依赖 reply）。
    // reply message.status ack（与 message.abort 对称），否则 renderer pending.register(id) 永挂。
    const sessionId = msg.payload.sessionId
    await this.ctx.sessionService.forceQuit(sessionId)
    this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'force_quit' })
  }

  private async handleSessionFork(msg: Extract<ClientMessage, { type: 'session.fork' }>, ws: WsType): Promise<void> {
    // fork：runtime 读源 JSONL 截断 → 新进程 switch_session。reply session.created（复用类型）。
    // 错误路径直通 server 中央 catch（S2 收敛，理由同 handleSessionCreate）：fork payload 无
    // sessionId 字段（仅 srcSessionId），中央 code 透传信封与原 per-case MODEL 特判逐字节一致。
    const { srcSessionId, fromPiEntryId, fromMessageTimestamp, fromMessageRole, includeFrom, label, modelOverride, thinkingOverride } = msg.payload
    const session = await this.ctx.sessionService.forkSession(
      srcSessionId, fromPiEntryId, includeFrom ?? true, label,
      // Staging Mode（ADR-0056）：透传 composer 暂存的 modelOverride/thinkingOverride，
      // 让 fork 出的新 session 用用户当前选定的模型/思考等级，而非单纯继承源 preset。
      { fromMessageTimestamp, fromMessageRole, modelOverride, thinkingOverride },
    )
    this.ctx.reply(ws, msg.id, 'session.created', { session })
    // [W2 FR-12] fork 成功后广播 session.forkNotice：通知 srcSession 所在 panel
    // 在对话流插一条 ForkNotice 反馈行（spec §3）。广播在 reply + broadcastSessionList 之后，
    // 确保新 session 已入列表 + reply 已发出（前端可据 newSessionId 跳转）。
    this.ctx.broadcast({
      type: 'session.forkNotice',
      id: this.ctx.nextPushId(),
      payload: { srcSessionId, newSessionId: session.id, branchName: label },
    })
    this.ctx.broadcastSessionList()
  }

  private async handleSessionHandoff(msg: Extract<ClientMessage, { type: 'session.handoff' }>, ws: WsType): Promise<void> {
    // handoff：runtime 直接从对话历史组装文档（同步编排）。
    // 流程：getHistory → assembleHandoffDoc → create 新 session → 注入文档 → 广播。
    // 不再调用 pi skill，不需要 agent_end / onTurnEnd 回调。
    const { sessionId, reply } = msg.payload
    const hs = this.ctx.handoffService
    if (!hs) {
      // handoffService 未注入（理论不可达——组合根必传），防御性报错。
      return this.ctx.sendError(ws, 'handoff_unsupported', 'handoff service not available', msg.id, { sessionId })
    }
    try {
      // Staging Mode（ADR-0056）：透传 modelOverride/thinkingOverride 给新 session 创建。
      // 源 session 的 handoff turn 仍用源 session 自身模型，override 只作用于新建的承接 session。
      await hs.runHandoff(sessionId, reply, {
        modelOverride: msg.payload.modelOverride,
        thinkingOverride: msg.payload.thinkingOverride,
      })
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
    } catch (e) {
      // L4: model 未配置时上抛交由 server 中央 catch 透传（S2 收敛：handoff payload 带
      // sessionId，中央透传的 code/message/details 与原 per-case 特判信封逐字节一致），
      // 前端据此引导去 Settings 配置，而非泛化的 handoff_failed 气泡。
      if (errorCodeOf(e) === MODEL_NOT_CONFIGURED) throw e
      // runHandoff 失败（历史为空 / session 不存在 / 已有进行中 handoff）走 error envelope。
      // 所有错误路径统一走此处的 sendError，不再有 onTurnEnd 内部广播路径。
      return this.reportFailure(ws, msg.id, 'handoff_failed', e, { scope: 'session.handoff', sessionId })
    }
  }

  private async handleSessionAbortHandoff(msg: Extract<ClientMessage, { type: 'session.abortHandoff' }>, ws: WsType): Promise<void> {
    // abortHandoff：中断进行中的 handoff turn（调 handoffService.abortHandoff → 内部 client.abort + 清 inflight）。
    // W1：abortHandoff 返回 boolean——只有 inflight 真存在（真正 abort）才广播 session.handoffAborted
    // 让前端复位 isHandingOff；inflight 无（no-op，如用户重复点取消、或 handoff 已完成）不广播，
    // 避免前端先收 aborted 再收 complete 的 UX 抖动。reply message.status{aborted} 始终发（RPC ack）。
    const { sessionId } = msg.payload
    const hs = this.ctx.handoffService
    if (!hs) {
      return this.ctx.sendError(ws, 'handoff_unsupported', 'handoff service not available', msg.id, { sessionId })
    }
    try {
      const aborted = await hs.abortHandoff(sessionId)
      if (aborted) {
        // 真正中断了 → 广播 handoffAborted（参照 forkNotice L75-79 broadcast 范式）
        this.ctx.broadcast({
          type: 'session.handoffAborted',
          id: this.ctx.nextPushId(),
          payload: { srcSessionId: sessionId },
        })
      }
      // 无论 aborted 与否都 reply ack（RPC ack 让 renderer pending resolve）
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'aborted' })
    } catch (e) {
      return this.reportFailure(ws, msg.id, 'handoff_failed', e, { scope: 'session.abortHandoff', sessionId })
    }
  }

  private async handleSessionDelete(msg: Extract<ClientMessage, { type: 'session.delete' }>, ws: WsType): Promise<void> {
    // D6a：挂起 UI 请求清理（extensionTimeoutMgr）不经此处直接调用——已汇聚到
    // onSessionDestroyed 回调（server.ts setServices 注册，removeSessionEntry 触发，
    // 覆盖主动删 / 进程退出 / restore 清场全部路径），单一清理入口。
    const delSid = msg.payload.sessionId
    await this.ctx.sessionService.delete(delSid)
    this.ctx.reply(ws, msg.id, 'session.deleted', { sessionId: delSid })
    this.ctx.broadcastSessionList()
  }

  private async handleSessionDeleteByCwd(msg: Extract<ClientMessage, { type: 'session.deleteByCwd' }>, ws: WsType): Promise<void> {
    // deleteByCwd 是 best-effort 聚合（永远 resolve）。清理同 session.delete：经
    // onSessionDestroyed 汇聚点统一触发（deleted 的 active session 走 removeSessionEntry；
    // 非 active 的本就无 in-flight 挂起状态），不再按 result.deleted 逐个直接调用。
    // cwd 非空字符串校验：与 extension-message-handler 的 invalid_payload 范式对齐。
    // 不走「reply 空 BatchDeleteResult 成功」——那会让前端误判删除成功，掩盖参数错误。
    const cwd = msg.payload?.cwd
    if (!cwd || typeof cwd !== 'string') {
      return this.ctx.sendError(ws, 'invalid_payload', 'session.deleteByCwd requires a non-empty "cwd" string', msg.id)
    }
    const result = await this.ctx.sessionService.deleteByCwd(cwd)
    this.ctx.reply(ws, msg.id, 'session.deletedByCwd', result)
    this.ctx.broadcastSessionList()
  }

  private async handleConfigSessions(msg: Extract<ClientMessage, { type: 'config.sessions' }>, ws: WsType): Promise<void> {
    return this.ctx.reply(ws, msg.id, 'config.sessions', { groups: this.ctx.sessionService.listPersistedSessions() })
  }

  private async handleSessionSwitch(msg: Extract<ClientMessage, { type: 'session.switch' }>, ws: WsType): Promise<void> {
    // wave:perf-w20（R-11 瘦身）：switch reply 不再无条件全量 getHistory 塞 messages。
    // renderer switchSession 返回 void 不读 reply payload，历史消费路径是 selectSession
    // 内显式 chat.getHistory（session.history RPC）——reply 里的 messages 是纯浪费的
    // 全量序列化（长 session 数 MB）。被驱逐 session 切回由显式 history RPC（享受 D6
    // 重建缓存增量）拉取；LRU 窗口内切回本就零请求（isHydrated 守卫）。
    const switchId = msg.payload.sessionId
    // idle pi reclamation D2 #6：switch 即用户查看该 session，记录时间戳供 reaper 查看豁免
    // 判定（u2 消费，30 分钟窗口内不回收）。挂点在处理器入口（getSummary 之前）：switch
    // 请求到达即查看意图已发生，summary 命中与 ensureActive 恢复两条分支都覆盖，也不依赖
    // 恢复成败。try/catch 隔离：记录失败只损失一次豁免信号，绝不能拖垮 switch 主流程
    // （reply 语义不变）；warn 落日志留排查线索（非静默吞，对齐 session-api 注册失败记
    // 日志先例）。
    try {
      this.ctx.sessionService.markSessionViewed?.(switchId)
    } catch (e) {
      // 降级策略（best-effort）：查看时间戳只喂 reaper 豁免判定（u2），记录失败损失
      // 一次豁免信号但switch 主流程照常；warn 留排查线索不静默。
      console.warn('[runtime] session.switch markSessionViewed failed:', toErrorMessage(e))
    }
    const summary = this.ctx.sessionService.getSummary(switchId)
    if (summary) {
      this.notifySessionActivatedSafe(summary)
      this.ctx.reply(ws, msg.id, 'session.switched', { sessionId: switchId, session: summary })
    } else {
      try {
        await this.ctx.sessionService.ensureActive(switchId)
        const restored = this.ctx.sessionService.getSummary(switchId)
        if (!restored) {
          throw new Error(`Session ${switchId} restored but summary unavailable`)
        }
        // 自动 restore 分支同投递（AP-4：switch 成功含其自动 restore 路径——冷启动/崩溃恢复
        // 后的补拉由 didActivate 承接，场景 9「重启后仍正确」）。
        this.notifySessionActivatedSafe(restored)
        this.ctx.reply(ws, msg.id, 'session.switched', { sessionId: switchId, session: restored })
      } catch (e) {
        const errMsg = toErrorMessage(e)
        const isENOENT = isEnoent(e)
        const userMsg = isENOENT
          ? `Session file missing — the session was not saved properly. Error: ${errMsg}`
          : `Session ${switchId} not found or restore failed`
        console.error('[runtime] session.switch auto-restore failed:', errMsg)
        this.ctx.sendError(ws, isENOENT ? 'file_not_found' : 'not_found', userMsg, msg.id, { sessionId: switchId })
      }
    }
  }

  /**
   * relay ①（plugin-header-action-modal-points AP-4/u5a）：switch 成功 → 激活信号投递。
   * 可选链防御（SessionHandlerContext 注释：最小 mock 缺该成员不失败）+ try/catch（markSessionViewed
   * 同款——投递失败只损失一次激活信号，绝不拖垮 switch 主流程；reply 语义不变）。
   * 注册侧链路：session-service.onSessionActivated（追加式回调列表）→ PluginService
   * sessionEventDispatch.didActivate 定向投递 Worker。
   */
  private notifySessionActivatedSafe(summary: SessionSummary): void {
    try {
      this.ctx.sessionService.notifySessionActivated?.(summary)
    } catch (e) {
      // 降级策略（best-effort）：激活投递只损失一次补拉信号（插件下次失效订阅/激活重试可收敛），
      // switch 主流程照常（reply 语义不变）；warn 落日志留排查线索（非静默吞，无需豁免）。
      console.warn('[runtime] session.switch notifySessionActivated failed:', toErrorMessage(e))
    }
  }

  private async handleSessionGetGenStats(msg: Extract<ClientMessage, { type: 'session.getGenStats' }>, ws: WsType): Promise<void> {
    // composer-gen-stats（D4）：生成指标恢复腿。reply = session.stats_update payload 同形
    // （GenStatsFrame）；modelId 解析降级链（get_state → 内存映射 → replicated states →
    // 全 null）+ 写 3 回填全部在 service.getSnapshotForSession 内部完成，handler 只透传。
    const genStats = this.ctx.genStatsService
    if (!genStats) {
      return this.ctx.sendError(ws, 'gen_stats_unsupported', 'gen stats service not available', msg.id)
    }
    const { sessionId } = msg.payload
    const frame = await genStats.getSnapshotForSession(sessionId)
    return this.ctx.reply(ws, msg.id, 'session.stats_update', frame)
  }

  // ── backgroundTask 域（background-task-sidebar §3.3 D3/D7/D8，u-runtime-rpc）──

  private async handleBackgroundTaskList(msg: Extract<ClientMessage, { type: 'backgroundTask.list' }>, ws: WsType): Promise<void> {
    // renderer 切 session / 打开「后台命令」tab 主动拉取（C6 时序竞争：广播只做增量，
    // 拉取是唯一真相）。副作用 = 把 session 加入 watched 集合（D8③，订阅语义由 list
    // 隐含，D3 被否 subscribe/unsubscribe 专设消息）。顺序：先读后 mark——markWatched
    // 以当前 mtime 为基线（「调用方刚拉取过全量」语义），之后的变更才触发广播，不重播。
    const listSid = msg.payload.sessionId
    const port = this.requireBackgroundTasks(ws, msg, listSid)
    if (!port) return
    const { entries, corrupted } = port.listTasks(listSid)
    port.markWatched(listSid)
    return this.ctx.reply(ws, msg.id, 'backgroundTask.tasks', { sessionId: listSid, tasks: entries, corrupted })
  }

  private async handleBackgroundTaskOutput(msg: Extract<ClientMessage, { type: 'backgroundTask.output' }>, ws: WsType): Promise<void> {
    // 输出尾部按需读（D7）。tail undefined = 条目不存在 / 输出文件不可读（§3.1 失败
    // 路径「输出不可用（文件已清理）」）→ lost 语义降级：text 空串 + truncated false，
    // reply 正常回执（不走 error envelope——文件清理是预期态，非请求失败）。
    // maxBytes clamp 1MB（D6 #1，BG-4）：客户端传超大窗口时钳制——协议字段无上界约束，
    // 不钳制则单请求 Buffer.alloc(maxBytes) 可被恶意/失控客户端打到内存失控。
    const { sessionId: outSid, taskId, maxBytes } = msg.payload
    const port = this.requireBackgroundTasks(ws, msg, outSid)
    if (!port) return
    // wire 预检（对齐 delivery 域 invalid_payload 范式）：maxBytes 类型标注 number，但 JSON
    // 层可写任意形态（同 import dbPath 的 typeof 守卫先例）；负数/NaN 穿透 clamp 会在下游
    // output-tail 的 Buffer.alloc 抛 Node 内部 RangeError（handler_error 泛化、不可操作）。
    if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !(maxBytes >= 0))) {
      return this.ctx.sendError(ws, 'invalid_payload', 'backgroundTask.output requires "maxBytes" to be a non-negative number', msg.id, { sessionId: outSid })
    }
    const clampedMaxBytes = maxBytes === undefined ? undefined : Math.min(maxBytes, OUTPUT_TAIL_MAX_REQUEST_BYTES)
    const tail = port.getOutputTail(outSid, taskId, clampedMaxBytes)
    return this.ctx.reply(ws, msg.id, 'backgroundTask.outputResult', {
      sessionId: outSid,
      taskId,
      text: tail?.text ?? '',
      truncated: tail?.truncated ?? false,
      lost: tail === undefined,
    })
  }

  private async handleBackgroundTaskKill(msg: Extract<ClientMessage, { type: 'backgroundTask.kill' }>, ws: WsType): Promise<void> {
    // 终止任务（D6 五分支矩阵全在 service，handler 只透传回执）。reason 枚举
    // （killed/already-exited/identity-unverifiable/registry-write-failed）驱动 renderer
    // 分支 toast 文案；成功路径的列表翻转不依赖 reply——killing 自写自检广播即时推送。
    const killSid = msg.payload.sessionId
    const port = this.requireBackgroundTasks(ws, msg, killSid)
    if (!port) return
    const result = await port.killTask(killSid, msg.payload.taskId)
    return this.ctx.reply(ws, msg.id, 'backgroundTask.killResult', {
      sessionId: killSid,
      taskId: msg.payload.taskId,
      killed: result.killed,
      reason: result.reason,
    })
  }

  private async handleSessionHistory(msg: Extract<ClientMessage, { type: 'session.history' }>, ws: WsType): Promise<void> {
    // u4b（crash-resilience §3.3 D4）：双预算窗口响应携带 truncated/loadedTurns/totalTurnsEstimate。
    // [u6] 游标翻页（D4 中期）：payload { cursor?, limitTurns?, maxBytes? } 透传 service——
    // cursor=turn 边界锚点 entryId 时返回锚点之前的最近窗口（活跃/离线共用语义）；
    // cursor 未命中 → 空页 + truncated=false（翻页到头，不报错）。
    // [u6] legacy historyTruncated 字段退役（偏差表 D7 清账：与 truncated 同值并存的双轨收口）。
    const { sessionId, cursor, limitTurns, maxBytes } = msg.payload
    const { messages, truncated, loadedTurns, totalTurnsEstimate } = await this.ctx.sessionService.getHistory(sessionId, { cursor, limitTurns, maxBytes })
    return this.ctx.reply(ws, msg.id, 'session.history', {
      sessionId,
      messages,
      truncated,
      loadedTurns,
      totalTurnsEstimate,
    })
  }

  private async handleSessionGetSubagents(msg: Extract<ClientMessage, { type: 'session.getSubagents' }>, ws: WsType): Promise<void> {
    // [RT-4#8] oversize 透传：文件 >32MB 时 subagents 恒空 + oversize=true——renderer
    // 面板据此显示「会话过大，列表不可用」降级提示（与「无 subagent」的空列表分形）。
    const { records: subagents, oversize } = await this.ctx.sessionService.getSubagents(msg.payload.sessionId)
    return this.ctx.reply(ws, msg.id, 'session.subagents', { sessionId: msg.payload.sessionId, subagents, oversize })
  }

  private async handleSessionGetSubagentHistory(msg: Extract<ClientMessage, { type: 'session.getSubagentHistory' }>, ws: WsType): Promise<void> {
    // u4b（D5①）：巨型 subagent JSONL 超预检阈值时返回逆序窗口 + truncated 标记
    const { messages, truncated } = await this.ctx.sessionService.getSubagentHistory(msg.payload.sessionId, msg.payload.subagentId)
    return this.ctx.reply(ws, msg.id, 'session.subagentHistory', { sessionId: msg.payload.sessionId, subagentId: msg.payload.subagentId, messages, truncated })
  }

  // [U7] 子代理引擎配置：get（engines 动态清单 + defaultEngine）/ set（读改写 config.json，新 session 生效）
  private async handleSessionGetSubagentEngineConfig(msg: Extract<ClientMessage, { type: 'session.getSubagentEngineConfig' }>, ws: WsType): Promise<void> {
    const config = await this.ctx.sessionService.getSubagentEngineConfig()
    return this.ctx.reply(ws, msg.id, 'session.subagentEngineConfig', config)
  }

  private async handleSessionSetSubagentDefaultEngine(msg: Extract<ClientMessage, { type: 'session.setSubagentDefaultEngine' }>, ws: WsType): Promise<void> {
    await this.ctx.sessionService.setSubagentDefaultEngine(msg.payload.engineId)
    return this.ctx.reply(ws, msg.id, 'session.subagentDefaultEngineSet', { engineId: msg.payload.engineId })
  }

  private async handleSessionGetWorkflows(msg: Extract<ClientMessage, { type: 'session.getWorkflows' }>, ws: WsType): Promise<void> {
    // [RT-4#8] oversize 透传：语义同 handleSessionGetSubagents。
    const { records: workflows, oversize } = await this.ctx.sessionService.getWorkflows(msg.payload.sessionId)
    return this.ctx.reply(ws, msg.id, 'session.workflows', { sessionId: msg.payload.sessionId, workflows, oversize })
  }

  private async handleSessionGetAgentCallHistory(msg: Extract<ClientMessage, { type: 'session.getAgentCallHistory' }>, ws: WsType): Promise<void> {
    // u4b（D5①）：巨型 agent call JSONL 超预检阈值时返回逆序窗口 + truncated 标记
    const { messages, truncated } = await this.ctx.sessionService.getAgentCallHistory(msg.payload.sessionId, msg.payload.agentCallSessionId)
    return this.ctx.reply(ws, msg.id, 'session.agentCallHistory', { sessionId: msg.payload.sessionId, agentCallSessionId: msg.payload.agentCallSessionId, messages, truncated })
  }

  private async handleSessionGetAgentCallFilePath(msg: Extract<ClientMessage, { type: 'session.getAgentCallFilePath' }>, ws: WsType): Promise<void> {
    const filePath = await this.ctx.sessionService.getAgentCallFilePath(msg.payload.sessionId, msg.payload.agentCallSessionId)
    return this.ctx.reply(ws, msg.id, 'session.agentCallFilePath', { sessionId: msg.payload.sessionId, agentCallSessionId: msg.payload.agentCallSessionId, filePath })
  }

  private async handleSessionWorkflowAction(msg: Extract<ClientMessage, { type: 'session.workflowAction' }>, ws: WsType): Promise<void> {
    await this.ctx.sessionService.workflowAction(msg.payload.sessionId, msg.payload.action, msg.payload.runId)
    return this.ctx.reply(ws, msg.id, 'session.workflowActionDone', { sessionId: msg.payload.sessionId, action: msg.payload.action, runId: msg.payload.runId })
  }

  // ── plan 模式重设计（D1⑥ 冷启动首拉 + D5/E9 PlanModeBar 退出命令）──

  private async handleSessionGetPlanState(msg: Extract<ClientMessage, { type: 'session.getPlanState' }>, ws: WsType): Promise<void> {
    // D1⑥：冷启动/切换首拉（stateSnapshot 是 bus 内存态、pi exit 即清空——冷送达靠本 RPC，
    // 与 getSubagents 首拉同构）。冷路径 = SessionRecords.getPlanState（session-records.ts:510，
    // 磁盘 JSONL → scanPlanStateEntries 派生，与 live 投影同一份派生代码），照 getSubagents
    // handler 消费形态透传；reply 复用 session.planState 广播 payload（shared 协议同
    // getSubagents → session.subagents 复用形态）。
    const { sessionId } = msg.payload
    const svc = this.ctx.sessionService
    if (!svc.getPlanState) {
      // SessionService 未组装转发（仅测试最小 mock 形态，对齐 backgroundTasks 防御分支口径）
      // → 显式报错不留静默。
      return this.ctx.sendError(ws, 'plan_state_unsupported', 'plan state reader not available', msg.id, { sessionId })
    }
    const planState = await svc.getPlanState(sessionId)
    return this.ctx.reply(ws, msg.id, 'session.planState', { sessionId, planState })
  }

  private async handleSessionAbortPlan(msg: Extract<ClientMessage, { type: 'session.abortPlan' }>, ws: WsType): Promise<void> {
    // D5/E9/E10：PlanModeBar 退出按钮（确认 Popover 后）。编排（ensureActive 自动恢复 +
    // prompt('/plan abort') + 失效链回调上抛）在 service 层（session-service.ts abortPlan，
    // MF-1-7 下沉，形态对齐 subagentAction「handler 只透传 payload 字段」）；失效链消费
    // 单一出口在 server.ts（setOnPlanAborted → invalidatePendingUiRequests）。退出结果经
    // 投影链 session.planState 广播推回，此处只回 message.status ack（renderer
    // register<void> 不读 status 值，CL10 宽 string 形态）。
    const { sessionId } = msg.payload
    try {
      await this.ctx.sessionService.abortPlan(sessionId)
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
    } catch (e) {
      return this.reportFailure(ws, msg.id, 'abort_plan_failed', e, { scope: 'session.abortPlan', sessionId })
    }
  }

  private async handleSessionSubagentAction(msg: Extract<ClientMessage, { type: 'session.subagentAction' }>, ws: WsType): Promise<void> {
    // action 分支（cancel/message/start 的命令拼装与换行编码）在 service 层，handler 只透传
    // payload 字段；reply 回显目标标识（cancel/message→subagentId，start→slug）。
    await this.ctx.sessionService.subagentAction(msg.payload.sessionId, msg.payload.action, {
      subagentId: msg.payload.subagentId,
      text: msg.payload.text,
      slug: msg.payload.slug,
      task: msg.payload.task,
    })
    return this.ctx.reply(ws, msg.id, 'session.subagentActionDone', { sessionId: msg.payload.sessionId, action: msg.payload.action, subagentId: msg.payload.subagentId, slug: msg.payload.slug })
  }

  // ── wave:runtime-patch ipc-converge-a3 W2：业务持久化写（从 main IPC 迁 WS）──
  private async handleSessionWriteImage(msg: Extract<ClientMessage, { type: 'session.writeImage' }>, ws: WsType): Promise<void> {
    // 粘贴截图落地 attachments/tmpdir。安全校验在 sessionService.writeImage（mimeType/大小/name sanitize）。
    const { sessionId, base64, mimeType, name } = msg.payload
    try {
      const result = await this.ctx.sessionService.writeImage(sessionId, base64, mimeType, name)
      return this.ctx.reply(ws, msg.id, 'session.writeImage:result', result)
    } catch (err) {
      return this.ctx.sendError(ws, 'write_image_failed', toErrorMessage(err), msg.id, { sessionId })
    }
  }

  private async handleSessionMigrateImage(msg: Extract<ClientMessage, { type: 'session.migrateImage' }>, ws: WsType): Promise<void> {
    // landing tmpdir→attachments 迁移。安全校验在 sessionService.migrateImage（fromPath 白名单）。
    const { fromPath, sessionId, fileName } = msg.payload
    try {
      const result = await this.ctx.sessionService.migrateImage(fromPath, sessionId, fileName)
      return this.ctx.reply(ws, msg.id, 'session.migrateImage:result', result)
    } catch (err) {
      return this.ctx.sendError(ws, 'migrate_image_failed', toErrorMessage(err), msg.id, { sessionId })
    }
  }

  private async handleSessionWriteSegments(msg: Extract<ClientMessage, { type: 'session.writeSegments' }>, ws: WsType): Promise<void> {
    // segments.json sidecar atomic 写。sessionId 空拒绝。
    const { sessionId, entry } = msg.payload
    try {
      await this.ctx.sessionService.writeSegmentsMetadata(sessionId, entry)
      return this.ctx.reply(ws, msg.id, 'session.writeSegments:result', {})
    } catch (err) {
      return this.ctx.sendError(ws, 'write_segments_failed', toErrorMessage(err), msg.id, { sessionId })
    }
  }

  private async handleSessionSubscribe(msg: Extract<ClientMessage, { type: 'session.subscribe' }>, ws: WsType): Promise<void> {
    // wave:runtime-wiring（IF6）：订阅某 session 的 live 事件流。
    // 调 bus.subscribe 注册当前 ws 为订阅者 + 拉 ring 全量 snapshot + stateSnapshot + 最新 seq。
    // fromSeq 可选（重连场景）：若提供且 < ring 最旧 seq（旧 stream 消息已被环形覆盖淘汰）→ gap=true
    // 返全量 snapshot；否则过滤 snapshot 只返 seq > fromSeq 的（增量 backfill）。
    // stateSnapshot（wave:remove-bandaids）是 state topic 的 last-value，不受 fromSeq
    // 增量过滤影响（last-value 语义无历史概念），renderer 始终拿到最新状态 reconcile。
    //
    // gap 判定基准（wave:perf-w06，R-03）：本 handler 是 gap 的唯一判定点——
    // `fromSeq < snapshot[0].seq（ring 最旧 seq）`。D5 topic 分类后 ring 只存 stream 类
    // （state 类分配 seq 但不入 ring、由 stateSnapshot 覆盖重连；transient 类不分配 seq），
    // 该判定语义自洽：state 消息不入 ring 不产生「假最旧 seq」，混合 session 正常重连
    // （fromSeq ≥ ring 最旧）不误报 gap；只有 ring 真实溢出（长断线）才 gap=true 全量重拉。
    const { sessionId, fromSeq } = msg.payload
    const bus = this.ctx.messageBus
    if (!bus) {
      // messageBus 未注入（理论不可达——组合根保证），防御性报错。
      return this.ctx.sendError(ws, 'subscribe_unsupported', 'message bus not available', msg.id, { sessionId })
    }
    // delivery 域装配（D5/D7；msg-pipeline-debloat D4-4 后唯一装配入口）：subscribe
    // **之前**发一帧 session.delivery 全量快照——本次 subscribe 的 stateSnapshot 即含该帧，
    // renderer 队列区在切 session/重连后零竞态恢复（G2/V5「断连重连队列区自动恢复」的装配面，
    // [HISTORICAL] 约束 7 的主动拉取机制，非冗余）。零抛错（sync 内部 warn 降级）：
    // 帧装配失败不得拖垮订阅主链。已有内核运行时才发帧（无运行时 = 无队列事实可投影）。
    this.deliveryTopic.sync(sessionId)
    const result = bus.subscribe(sessionId, ws as unknown as BusClient)
    let gap = false
    let snapshot = result.snapshot
    if (fromSeq !== undefined) {
      const oldestSeq = snapshot[0]?.seq ?? 0
      // ES2/gap 检测：fromSeq 早于 ring 最旧 seq → 旧消息已被淘汰，本次存在缺口。
      // [W06 审查] 判定偏保守（宁可误报不漏报）：state 消息分配 seq 但不入 ring，
      // fromSeq 与 ring 最旧 seq 之间若只隔了 state 消息（stream 未淘汰），也会判
      // gap=true——代价是多一次全量回放，由订阅端幂等 dispatch 兜底，无正确性影响。
      if (fromSeq < oldestSeq) {
        gap = true
      } else {
        // 增量模式：过滤掉 seq <= fromSeq 的（已处理过的），只返 seq > fromSeq。
        // state 消息不在 ring 内，其增量覆盖由 stateSnapshot（last-value）保证。
        snapshot = snapshot.filter(m => (m.seq ?? 0) > fromSeq)
      }
    }
    return this.ctx.reply(ws, msg.id, 'session.subscribe', {
      snapshot,
      stateSnapshot: result.stateSnapshot,
      lastSeq: result.lastSeq,
      gap,
    })
  }

  private async handleSessionUnsubscribe(msg: Extract<ClientMessage, { type: 'session.unsubscribe' }>, ws: WsType): Promise<void> {
    // wave:runtime-wiring（IF7）：取消订阅某 session 的 live 事件流。
    // 调 bus.unsubscribe 移除当前 ws 的订阅（减少不活跃 session 的 live push 开销）。
    // 不调也安全——ws 断开时 ConnectionManager.onClose → bus.unsubscribeAll 兜底。
    // reply 'message.status' { status: 'unsubscribed' }（ack 型，ReplyPayloadMap 已定 void//
    // reply message.status，与 message.abort/session.handoff 同模式——renderer register<void>
    // 不读 payload，取消订阅的副作用由后续 live 事件停发体现）。
    const { sessionId } = msg.payload
    const bus = this.ctx.messageBus
    if (!bus) {
      return this.ctx.sendError(ws, 'subscribe_unsupported', 'message bus not available', msg.id, { sessionId })
    }
    bus.unsubscribe(sessionId, ws as unknown as BusClient)
    return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'unsubscribed' })
  }

  private async handleSessionGetTraceEntries(msg: Extract<ClientMessage, { type: 'session.getTraceEntries' }>, ws: WsType): Promise<void> {
    // session-trace（design D4 / A31 / A32）：A1 混合路由归 sessionService.getTraceEntries
    //（活跃 RPC + header 首行补读；非活跃文件直读 + sidecar；未落盘空态）。
    // 规则 7：reply payload 必带 sessionId（前端按 session 分区，缺 id 消息应被忽略）。
    const traceSid = msg.payload.sessionId
    try {
      const snapshot = await this.ctx.sessionService.getTraceEntries(traceSid)
      return this.ctx.reply(ws, msg.id, 'session.traceEntries', snapshot)
    } catch (e) {
      // 错误指向恢复动作：message 覆写槽拼指引，留痕仍记原始 errMsg（reportFailure 契约）
      return this.reportFailure(ws, msg.id, 'trace_fetch_failed', e, {
        scope: 'session.getTraceEntries',
        sessionId: traceSid,
        message: `Failed to load session trace: ${toErrorMessage(e)} — retry by reopening the Trace view; if it persists, check the session JSONL file is readable`,
      })
    }
  }

  private async handleSessionFetchCurrentSystemPrompt(msg: Extract<ClientMessage, { type: 'session.fetchCurrentSystemPrompt' }>, ws: WsType): Promise<void> {
    // session-trace（design §3.1 失败路径 / D2）：现取当前 system prompt。仅活跃
    // session 可用（非活跃无 pi 进程，错误 code 前端转友好文案）。规则 7：reply 带 sessionId。
    const fetchSid = msg.payload.sessionId
    try {
      const payload = await this.ctx.sessionService.fetchCurrentSystemPrompt(fetchSid)
      return this.ctx.reply(ws, msg.id, 'session.currentSystemPrompt', payload)
    } catch (e) {
      const code = (e as { code?: string }).code
      const errMsg = toErrorMessage(e)
      console.error(`[runtime] session.fetchCurrentSystemPrompt failed (code=${code ?? 'unknown'}):`, errMsg)
      // 错误指向恢复动作：非活跃 → 只活跃 session 可现取；busy → 稍后重试；超时 → 重试
      const hint = code === 'session_not_active'
        ? 'Only active sessions (with a running pi process) support fetching the current system prompt'
        : code === 'session_busy'
          ? 'Session is generating or compacting; retry after the current turn finishes'
          : 'Retry the fetch; if it persists, check the pi process is healthy'
      return this.ctx.sendError(ws, code ?? 'fetch_current_prompt_failed', errMsg, msg.id, { sessionId: fetchSid, hint })
    }
  }

  private async handleSessionGetCommands(msg: Extract<ClientMessage, { type: 'session.getCommands' }>, ws: WsType): Promise<void> {
    // renderer 切 session 后主动拉取命令（修复 broadcast 与订阅时序竞争）。
    // reply session.commands payload，renderer 收到后 events.dispatchSession 本地投递给 CommandPopover。
    const { sessionId } = msg.payload
    const commands = await this.ctx.sessionService.getCommands(sessionId)
    return this.ctx.reply(ws, msg.id, 'session.commands', { sessionId, commands })
  }

  private async handleSessionGetContext(msg: Extract<ClientMessage, { type: 'session.getContext' }>, ws: WsType): Promise<void> {
    // renderer 切 session 后主动拉取上下文用量（修复 broadcast 与订阅时序竞争）。
    // reply context.update payload（与广播/stateSnapshot 同形）。fetchContext 返回 null
    // （pi tokens=null 算不出，如 compaction 后未跑新 turn）时 reply 仅含 sessionId——
    // 字段缺失 = 无值（D1 协议收敛，context-consistency Phase 1；旧 0 fallback 已删：
    // 「未知」不得编码为 0）。
    const { sessionId } = msg.payload
    const payload = await this.ctx.sessionService.fetchContext(sessionId)
    return this.ctx.reply(ws, msg.id, 'context.update', payload ? { sessionId, ...payload } : { sessionId })
  }

  private async handleSessionRename(msg: Extract<ClientMessage, { type: 'session.rename' }>, ws: WsType): Promise<void> {
    await this.ctx.sessionService.renameSession(msg.payload.sessionId, msg.payload.name)
    this.ctx.reply(ws, msg.id, 'session.renamed', { sessionId: msg.payload.sessionId, name: msg.payload.name })
    this.ctx.broadcastSessionList()
  }

  private async handleSessionSetProject(msg: Extract<ClientMessage, { type: 'session.setProject' }>, ws: WsType): Promise<void> {
    // D14 语义修正：手动归类（SessionItem「归入项目」菜单）。
    // runtime 写 .project.json sidecar + 内存态同步，列表经 broadcastSessionList 全量刷新。
    await this.ctx.sessionService.setProject(msg.payload.sessionId, msg.payload.projectId)
    this.ctx.reply(ws, msg.id, 'session.setProject', {
      sessionId: msg.payload.sessionId,
      projectId: msg.payload.projectId,
    })
    this.ctx.broadcastSessionList()
  }

  private async handleSessionImportCandidates(msg: Extract<ClientMessage, { type: 'session.importCandidates' }>, ws: WsType): Promise<void> {
    // 导入会话（import-session D5/u3 + 多源 §3.7）：候选列表（对话框打开/搜索/切目录，
    // renderer debounce 250ms）。reply 与 request 同名（u0b protocol 登记），payload/reply
    // 类型 SSOT = shared import-session.ts，此处只透传不做字段裁剪——payload.source
    //（含 sessionId/dbPath）随 payload 整体透传，路由在 ImportService 的 source 注册表内，
    // handler 对源零分支（缺省不传 = pi，存量调用行为不变）。
    const candidatesSvc = this.ctx.importService
    if (!candidatesSvc) {
      // importService 未注入（理论不可达——组合根必传），防御性报错（对齐 handoffService 惯例）。
      // 注：candidates payload 契约（ImportCandidatesRequest）无 sessionId 字段，error
      // envelope 无 sessionId 可带——C-comm-05 仅约束 payload 含 sessionId 的请求。
      return this.ctx.sendError(ws, 'import_unsupported', 'import service not available', msg.id)
    }
    try {
      const result = await candidatesSvc.listCandidates(msg.payload)
      return this.ctx.reply(ws, msg.id, 'session.importCandidates', result)
    } catch (e) {
      // ImportServiceError.code 透传（错误规格表权威清单）；非预期错误归 import_failed
      //（对齐 worktree handler 的「无 code 兜底」模式）。errorCodeOf 守卫式读取：非 string
      // code 一律 undefined 走兜底。日志嵌 resolved code（reportFailure 形状之外，保留内联）。
      const code = errorCodeOf(e)
      const errMsg = toErrorMessage(e)
      console.error(`[runtime] session.importCandidates failed (code=${code ?? 'unknown'}):`, errMsg)
      return this.ctx.sendError(ws, code ?? 'import_failed', errMsg, msg.id)
    }
  }

  private async handleSessionImport(msg: Extract<ClientMessage, { type: 'session.import' }>, ws: WsType): Promise<void> {
    // 执行导入（D5 + 多源 §3.7）：互斥/校验/原子落地/sidecar/缓存失效全在 service 编排层
    //（按 payload.source 路由到对应 SessionImportSource，缺省 'pi'），handler 只负责 reply
    // 与广播；payload（含 source/sessionId/dbPath）整体透传不做字段裁剪。warning
    //（sidecar_failed / conversion_degraded）是成功 reply 的可选字段（r4-INFO，非 error
    // envelope），随 result 原样透传。
    const importSvc = this.ctx.importService
    if (!importSvc) {
      // sessionId 条件传递（ImportRequest.sessionId 可选，pi 源可不带）：与 server.ts 主
      // 分发错误信封同形态，C-comm-05 要求 error envelope 带 sessionId 供前端路由。
      return this.ctx.sendError(ws, 'import_unsupported', 'import service not available', msg.id, msg.payload.sessionId ? { sessionId: msg.payload.sessionId } : undefined)
    }
    // wire 帧 dbPath 白名单（MF-3-1 加固）：dbPath 在 wire 上是任意 WS 客户端可写字段，
    // 仅放行 zcodeImportDbAllowlist(dataDir) 封闭集合（隔离库/宿主库）；缺省 undefined =
    // source 侧动态推导，放行。校验在 transport 边界执行（不可信面收口），与源无关——
    // pi 源不消费 dbPath，带值即异常请求同拦。测试 fixture 库注入走 source deps 进程内
    // 通道（构造注入 getHostDbPath），不经 wire，不受本校验影响。
    const wireDbPath = msg.payload.dbPath
    if (wireDbPath !== undefined) {
      // typeof 守卫先于集合成员判定：wire 帧类型标注 string，但 JSON 层可写任意形态
      if (typeof wireDbPath !== 'string' || !zcodeImportDbAllowlist(getDataDir()).includes(wireDbPath)) {
        return this.ctx.sendError(
          ws,
          'import_db_path_forbidden',
          'dbPath 不在允许的会话库路径集合内：请缺省不传（runtime 动态推导宿主库）后重试',
          msg.id,
          msg.payload.sessionId ? { sessionId: msg.payload.sessionId } : undefined,
        )
      }
    }
    try {
      const result = await importSvc.importSession(msg.payload)
      this.ctx.reply(ws, msg.id, 'session.import', result)
      // P-broadcast：导入成功后立即广播 session 列表（service 已 invalidateScanDirCache，
      // 不等 1s TTL），侧边栏目标 project 分组即刻出现新会话；reply 先于广播
      //（对齐 session.create / session.setProject 惯例）。
      this.ctx.broadcastSessionList()
    } catch (e) {
      // errorCodeOf 守卫式读取（同 importCandidates 分支）：非 string code 一律 undefined 走兜底
      const code = errorCodeOf(e)
      const errMsg = toErrorMessage(e)
      console.error(`[runtime] session.import failed (code=${code ?? 'unknown'}):`, errMsg)
      return this.ctx.sendError(ws, code ?? 'import_failed', errMsg, msg.id)
    }
  }

  private async handleMessageSend(msg: Extract<ClientMessage, { type: 'message.send' }>, ws: WsType): Promise<void> {
    // 纯主 agent 通道：marker 半成品转发（subagent 字段 → sendSubagentMessage 拼 base64
    // 隐藏注释前缀）已废弃（composer 四符号设计 D2）——定向消息改走
    // session.subagentAction(message/start) 直达 subagent。旧 renderer 残留的 subagent
    // 键被解构忽略，不 resurrect marker 行为。
    // clientUuid（session-occupancy-send-closure D2）：客户端幂等 id 经 dispatcher 透传，
    // 拒绝广播（预检与 pi 转译两路）原样带回——renderer 消歧发送来源（flush 重放不重入队）。
    const { sessionId, content, images, clientUuid } = msg.payload
    const result = await this.ctx.sessionService.sendMessage(sessionId, content, images, clientUuid)
    // D(round7-must-fix-3): hook 拦截时 dispatcher 已广播 message.error（错误气泡），
    // 此处必须走 error envelope（带 msg.id）让 renderer pending.reject，不得 reply success。
    // 否则 renderer 见 msg.id 且非 error → pending.resolve → composer 清空，与错误气泡矛盾。
    // [D-009] rejected（预检拒绝）：send.rejected 已广播，reply success 让 pending 干净 resolve（不双 toast）
    if (result.rejected) {
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'rejected' })
    }
    if (result.blocked) {
      return this.ctx.sendError(ws, MESSAGE_BLOCKED_CODE, 'Message blocked by plugin hook', msg.id, { sessionId })
    }
    return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
  }

  private async handleMessageAbort(msg: Extract<ClientMessage, { type: 'message.abort' }>, ws: WsType): Promise<void> {
    // D(round5-must-fix-1): 必须回复 ack，否则 renderer pending.register(id) 的 Promise 永挂，pendingMap 泄漏无上限。
    // 与 message.send 对称，走 message.status 回复。
    const abortSid = msg.payload.sessionId
    await this.ctx.sessionService.abort(abortSid)
    // P2-2 失效链：turn abort 级联解散挂起交互（审批 select / 执行方式 form / ask-user），
    // 响应永不可达——摘除 runtime pending 缓存 + 广播失效帧，renderer 移除本屏请求
    //（「忽略」按钮的审批条消失即由本链驱动）。
    this.ctx.invalidatePendingUiRequests(abortSid, 'turn-aborted')
    return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: abortSid, status: 'aborted' })
  }

  private async handleMessageBash(msg: Extract<ClientMessage, { type: 'message.bash' }>, ws: WsType): Promise<void> {
    // 与 message.send 对称：调 dispatcher.sendBash → 按 result.rejected/blocked 走 ack 路径。
    // rejected（预检拒绝）：send.rejected 已广播，reply message.status{rejected} 让 pending 干净 resolve。
    // blocked（执行失败）：message.error 已广播（错误气泡），走 error envelope 让 pending.reject。
    // 正常：reply message.status{sent}。实际 bash 结果经 message.bashStart/bashResult 广播通道推回（fire-and-forget）。
    const { sessionId, command, excludeFromContext } = msg.payload
    const result = await this.ctx.sessionService.sendBash(sessionId, command, excludeFromContext)
    if (result.rejected) {
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'rejected' })
    }
    if (result.blocked) {
      return this.ctx.sendError(ws, MESSAGE_BLOCKED_CODE, 'Bash execution failed', msg.id, { sessionId })
    }
    return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
  }

  private async handleMessageAbortBash(msg: Extract<ClientMessage, { type: 'message.abortBash' }>, ws: WsType): Promise<void> {
    // 与 message.abort 对称：调 dispatcher.abortBash → 按 abort_bash 实际发送结果回执
    // （P6 断言④回执真实化）。sent=true（abort_bash 已发出且 pi 确认取消）→ reply
    // message.status{aborted}；sent=false（守卫短路：无 bash 在跑且无孤儿标记，或
    // abort_bash 发送失败）→ 不得谎报 aborted，走 error envelope（renderer useChat.abortBash
    // catch → stopFailed toast 兜底）。兜底终态经独立帧 message.bashAborted 广播推回
    // （msg-pipeline-debloat D4-3 帧类型化，dispatcher.abortBash 兜底广播），不依赖 reply。
    const abortBashSid = msg.payload.sessionId
    const abortResult = await this.ctx.sessionService.abortBash(abortBashSid)
    if (!abortResult.sent) {
      return this.ctx.sendError(ws, 'abort_bash_not_sent', 'No bash execution to abort', msg.id, { sessionId: abortBashSid })
    }
    return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: abortBashSid, status: 'aborted' })
  }

  // ── delivery 域（投递所有权内核 D5，u3a）────────────────────────────────
  //
  // 四 RPC = 内核适配器（u2 registry）的协议面：handler 只做「payload 校验 → 委托 →
  // reply」，lane 判定 / 队列收回 / 判重全在 registry（D1 单一判定源）。
  // 帧单发（msg-pipeline-debloat D4-4）：RPC 入口不再 sync()——内核每次真实变更经
  // onChange 内联同步发一帧（先于 reply 到达 renderer，reply 语义落地时 UI 状态已在位），
  // 无变更零帧；订阅装配与首配快照唯一入口 = session.subscribe（本文件 handleSessionSubscribe，
  // [HISTORICAL] 约束 7 的主动拉取机制）。RPC 入口重发已删：同一变更 sync 幂等再发一帧
  // = 常态双发（浪费 + 「同一状态两帧」的消费者歧义）。

  private async handleDeliverySubmit(msg: Extract<ClientMessage, { type: 'delivery.submit' }>, ws: WsType): Promise<void> {
    const { sessionId, content, images, clientUuid, segments } = msg.payload
    const registry = this.requireDeliveryRegistry(ws, msg, sessionId)
    if (!registry) return
    // 字段校验（协议面防御：clientUuid 是内核判重锚 D5② 与出站标记身份源 D2，缺失即无判重语义）
    if (typeof sessionId !== 'string' || sessionId === '' || typeof content !== 'string' || typeof clientUuid !== 'string' || clientUuid === '') {
      return this.ctx.sendError(ws, 'invalid_payload', 'delivery.submit requires non-empty sessionId, content and clientUuid', msg.id, { sessionId })
    }
    // 受理入口经 sessionService.sendMessage（「入口 touch + BeforeSend hook + 内核提交」的
    // 唯一组合点）——hook 属受理阶段（用户意图 veto/transform，一次语义），挂在提交入口而非
    // 内核投递执行点：deliverText 在 requeue/rebuild/adopt 下可重入，重投不得重复过 hook
    // （防 transform 双重改写）。受理延迟上界因此含 hook 管线超时（与 message.send 路径一致）。
    const outcome = await this.ctx.sessionService.sendMessage(sessionId, content, images, clientUuid)
    if (outcome.blocked) {
      // hook 否决：dispatcher 已广播 message.error（错误气泡），此处走 error envelope（带
      // msg.id）让 renderer 回滚乐观气泡——与 message.send blocked 先例同构，不得 reply success。
      return this.ctx.sendError(ws, MESSAGE_BLOCKED_CODE, 'Message blocked by plugin hook', msg.id, { sessionId })
    }
    const result = outcome.receipt
    if (!result) {
      return this.ctx.sendError(ws, 'delivery_unsupported', 'delivery registry not available', msg.id, { sessionId })
    }
    // segments 快照登记（MF-1-2 / ADR-0043）：受理回执后按 clientUuid 交注册表持有，
    // cancel/drain 回草稿时随全文返回。快照属提交载荷的旁路登记（不经 sendMessage 链——
    // hook 只 transform 文本，不感知 segments），仅接受数组形态（JSON 层可写任意形态，同
    // maxBytes 守卫先例）；条目已终态时注册表侧丢弃（防泄漏）。
    if (Array.isArray(segments) && segments.length > 0) {
      registry.attachSegments(sessionId, result.clientUuid, segments)
    }
    // 受理口径（D9⑤）：submit 同步返回（lane + 条目态），不等底层送达——内核 FIFO 无界，
    // 正常路径无拒绝态（send.rejected 退役归 u5；hook 否决发生在受理之前，不构成受理拒绝）。
    // 受理失败经 registry 侧广播 + 日志。帧经内核 onChange 单发（D4-4），先于本 reply。
    return this.ctx.reply(ws, msg.id, 'delivery.submit', {
      clientUuid: result.clientUuid,
      // 条目态映射（D5③：cancelled 不投影）。submit 返回时刻 cancelled 结构上不可达
      // （同 tick 无用户撤销动作），映射缺席走 queued 兜底而非谎报终态。
      state: frameStateOf(result.state) ?? 'queued',
      lane: frameLaneOf(result.lane),
    })
  }

  private async handleDeliveryCancel(msg: Extract<ClientMessage, { type: 'delivery.cancel' }>, ws: WsType): Promise<void> {
    const { sessionId, clientUuid } = msg.payload
    const registry = this.requireDeliveryRegistry(ws, msg, sessionId)
    if (!registry) return
    if (typeof sessionId !== 'string' || sessionId === '' || typeof clientUuid !== 'string' || clientUuid === '') {
      return this.ctx.sendError(ws, 'invalid_payload', 'delivery.cancel requires non-empty sessionId and clientUuid', msg.id, { sessionId })
    }
    // queued/failed 本地移除；in-flight 走 clear_queue 收回-重投（D3 复用对账路径）。
    // 不可撤（已 delivered / 收回失败）→ cancelled:false + reason（§3.4），条目由对账器兜底。
    const outcome = await registry.cancel(sessionId, clientUuid)
    // content 剥除出站裸标记（草稿恢复是用户面文本，投递元数据不进输入框；u3c restoreDraft 直取）
    const content = outcome.cancelled && outcome.content !== undefined ? stripDeliveryMarkers(outcome.content) : undefined
    // segments 快照（MF-1-2）：提交时经 attachSegments 持有的原始 segments，撤销成功才返回
    // （渲染面按 ADR-0043 Segment[] 整段恢复 chips；无快照的条目不带键 → 纯文本恢复链）
    return this.ctx.reply(ws, msg.id, 'delivery.cancel', {
      clientUuid,
      cancelled: outcome.cancelled,
      ...(content !== undefined ? { content } : {}),
      ...(outcome.cancelled && outcome.segments !== undefined ? { segments: outcome.segments } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    })
  }

  private async handleDeliveryDrain(msg: Extract<ClientMessage, { type: 'delivery.drain' }>, ws: WsType): Promise<void> {
    const { sessionId } = msg.payload
    const registry = this.requireDeliveryRegistry(ws, msg, sessionId)
    if (!registry) return
    if (typeof sessionId !== 'string' || sessionId === '') {
      return this.ctx.sendError(ws, 'invalid_payload', 'delivery.drain requires a non-empty sessionId', msg.id, { sessionId })
    }
    // 全量回收（D10/V11，forceQuit 专用）：kernel drain 同步取回全部未终态条目文本（发送序）；
    // registry 侧尽力 clear_queue 清 pi 槽位（滞留清理，session 即将销毁 → 不再收养投递）。
    const drained = registry.drain(sessionId)
    return this.ctx.reply(ws, msg.id, 'delivery.drain', {
      sessionId,
      entries: drained.map((d) => ({
        clientUuid: d.clientUuid,
        content: stripDeliveryMarkers(d.content),
        ...(d.segments !== undefined ? { segments: d.segments } : {}),
      })),
    })
  }

  private async handleDeliveryResync(msg: Extract<ClientMessage, { type: 'delivery.resync' }>, ws: WsType): Promise<void> {
    const { sessionId, clientUuids } = msg.payload
    const registry = this.requireDeliveryRegistry(ws, msg, sessionId)
    if (!registry) return
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(clientUuids)) {
      return this.ctx.sendError(ws, 'invalid_payload', 'delivery.resync requires a non-empty sessionId and clientUuids array', msg.id, { sessionId })
    }
    // 断连/刷新重连重报（D5）：clientUuid 幂等去重（内核查终态判重记录 + reattach 场景
    // transcript 标记扫描，判重锚全在 runtime）。reply 只带 deduped——存留条目的权威状态
    // 以 session.delivery 帧为单源（last-value，防双源分叉）：重连 session.subscribe 的
    // 首配快照帧 + reattach 变更的 onChange 帧（无变更零帧，D4-4）。
    const deduped = await registry.resync(sessionId, clientUuids)
    return this.ctx.reply(ws, msg.id, 'delivery.resync', { sessionId, deduped })
  }

  // ── 消息撤回（message-revoke 设计 §3.3 D2，U4）────────────────────────────

  private async handleSessionRevokeMessage(msg: Extract<ClientMessage, { type: 'session.revokeMessage' }>, ws: WsType): Promise<void> {
    // handler 只透传 payload 字段（七步编排全在 RevokeOrchestrator）；reply 直接透传
    // SessionRevokeMessageReply（revoked:true + content / revoked:false + error 六码）。
    // 领域回执不走 error envelope——错误码驱动 renderer 置灰 / toast / 刷新建议（D8
    // 呈现列）；此处 catch 只收口编排 throw（组合根装配缺失类运行时异常）。
    const { sessionId, targetId } = msg.payload
    if (typeof sessionId !== 'string' || sessionId === '' || typeof targetId !== 'string' || targetId === '') {
      return this.ctx.sendError(ws, 'invalid_payload', 'session.revokeMessage requires non-empty sessionId and targetId', msg.id, { sessionId })
    }
    const revoke = this.ctx.sessionService.revokeMessage
    if (!revoke) {
      // SessionService 未组装转发（仅测试最小 mock 形态，对齐 getPlanState 防御分支口径）
      // → 显式报错不留静默。
      return this.ctx.sendError(ws, 'revoke_unsupported', 'revoke orchestrator not available', msg.id, { sessionId })
    }
    try {
      const reply = await revoke.call(this.ctx.sessionService, sessionId, targetId)
      return this.ctx.reply(ws, msg.id, 'session.revokeMessage', reply)
    } catch (e) {
      return this.reportFailure(ws, msg.id, 'revoke_failed', e, { scope: 'session.revokeMessage', sessionId })
    }
  }

  async handleSessionCompact(msg: Extract<ClientMessage, { type: 'session.compact' }>, ws: WsType): Promise<void> {
    const compactId = msg.payload.sessionId
    // D11: 耗时/启动/完成遥测由 message-dispatcher.compact 统一负责（含 session.compacting/compacted 广播）。
    // D(round7-must-fix-4): 成功 / 失败 / ensureActive 失败 三条路径都必须携带 msg.id 回复，
    // 否则 renderer pending.register(msg.id) 的 Promise 永挂、pendingMap 无上限泄漏（与 message.abort 同类 bug）。
    // dispatcher.compact 的 session.compacted 广播走流式通道（无 id），不能替代请求级 ack。
    try {
      await this.ctx.sessionService.ensureActive(compactId)
    } catch (e) {
      return this.ctx.sendError(ws, 'compact_failed', 'Failed to restore session for compact: ' + (toErrorMessage(e)), msg.id, { sessionId: compactId })
    }
    try {
      await this.ctx.sessionService.compact(compactId, msg.payload.customInstructions)
    } catch (e) {
      // compact 失败：dispatcher.compact 已广播 session.compacted(error)（流式通知），此处补请求级 error envelope。
      // 分类码（msg-pipeline-debloat D4-2）：busy 预检拒绝的错误携带 code='compact_busy'
      //（dispatcher 抛出，对话流内联呈现已由 stream_warn 编排）；其余（pi 层失败——interpreter
      // 对话流呈现 / ensureActive 恢复失败——session 状态面呈现）归 'compact_failed'。
      // renderer 据分类码路由 toast 抑制（CompactErrorCode SSOT，未知码保守回退 toast）。
      const code = (e as { code?: string }).code === 'compact_busy' ? 'compact_busy' : 'compact_failed'
      return this.ctx.sendError(ws, code, toErrorMessage(e), msg.id, { sessionId: compactId })
    }
    // compact 成功：dispatcher.compact 已广播 session.compacted（流式通知，无 id），此处补请求级 ack。
    return this.ctx.reply(ws, msg.id, 'session.compacted', { sessionId: compactId, status: 'compacted' })
  }
}
