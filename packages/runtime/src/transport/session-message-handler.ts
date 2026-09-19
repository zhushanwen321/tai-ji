/**
 * Session message handler for session.* and message.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ServerMessage, PlanStateView } from '@taiji/shared'
import type { ISessionService } from '../interfaces.js'
import type { HandoffService } from '../services/handoff-service.js'
import type { ImportService } from '../services/session/import-service.js'
// BackgroundTaskService（background-task-sidebar D3，u-runtime-rpc）：仅类型 import——
// 实例由 SessionService 构造器组装（session-service 领地），handler 经 ctx 结构读取消费面。
import type { BackgroundTaskService } from '../services/background-task/background-task-service.js'
import { toErrorMessage, isEnoent, MODEL_NOT_CONFIGURED, SESSION_NOT_FOUND, RESTORE_FAILED } from '../utils/errors.js'
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
   */
  sessionService: ISessionService & {
    readonly backgroundTasks?: BackgroundTaskRpcPort
    markSessionViewed?(sessionId: string): void
    getPlanState?(sessionId: string): Promise<PlanStateView>
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
  nextPushId(): string
  broadcastSessionList(): void
  /** 广播一条 ServerMessage 给所有连接（FR-12：fork 后广播 session.forkNotice）。 */
  broadcast(msg: ServerMessage): void
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
  constructor(private ctx: SessionHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单（session.compact 单独路由，故不在此列）。 */
  readonly handles: ClientMessageType[] = [
    'session.create', 'session.delete', 'session.deleteByCwd', 'config.sessions', 'session.switch', 'session.restore', 'session.history', 'session.rename', 'session.getCommands', 'session.getContext', 'session.fork', 'session.setProject',
    // 导入 pi 会话（import-session D5/U2）：候选列表 + 执行导入（case 分发由 u3-rpc-wiring 落地）。
    'session.importCandidates', 'session.import',
    'session.handoff', 'session.abortHandoff',
    // 强制退出（sidebar 右键）：杀 pi 进程 + stopped 收敛，区别于协作式 message.abort。
    'session.forceQuit',
    // wave:runtime-wiring：session.subscribe/unsubscribe RPC（IF6/IF7）。
    'session.subscribe', 'session.unsubscribe',
    'session.getSubagents', 'session.getSubagentHistory',
    // plan 模式重设计（D1⑥/D5）：getPlanState 冷启动/切换首拉 + abortPlan 横幅退出命令。
    'session.getPlanState', 'session.abortPlan',
    // [U7] 子代理引擎配置（Settings 引擎选择器：动态列表 + defaultEngine 读写）
    'session.getSubagentEngineConfig', 'session.setSubagentDefaultEngine',
    'session.getWorkflows', 'session.getAgentCallHistory', 'session.getAgentCallFilePath',
    'session.workflowAction', 'session.subagentAction',
    // session-trace（design D4）：全量 trace 台账拉取（A1 混合路由归 session-service）。
    'session.getTraceEntries',
    // session-trace（design §3.1 失败路径）：现取当前 system prompt（常驻扩展通道）。
    'session.fetchCurrentSystemPrompt',
    // wave:runtime-patch ipc-converge-a3 W2：业务持久化写 WS（session 数据单一出口归 runtime）
    'session.writeImage', 'session.migrateImage', 'session.writeSegments',
    // composer-gen-stats（D4）：生成指标恢复腿（切 session 视图主动拉，架构约定 #7 时序竞争）。
    'session.getGenStats',
    'message.send', 'message.abort', 'message.steer', 'message.follow_up',
    'message.bash', 'message.abortBash',
    // backgroundTask 域（background-task-sidebar D3，u-runtime-rpc）：后台命令拉取/详情/终止 3 RPC。
    // 变更广播不经此处（SessionService 组装的 onTasksChanged → bus.publish 单向推送）。
    'backgroundTask.list', 'backgroundTask.output', 'backgroundTask.kill',
  ]

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
    'message.send': (msg, ws) => this.handleMessageSend(msg, ws),
    'message.steer': (msg, ws) => this.handleMessageSteer(msg, ws),
    'message.follow_up': (msg, ws) => this.handleMessageFollowUp(msg, ws),
    'message.abort': (msg, ws) => this.handleMessageAbort(msg, ws),
    'message.bash': (msg, ws) => this.handleMessageBash(msg, ws),
    'message.abortBash': (msg, ws) => this.handleMessageAbortBash(msg, ws),
    // backgroundTask 域（background-task-sidebar D3，u-runtime-rpc）：后台命令拉取/详情/终止 3 RPC。
    // 变更广播不经此处（SessionService 组装的 onTasksChanged → bus.publish 单向推送）。
    'backgroundTask.list': (msg, ws) => this.handleBackgroundTaskList(msg, ws),
    'backgroundTask.output': (msg, ws) => this.handleBackgroundTaskOutput(msg, ws),
    'backgroundTask.kill': (msg, ws) => this.handleBackgroundTaskKill(msg, ws),
  }

  async handleSessionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    const handler = this.routes[msg.type]
    if (!handler) return
    // 路由表 key 与 msg.type 字面量同源（上方 routes 逐 key 登记），查表命中即类型匹配；
    // TS 无法静态关联索引访问与 key（correlated types，microsoft/TypeScript#30581），
    // `as never` 是该不变式下的类型层收口，运行时分发行为与原 switch 完全一致。
    await handler(msg as never, ws)
  }

  // ── case handlers（原 switch case 体逐一提取；语句与注释原样保留，行为保持）──

  private async handleSessionCreate(msg: Extract<ClientMessage, { type: 'session.create' }>, ws: WsType): Promise<void> {
    try {
      // B3：透传 modelOverride / thinkingOverride（Landing Chip 覆盖值，设计文档 §5.2）。
      // 优先级：Landing Chip override > preset.modelOverride/thinkingLevel > 全局默认。
      // 之前只透传了 hidden/presetId，覆盖值在 transport 层被丢弃，导致 Landing Chip 选型不生效。
      // projectId：D14 语义修正（2026-08-04），创建时归属当前 activeProject（空 = 默认项目兑底）。
      const session = await this.ctx.sessionService.create(msg.payload.cwd, msg.payload.label, {
        hidden: msg.payload.hidden,
        presetId: msg.payload.presetId,
        projectId: msg.payload.projectId,
        modelOverride: msg.payload.modelOverride,
        thinkingOverride: msg.payload.thinkingOverride,
      })
      this.ctx.reply(ws, msg.id, 'session.created', { session })
      this.ctx.broadcastSessionList()
    } catch (e) {
      // L4: model 未配置时返回差异化 error code，前端据此引导去 Settings 配置。
      const code = (e as Error & { code?: string }).code
      if (code === MODEL_NOT_CONFIGURED) {
        this.ctx.sendError(ws, MODEL_NOT_CONFIGURED, toErrorMessage(e), msg.id)
        return
      }
      throw e
    }
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
    const { srcSessionId, fromPiEntryId, fromMessageTimestamp, fromMessageRole, includeFrom, label, modelOverride, thinkingOverride } = msg.payload
    try {
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
    } catch (e) {
      // L4: model 未配置时返回差异化 error code（与 session.create 同模式）。
      const code = (e as Error & { code?: string }).code
      if (code === MODEL_NOT_CONFIGURED) {
        this.ctx.sendError(ws, MODEL_NOT_CONFIGURED, toErrorMessage(e), msg.id)
        return
      }
      throw e
    }
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
      // L4: model 未配置时返回差异化 error code（与 session.create / session.fork 同模式），
      // 前端据此引导去 Settings 配置，而非泛化的 handoff_failed 气泡。
      const code = (e as Error & { code?: string }).code
      if (code === MODEL_NOT_CONFIGURED) {
        return this.ctx.sendError(ws, MODEL_NOT_CONFIGURED, toErrorMessage(e), msg.id, { sessionId })
      }
      // runHandoff 失败（历史为空 / session 不存在 / 已有进行中 handoff）走 error envelope。
      // 所有错误路径统一走此处的 sendError，不再有 onTurnEnd 内部广播路径。
      const errMsg = toErrorMessage(e)
      console.error('[runtime] session.handoff failed:', errMsg)
      return this.ctx.sendError(ws, 'handoff_failed', errMsg, msg.id, { sessionId })
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
      const errMsg = toErrorMessage(e)
      console.error('[runtime] session.abortHandoff failed:', errMsg)
      return this.ctx.sendError(ws, 'handoff_failed', errMsg, msg.id, { sessionId })
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
      this.ctx.reply(ws, msg.id, 'session.switched', { sessionId: switchId, session: summary })
    } else {
      try {
        await this.ctx.sessionService.ensureActive(switchId)
        const restored = this.ctx.sessionService.getSummary(switchId)
        if (!restored) {
          throw new Error(`Session ${switchId} restored but summary unavailable`)
        }
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
    const port = this.ctx.sessionService.backgroundTasks
    const listSid = msg.payload.sessionId
    if (!port) {
      return this.ctx.sendError(ws, 'background_task_unsupported', 'background task service not available', msg.id, { sessionId: listSid })
    }
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
    const port = this.ctx.sessionService.backgroundTasks
    const { sessionId: outSid, taskId, maxBytes } = msg.payload
    if (!port) {
      return this.ctx.sendError(ws, 'background_task_unsupported', 'background task service not available', msg.id, { sessionId: outSid })
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
    const port = this.ctx.sessionService.backgroundTasks
    const killSid = msg.payload.sessionId
    if (!port) {
      return this.ctx.sendError(ws, 'background_task_unsupported', 'background task service not available', msg.id, { sessionId: killSid })
    }
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
    const subagents = await this.ctx.sessionService.getSubagents(msg.payload.sessionId)
    return this.ctx.reply(ws, msg.id, 'session.subagents', { sessionId: msg.payload.sessionId, subagents })
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
    const workflows = await this.ctx.sessionService.getWorkflows(msg.payload.sessionId)
    return this.ctx.reply(ws, msg.id, 'session.workflows', { sessionId: msg.payload.sessionId, workflows })
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

  // ── plan 模式重设计（D1⑥ 冷启动首拉 + D5/E9 横幅退出命令）──

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
    // D5/E9/E10：横幅「退出 ×」。① ensureActive 自动恢复 pi（join 语义，session-service.ts
    // ensureActive——崩溃恢复后懒重生未发生的窗口一步到位，不要求用户先发消息；恢复失败
    // → 下方 error envelope，前端呈现 E9 恢复指引）。② client.prompt('/plan abort') 直发：
    // `/` 前缀 prompt 被 pi 先行执行为 extension command、不产用户消息、streaming 中可用
    // （主审 R2 复核实证）；pi 实装锚点（0.84.4）：dist/core/agent-session.js:826-833——
    // prompt 对 `/` 前缀先行尝试 extension command（源码注释明言 execute immediately,
    // even during streaming），handled 即 return 不产用户消息；命令解析
    // _tryExecuteExtensionCommand :954。本断言双承重：此写入路径 +
    // .githooks/check_prompt_outposts.py 豁免条目的依据。刻意绕过 dispatcher busy 预检——照 workflowAction（session-records.ts
    // workflowAction）先例，审批挂起期 busy defer 会吞掉退出命令（E10 卡死链的入口），直发
    // 让 extension 侧 abort handler（先 controller.abort 再 resetPlanState）落地。
    // 退出结果经投影链 session.planState 广播推回（isActive=false），此处只回 message.status
    // ack（renderer register<void> 不读 status 值，CL10 宽 string 形态）。
    const { sessionId } = msg.payload
    try {
      const client = await this.ctx.sessionService.ensureActive(sessionId)
      await client.prompt('/plan abort')
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
    } catch (e) {
      const errMsg = toErrorMessage(e)
      console.error('[runtime] session.abortPlan failed:', errMsg)
      return this.ctx.sendError(ws, 'abort_plan_failed', errMsg, msg.id, { sessionId })
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
      const errMsg = toErrorMessage(e)
      console.error('[runtime] session.getTraceEntries failed:', errMsg)
      return this.ctx.sendError(ws, 'trace_fetch_failed', `Failed to load session trace: ${errMsg} — retry by reopening the Trace view; if it persists, check the session JSONL file is readable`, msg.id, { sessionId: traceSid })
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
      return this.ctx.sendError(ws, 'import_unsupported', 'import service not available', msg.id)
    }
    try {
      const result = await candidatesSvc.listCandidates(msg.payload)
      return this.ctx.reply(ws, msg.id, 'session.importCandidates', result)
    } catch (e) {
      // ImportServiceError.code 透传（错误规格表权威清单）；非预期错误归 import_failed
      //（对齐 worktree handler 的「无 code 兜底」模式）。守卫式读取：先判型再收窄，
      // 非 string code 一律 undefined 走兜底。
      const rawCode = (e as { code?: unknown }).code
      const code = typeof rawCode === 'string' ? rawCode : undefined
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
      return this.ctx.sendError(ws, 'import_unsupported', 'import service not available', msg.id)
    }
    try {
      const result = await importSvc.importSession(msg.payload)
      this.ctx.reply(ws, msg.id, 'session.import', result)
      // P-broadcast：导入成功后立即广播 session 列表（service 已 invalidateScanDirCache，
      // 不等 1s TTL），侧边栏目标 project 分组即刻出现新会话；reply 先于广播
      //（对齐 session.create / session.setProject 惯例）。
      this.ctx.broadcastSessionList()
    } catch (e) {
      // 守卫式读取（同 importCandidates 分支）：非 string code 一律 undefined 走兜底
      const rawCode = (e as { code?: unknown }).code
      const code = typeof rawCode === 'string' ? rawCode : undefined
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
      return this.ctx.sendError(ws, 'message_blocked', 'Message blocked by plugin hook', msg.id, { sessionId })
    }
    return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
  }

  private async handleMessageSteer(msg: Extract<ClientMessage, { type: 'message.steer' }>, ws: WsType): Promise<void> {
    const steerSid = msg.payload.sessionId
    try {
      await this.ctx.sessionService.steerMessage(steerSid, msg.payload.content)
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: steerSid, status: 'steered' })
    } catch (e) {
      // D10/P0-B: 请求级失败走统一 error envelope（区别于 message-dispatcher 的流式 message.error 广播）。
      const errMsg = toErrorMessage(e)
      console.error('[runtime] message.steer failed:', errMsg)
      return this.ctx.sendError(ws, 'steer_failed', errMsg, msg.id, { sessionId: steerSid })
    }
  }

  private async handleMessageFollowUp(msg: Extract<ClientMessage, { type: 'message.follow_up' }>, ws: WsType): Promise<void> {
    const followSid = msg.payload.sessionId
    try {
      await this.ctx.sessionService.followUpMessage(followSid, msg.payload.content)
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: followSid, status: 'queued' })
    } catch (e) {
      // D10/P0-B: 请求级失败走统一 error envelope（区别于 message-dispatcher 的流式 message.error 广播）。
      const errMsg = toErrorMessage(e)
      console.error('[runtime] message.follow_up failed:', errMsg)
      return this.ctx.sendError(ws, 'follow_up_failed', errMsg, msg.id, { sessionId: followSid })
    }
  }

  private async handleMessageAbort(msg: Extract<ClientMessage, { type: 'message.abort' }>, ws: WsType): Promise<void> {
    // D(round5-must-fix-1): 必须回复 ack，否则 renderer pending.register(id) 的 Promise 永挂，pendingMap 泄漏无上限。
    // 与 message.send/steer/follow_up 对称，走 message.status 回复。
    const abortSid = msg.payload.sessionId
    await this.ctx.sessionService.abort(abortSid)
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
      return this.ctx.sendError(ws, 'message_blocked', 'Bash execution failed', msg.id, { sessionId })
    }
    return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'sent' })
  }

  private async handleMessageAbortBash(msg: Extract<ClientMessage, { type: 'message.abortBash' }>, ws: WsType): Promise<void> {
    // 与 message.abort 对称：调 dispatcher.abortBash → 按 abort_bash 实际发送结果回执
    // （P6 断言④回执真实化）。sent=true（abort_bash 已发出且 pi 确认取消）→ reply
    // message.status{aborted}；sent=false（守卫短路：无 bash 在跑且无孤儿标记，或
    // abort_bash 发送失败）→ 不得谎报 aborted，走 error envelope（renderer useChat.abortBash
    // catch → stopFailed toast 兜底）。终态经 message.bashResult{cancelled:true} 广播推回
    // （dispatcher.abortBash 兑底），不依赖 reply。
    const abortBashSid = msg.payload.sessionId
    const abortResult = await this.ctx.sessionService.abortBash(abortBashSid)
    if (!abortResult.sent) {
      return this.ctx.sendError(ws, 'abort_bash_not_sent', 'No bash execution to abort', msg.id, { sessionId: abortBashSid })
    }
    return this.ctx.reply(ws, msg.id, 'message.status', { sessionId: abortBashSid, status: 'aborted' })
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
      return this.ctx.sendError(ws, 'compact_failed', toErrorMessage(e), msg.id, { sessionId: compactId })
    }
    // compact 成功：dispatcher.compact 已广播 session.compacted（流式通知，无 id），此处补请求级 ack。
    return this.ctx.reply(ws, msg.id, 'session.compacted', { sessionId: compactId, status: 'compacted' })
  }
}
