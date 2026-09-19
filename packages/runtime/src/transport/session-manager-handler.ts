/**
 * SessionManagerHandler — 处理 agent-managed session 请求。
 *
 * pi extension 通过 select 通道 + SESSION_MANAGER_MARKER 发送 session 管理请求，
 * runtime event-adapter 检测 marker 后路由到本 handler 的 handle() 方法。
 *
 * 6 个 action：create / send / history / status / list / abort。
 * 响应通过 sendExtensionUiResponse 回写 pi（select value 通道）。
 *
 * [架构备注，PR #189 review] 本 handler 承载业务编排（归属校验 / list 过滤 / history
 * tailTurns 截断），与 transport「纯路由」定义有偏差；迁移 services/session/（interface
 * 经 ports 暴露）是既定方向、待后续 wave。当前留在 transport 与 Quota/Preset handler
 * 先例一致。
 */
import type { ISessionService } from '../interfaces.js'
import type { SessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
import { toErrorMessage } from '../utils/errors.js'
import { SESSION_MANAGER_ACTIONS } from '@zhushanwen/extension-protocol'
import {
  isSessionManagerCreateParams,
  isSessionManagerSendParams,
  isSessionManagerHistoryParams,
  isSessionManagerStatusParams,
  isSessionManagerListParams,
  isSessionManagerAbortParams,
} from '@zhushanwen/extension-protocol'
import type {
  SessionManagerAction,
  SessionManagerParams,
  SessionManagerCreateParams,
  SessionManagerSendParams,
  SessionManagerHistoryParams,
  SessionManagerStatusParams,
  SessionManagerListParams,
  SessionManagerAbortParams,
  SessionManagerCreateResult,
  SessionManagerSendResult,
  SessionManagerHistoryResult,
  SessionManagerStatusResult,
  SessionManagerListResult,
  SessionManagerAbortResult,
  SessionManagerErrorResult,
} from '@zhushanwen/extension-protocol'

/** send 失败时附带的恢复指引（target 不可达：先查状态再重试投递） */
const SEND_UNREACHABLE_HINT =
  'target session unreachable; retry send_to_session after checking get_session_status'

/** dispatch 的统一返回形状：6 个 action 结果 + 错误闭环（send 同步失败 / create 后置失败） */
type SessionManagerDispatchResult =
  | SessionManagerCreateResult
  | SessionManagerSendResult
  | SessionManagerHistoryResult
  | SessionManagerStatusResult
  | SessionManagerListResult
  | SessionManagerAbortResult
  | SessionManagerErrorResult

/**
 * 单个 action 的分发路由：params 类型守卫与执行体成对登记。
 * 守卫是类型谓词——通过后 params 在类型层即收窄为 P，免除旧 switch
 * 每分支一次的 as unknown as 断言（守卫与执行体同表登记，天然不会漂移）。
 */
interface SessionManagerRoute<P> {
  isParams: (v: unknown) => v is P
  run: (parentSessionId: string, params: P) => Promise<SessionManagerDispatchResult>
}

/** SessionManagerHandler 构造选项 */
export interface SessionManagerHandlerOptions {
  sessionService: ISessionService
  /**
   * sd-u5：delivery 装配（send 排队投递 + create 初始 prompt 直投）。
   * 组合根注入 sessionId 单例注册表（design.md §3.1 调用方 B / §3.4 单例约束）。
   */
  delivery: SessionDeliveryRegistry
  /** 向 pi 发送 extension_ui_response（sessionId = 发起方 session，requestId 只在其 pending 表有效） */
  sendExtensionUiResponse: (sessionId: string, requestId: string, response: unknown, method?: string) => void
  /** 广播 session 列表变更（create 成功后触发） */
  broadcastSessionList: () => void
}

/**
 * SessionManagerHandler — 处理 agent-managed session 的 6 个 action。
 *
 * handle() 是唯一入口，由 EventInterpreter.onSessionManagerRequest 调用。
 * dispatch() 纯分发（各分支只 return 结果），回写统一由 respond() 收口；
 * 错误走同一通道 respond({error})。
 */
export class SessionManagerHandler {
  constructor(private readonly opts: SessionManagerHandlerOptions) {}

  /**
   * 处理 session manager 请求。
   *
   * @param requestId       pi extension_ui_request id（回写 response 用）
   * @param parentSessionId 发起方 session id（response 直发其 pi 进程；create 时注入为父 id）
   * @param action          6 个 action 之一，或 marker 解析失败哨兵 '__malformed__'
   * @param params          action 对应的参数（已由 event-adapter 解析）
   */
  async handle(
    requestId: string,
    parentSessionId: string,
    action: SessionManagerAction | '__malformed__',
    params: Record<string, unknown>,
  ): Promise<void> {
    // 无法识别的 action（'__malformed__' = marker 解析失败；集合外值 = 协议外 action）
    // 统一回 cancelled（select value null），不走正常分发。
    if (action === '__malformed__' || !(SESSION_MANAGER_ACTIONS as readonly string[]).includes(action)) {
      this.opts.sendExtensionUiResponse(parentSessionId, requestId, null, 'select')
      return
    }

    try {
      const result = await this.dispatch(action, parentSessionId, params)
      this.respond(parentSessionId, requestId, result)
    } catch (e) {
      // 错误闭环：respond({error}) 走同一 select value 通道。
      // create 已成功但后续步骤失败时，handleCreate 在错误对象上携带 sessionId
      // → 附 sessionId + hint 恢复路径（设计文档 §5.2 原子性 catch 面）。
      const errorResult: SessionManagerErrorResult = { error: toErrorMessage(e) }
      const createdId = (e as { sessionId?: string }).sessionId
      if (createdId) {
        errorResult.sessionId = createdId
        errorResult.hint = 'use send_to_session to retry'
      }
      this.respond(parentSessionId, requestId, errorResult)
    }
  }

  /** respond 通过 select value 通道回写 pi（发起方 session） */
  private respond(parentSessionId: string, requestId: string, data: unknown): void {
    this.opts.sendExtensionUiResponse(parentSessionId, requestId, JSON.stringify(data), 'select')
  }

  /**
   * action 路由表（查表分发）：params 守卫与 handler 成对登记，新增 action
   * 只加一行，不再以 6 路 &&/|| 守卫链 + switch 推高 dispatch 圈复杂度
   * （metrics-gate maxCyclomatic=15 守卫）。
   */
  private readonly routes: {
    readonly [K in SessionManagerAction]: SessionManagerRoute<SessionManagerParams[K]>
  } = {
      create: {
        isParams: isSessionManagerCreateParams,
        run: (parentSessionId, params) => this.handleCreate(parentSessionId, params),
      },
      send: {
        isParams: isSessionManagerSendParams,
        run: (parentSessionId, params) => this.handleSend(parentSessionId, params),
      },
      history: {
        isParams: isSessionManagerHistoryParams,
        run: (parentSessionId, params) => this.handleHistory(parentSessionId, params),
      },
      status: {
        isParams: isSessionManagerStatusParams,
        run: (parentSessionId, params) => this.handleStatus(parentSessionId, params),
      },
      list: {
        isParams: isSessionManagerListParams,
        run: (parentSessionId, params) => this.handleList(parentSessionId, params),
      },
      abort: {
        isParams: isSessionManagerAbortParams,
        run: (parentSessionId, params) => this.handleAbort(parentSessionId, params),
      },
    }

  /**
   * action 分发：查表执行（守卫 → handler），回写统一由 handle/respond 收口。
   *
   * 信任边界守卫（与 action 侧 '__malformed__' narrowing 同等防线）：params 来自
   * extension_ui_request（LLM 可控 JSON），逐 action 校验，非法即 throw 走 handle
   * 的 respond({error}) 错误闭环——禁止把畸形字段以 undefined 静默流入 sessionService。
   * 泛型 K 使映射表索引化简为 SessionManagerRoute<SessionManagerParams[K]>，
   * 守卫通过后 params 类型自动收窄，无需断言（关联联合的标准写法）。
   */
  private async dispatch<K extends SessionManagerAction>(
    action: K,
    parentSessionId: string,
    params: Record<string, unknown>,
  ): Promise<SessionManagerDispatchResult> {
    const route: SessionManagerRoute<SessionManagerParams[K]> = this.routes[action]
    if (!route.isParams(params)) {
      throw new Error(`invalid params for session-manager action '${action}'`)
    }
    return route.run(parentSessionId, params)
  }

  /**
   * 目标归属校验（send/history/status/abort 与 list 的过滤条件对称）：
   * 目标必须是 spawnSource='agent' 且 parentAgentSessionId = 发起方（路由上下文）
   * 的 managed session。否则被注入的 agent 可 steer/读历史/abort 用户或其他
   * agent 的任意活跃 session，绕过 permission 审批链（design.md §392 仅定义了
   * list 过滤，此处将同一条件施加到全部按 sessionId 寻址的 action）。
   */
  private isOwnedBy(parentSessionId: string, sessionId: string): boolean {
    const summary = this.opts.sessionService.getSummary(sessionId)
    return summary?.spawnSource === 'agent' && summary?.parentAgentSessionId === parentSessionId
  }

  /** create 分支：四步串行时序 */
  private async handleCreate(parentSessionId: string, params: SessionManagerCreateParams): Promise<SessionManagerCreateResult> {
    const { cwd, label, prompt } = params

    // 0. project 归属继承（u8，设计文档 D8）：子会话随父会话归入同一 project。
    // 侧栏命名 project 视图按 projectId 过滤，不继承会让派发出的子会话在用户当前
    // 视图里直接消失。父会话此刻必然活跃（发起方 = 路由上下文，内存态可得；
    // getSummary 已透传 projectId）。归属决策不交给 LLM：不新增工具参数，
    // 服务端单侧推导（params.projectId 即使被携带也不读取）。
    //
    // E6（设计文档 §7.5）日志分级（dev→fix r1）：两种「projectId 不可得」成因不同，
    // 噪声级别也不同——父 summary 真读不到才是异常（warn，含问题语气）；
    // summary 在但 projectId 为空 = 「父项目本就是默认项目」的正常降级（debug，
    // 仅陈述 fallback 事实）。两者都属正常降级路径：不 throw、不阻断创建
    //（恢复路径：侧栏右键「归入项目」）。
    const parentSummary = this.opts.sessionService.getSummary(parentSessionId)
    const parentProjectId = parentSummary?.projectId
    if (!parentSummary) {
      console.warn(
        `[session-manager] parent session ${parentSessionId} summary unavailable; child session falls back to default project`,
      )
    } else if (!parentProjectId) {
      console.debug(
        `[session-manager] parent session ${parentSessionId} has no projectId; child session falls back to default project`,
      )
    }

    // 1. SessionService.create —— spawnSource/parentAgentSessionId 服务端注入：
    // 父 session 由路由上下文（interpreter sessionId）决定，不信任 extension 请求参数（防伪造父 id）
    // A'（2026-08-24）：persistLabel=true —— agent 传 label 时是显式命名（语义性），
    // 持久化且防 auto-rename 覆盖；未传 label 则 no-op（见 session-lifecycle persistExplicitLabel）
    // projectId：undefined 时空值守卫（persistCreateSidecars）跳过 sidecar 落盘 = 落默认项目。
    const session = await this.opts.sessionService.create(cwd, label, {
      spawnSource: 'agent',
      parentAgentSessionId: parentSessionId,
      persistLabel: true,
      projectId: parentProjectId,
    })

    // 2. broadcastSessionList（先于 sendMessage，opts 注入回调）
    // broadcast 失败不阻断 create 结果（解耦：已广播的侧栏可见性不受 sendMessage 影响）
    try {
      this.opts.broadcastSessionList()
    } catch (e) {
      // broadcast 失败只 warn，不阻断 create 的 respond
      console.warn('[session-manager] broadcastSessionList failed:', toErrorMessage(e))
    }

    // 3. sendMessage：初始 prompt 同一 handler 调用内注入（设计文档 §5.2——
    // create+send 原子完成，避免"已创建无内容"中间态；broadcast 先于此步，
    // prompt 注入失败时错误对象携带 sessionId，走外层 catch 的恢复路径）
    // sd-u5：直投不走内核队列（D7 末行——新 session 必 idle 无竞态，port 层同款
    // ensureActive+prompt 直发），失败照旧 throw 维持 create+send 原子性契约。
    if (prompt !== undefined && prompt !== '') {
      try {
        await this.opts.delivery.sendDirect(session.id, prompt)
      } catch (e) {
        throw Object.assign(new Error(toErrorMessage(e)), { sessionId: session.id })
      }
    }

    // 4. respond
    return {
      sessionId: session.id,
      status: 'created',
      modelId: session.modelId || undefined,
    }
  }

  /**
   * send 分支（sd-u5：busy 直接拒绝 → 排队投递）。
   *
   * 走 delivery 内核的 sendChecked：目标 idle 立即投递、busy 入队在下一 turn
   * 边界注入（agent 立即收到 {queued: true}，不再出现 {blocked, rejected}）。
   * 失败（目标 pi 进程不可达等同步失败）不 throw、不走前端 banner（D7 错误广播
   * 替换项）——同步返回 error + hint 给 select 通道，agent 立即可见。
   */
  private async handleSend(
    parentSessionId: string,
    params: SessionManagerSendParams,
  ): Promise<SessionManagerSendResult | SessionManagerErrorResult> {
    const { sessionId, prompt } = params
    if (!this.isOwnedBy(parentSessionId, sessionId)) {
      return { error: 'target session is not managed by this agent' }
    }
    try {
      await this.opts.delivery
        .getOrCreateDelivery(sessionId)
        .sendChecked({ payload: { kind: 'text', content: prompt } })
      return { queued: true }
    } catch (e) {
      return { error: toErrorMessage(e), hint: SEND_UNREACHABLE_HINT }
    }
  }

  /** history 分支：含 tailTurns 截断 */
  private async handleHistory(parentSessionId: string, params: SessionManagerHistoryParams): Promise<SessionManagerHistoryResult> {
    const { sessionId, tailTurns } = params
    if (!this.isOwnedBy(parentSessionId, sessionId)) {
      throw new Error('target session is not managed by this agent')
    }
    const { messages, truncated } = await this.opts.sessionService.getHistory(sessionId)

    // tailTurns 截断：从末尾保留指定 turn 数
    if (tailTurns && tailTurns > 0 && messages.length > 0) {
      // 找到倒数第 tailTurns 个 user message 的位置
      let userCount = 0
      let cutIndex = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          userCount++
          if (userCount >= tailTurns) {
            cutIndex = i
            break
          }
        }
      }
      // user turn 数不足 tailTurns 时回退返回全部历史（而非 messages.length 处截断成空列表）
      if (userCount < tailTurns) cutIndex = 0
      return {
        messages: messages.slice(cutIndex),
        truncated: cutIndex > 0 || truncated,
      }
    }

    return { messages, truncated }
  }

  /**
   * status 分支：从 getSummary 组装。目标不存在**或存在但不归属发起方**一律
   * `{status:'not_found'}`——「不可见 = 不存在」（PR #189 review 探测面折叠：
   * 对不归属目标 throw error 会向非属主泄露该 sessionId 的存在性，与 list 的
   * 过滤语义（不可见 = 不出现在结果里）不对称，非属主可借此探测任意 sessionId）。
   */
  private async handleStatus(parentSessionId: string, params: SessionManagerStatusParams): Promise<SessionManagerStatusResult> {
    const { sessionId } = params
    const summary = this.opts.sessionService.getSummary(sessionId)

    if (!summary || !this.isOwnedBy(parentSessionId, sessionId)) {
      return { status: 'not_found' }
    }

    return {
      status: summary.status,
      modelId: summary.modelId || undefined,
    }
  }

  /**
   * list 分支：过滤 spawnSource + parentAgentSessionId（agent-managed-session/design.md §392）。
   *
   * 过滤条件固化（LLM 可控 params 不得放宽过滤）：spawnSource 恒 'agent'；
   * parentAgentSessionId 恒为路由上下文（发起方 session）——协议 params 无过滤字段，
   * 即使携带也不被读取——否则 agent 可枚举其他 agent 的子 session（label/cwd 泄露）。
   */
  private async handleList(parentSessionId: string, _params: SessionManagerListParams): Promise<SessionManagerListResult> {
    const wantSpawn = 'agent'
    const wantParent = parentSessionId
    const groups = this.opts.sessionService.listPersistedSessions()

    // 展平 groups 为 sessions 数组
    const allSessions = groups.flatMap((g) => g.sessions)

    // 过滤
    const filtered = allSessions.filter((s) => {
      if (s.spawnSource !== wantSpawn) return false
      if (s.parentAgentSessionId !== wantParent) return false
      return true
    })

    return {
      sessions: filtered.map((s) => ({
        id: s.id,
        label: s.label,
        cwd: s.cwd,
        status: s.status,
        spawnSource: s.spawnSource,
        parentAgentSessionId: s.parentAgentSessionId,
      })),
    }
  }

  /** abort 分支 */
  private async handleAbort(parentSessionId: string, params: SessionManagerAbortParams): Promise<SessionManagerAbortResult> {
    const { sessionId } = params
    if (!this.isOwnedBy(parentSessionId, sessionId)) {
      throw new Error('target session is not managed by this agent')
    }
    await this.opts.sessionService.abort(sessionId)
    return { success: true }
  }
}
