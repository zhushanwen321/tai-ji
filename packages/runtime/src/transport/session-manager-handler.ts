/**
 * SessionManagerHandler — 处理 agent-managed session 请求。
 *
 * pi extension 通过 select 通道 + SESSION_MANAGER_MARKER 发送 session 管理请求，
 * runtime event-adapter 检测 marker 后路由到本 handler 的 handle() 方法。
 *
 * 7 个 action：create / send / history / status / list / abort / watch（notify-once D2/D6）。
 * 响应通过 sendExtensionUiResponse 回写 pi（select value 通道）。
 *
 * notify-once 桥接（设计 U3）：本 handler 是债权状态机（ClaimLedger）的受理侧——
 * send/create 受理点 arm、watch 单键寻址路由（fail-closed / wait / catch-up 三分支）、
 * handleAbort 入口同步抹除、respond 前二次归属校验；state→协议 reason 的词形映射
 * （toWatchRespondPayload）与 respond 回执循环（deliverRespondTargets / runClaimSweep）
 * 以导出函数形态供组合根 index.ts 共用（settle/death/TTL 清扫腿），保证映射单点。
 *
 * [架构备注，PR #189 review] 本 handler 承载业务编排（归属校验 / list 过滤 / history
 * tailTurns 截断），与 transport「纯路由」定义有偏差；迁移 services/session/（interface
 * 经 ports 暴露）是既定方向、待后续 wave。当前留在 transport 与 Quota/Preset handler
 * 先例一致。
 */
import { randomUUID } from 'node:crypto'
import type { ISessionService } from '../interfaces.js'
import type { SessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
// 通知债权状态机（u-claims）：本 handler 是其唯一受理侧消费方；组合根 index.ts 经
// 本模块导出的映射/回执助手（toWatchRespondPayload 等）消费同一批素材。
import type { ClaimLedger, RespondPayload, RespondTarget, SweepResult } from '../services/session/notify-claims.js'
import { toErrorMessage } from '../utils/errors.js'
import { SESSION_MANAGER_ACTIONS } from '@zhushanwen/extension-protocol'
import {
  isSessionManagerCreateParams,
  isSessionManagerSendParams,
  isSessionManagerHistoryParams,
  isSessionManagerStatusParams,
  isSessionManagerListParams,
  isSessionManagerAbortParams,
  isSessionManagerWatchParams,
  isSessionManagerNotifyId,
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
  SessionManagerWatchParams,
  SessionManagerWatchRespondPayload,
} from '@zhushanwen/extension-protocol'

/** send 失败时附带的恢复指引（target 不可达：先查状态再重试投递） */
const SEND_UNREACHABLE_HINT =
  'target session unreachable; retry send_to_session after checking get_session_status'

/**
 * 「send/create 未带 notifyId → 不 arm」once 日志（D6 兼容矩阵象限2 / 附录 C-3）：
 * 每进程只记一条，作混装象限（旧 extension + 新 runtime，通知功能整体退化）的观测信号。
 * 档位 = console.info（logger tee）：warn/debug 两通道在 handler 测试中被既有断言 spy 占用，
 * 且此处非异常只是降级陈述。模块级布尔（handler 为组合根单例）。
 */
let notifyIdAbsenceLogged = false
function logNotifyIdAbsence(action: 'send' | 'create'): void {
  if (notifyIdAbsenceLogged) return
  notifyIdAbsenceLogged = true
  console.info(
    `[session-manager] ${action} arrived without a valid notifyId — notify-once claim not armed, no completion notification will be delivered (legacy extension quadrant, log once)`,
  )
}

/** watch respond 写回通道（boolean 传导，D7①）：true = 已写入发起方 pi 的 pending 表。 */
export type WatchRespondFn = (
  parentSid: string,
  watchId: string,
  payload: SessionManagerWatchRespondPayload,
) => boolean

/** respond payload 的 additive 采集项（death/settle/catch-up 路径按需携带，查不到不填）。 */
export interface WatchRespondExtra {
  /** 通知正文 `Full transcript:` 指针行数据源（D9；经 session 服务读取，缺席整行省略） */
  sessionFilePath?: string
  /** death 应答携带：exit 诊断通路复刻（forceQuit / 信号杀 → null） */
  exitCode?: number | null
  /** death 应答携带：stderr 尾部摘要（400 字截尾，见 collectStderrTail） */
  stderrTail?: string
}

/** stderr 摘要上限（迁移自 completion-backflow：诊断价值 > 完整性，防爆量撑爆文案）。 */
const STDERR_TAIL_LIMIT = 400

/** 采集 stderr 尾部摘要（death 汇聚点用）：空串 → undefined（缺席不填），超长取末 400 字。 */
export function collectStderrTail(stderr: string): string | undefined {
  if (stderr === '') return undefined
  return stderr.length > STDERR_TAIL_LIMIT ? stderr.slice(-STDERR_TAIL_LIMIT) : stderr
}

/**
 * state→协议 reason 词形映射（u-bridge 承载的协议 SSOT 消费点，F3 裁定：ClaimLedger
 * 内部态不 import 协议，映射归本模块）：
 * settled→outcome（done/null→completed、error→failed、stopped→stopped）/
 * aborted→cancelled / death→exited·deleted（cause 分派）/ orphaned→orphaned。
 * 非 cancelled 的 claim 命中路径恒回带 sessionId（D-4）；fail-closed（无 claim）由调用方
 * 构造 {reason:'cancelled'}，不携 sessionId。
 */
export function toWatchRespondPayload(
  payload: RespondPayload,
  sessionId: string,
  extra: WatchRespondExtra = {},
): SessionManagerWatchRespondPayload {
  const file = extra.sessionFilePath !== undefined ? { sessionFilePath: extra.sessionFilePath } : {}
  switch (payload.type) {
    case 'settled': {
      const reason = payload.outcome === 'error'
        ? 'failed'
        : payload.outcome === 'stopped'
          ? 'stopped'
          : 'completed'
      return { reason, sessionId, settleSeq: payload.settleSeq, fulfillsN: payload.fulfills, ...file }
    }
    case 'aborted':
      return { reason: 'cancelled', sessionId }
    case 'death':
      return {
        reason: payload.cause === 'delete' ? 'deleted' : 'exited',
        sessionId,
        deathSeq: payload.deathSeq,
        fulfillsN: payload.fulfills,
        ...file,
        ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
        ...(extra.stderrTail !== undefined ? { stderrTail: extra.stderrTail } : {}),
      }
    case 'orphaned':
      return { reason: 'orphaned', sessionId, ...file }
  }
}

/**
 * respond 素材回执循环（D7① boolean 传导）：逐条 respond → onRespond(ok)。
 * 每条 RespondTarget 恰回一次 onRespond（D-8 bridge 契约）；respond 失败 → warn 留痕
 *（notifyId/sessionId/reason）+ onRespond(false) → orphaned + undelivered 计数。
 */
export function deliverRespondTargets(
  claims: ClaimLedger,
  targets: readonly RespondTarget[],
  respond: WatchRespondFn,
  extra: WatchRespondExtra = {},
): void {
  for (const t of targets) {
    const payload = toWatchRespondPayload(t.payload, t.sessionId, extra)
    const ok = respond(t.parentSid, t.watchId, payload) === true
    if (!ok) {
      console.warn(
        `[notify-claims] watch respond failed — notifyId=${t.notifyId} sessionId=${t.sessionId} reason=${payload.reason}`,
      )
    }
    claims.onRespond(t.parentSid, t.notifyId, ok)
  }
}

/**
 * TTL 清扫消费（D7 回收策略）：扫描转移时 watch 已挂的记录返回 respondOrphaned，
 * 此处同步应答 'orphaned'（extension 按 D3 例外1 静默收口，防孤儿 promise）+ onRespond 回执。
 * 组合根 index.ts 的清扫定时环与 handler 测试经同一函数驱动（测试可覆盖该腿）。
 */
export function runClaimSweep(claims: ClaimLedger, respond: WatchRespondFn): SweepResult {
  const result = claims.sweep()
  deliverRespondTargets(claims, result.respondOrphaned, respond)
  return result
}

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
  /** requestId 仅 watch 分支消费（deferred respond 的寻址键 = watchId）；其余分支忽略。 */
  run: (parentSessionId: string, params: P, requestId: string) => Promise<SessionManagerDispatchResult | null>
}

/** SessionManagerHandler 构造选项 */
export interface SessionManagerHandlerOptions {
  sessionService: ISessionService
  /**
   * sd-u5：delivery 装配（send 排队投递 + create 初始 prompt 直投）。
   * 组合根注入 sessionId 单例注册表（design.md §3.1 调用方 B / §3.4 单例约束）。
   */
  delivery: SessionDeliveryRegistry
  /**
   * 向 pi 发送 extension_ui_response（sessionId = 发起方 session，requestId 只在其 pending 表有效）。
   * 返回 boolean（true = 已写入发起方 pi 的 pending 表）作 watch respond 的 D7① 失败传导；
   * void/undefined（client 缺失、旧测试替身）一律按失败计（`=== true` 收敛）。
   */
  sendExtensionUiResponse: (sessionId: string, requestId: string, response: unknown, method?: string) => boolean | void
  /** 广播 session 列表变更（create 成功后触发） */
  broadcastSessionList: () => void
  /**
   * 通知债权状态机（notify-once U2/U3，组合根 index.ts 构造后经 server 注入）。
   * **可选 = 停用语义**：缺席（存量测试 / 退化装配）时不 arm、willNotify 恒 false、
   * watch 走 fail-closed 'cancelled'（旧 runtime 兼容象限的静默降级形态），undeliveredResults 恒 0。
   */
  claims?: ClaimLedger
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
   * @param requestId       pi extension_ui_request id（回写 response 用；watch 分支 = watchId）
   * @param parentSessionId 发起方 session id（response 直发其 pi 进程；create 时注入为父 id）
   * @param action          7 个 action 之一，或 marker 解析失败哨兵 '__malformed__'
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
      const result = await this.dispatch(action, parentSessionId, params, requestId)
      // null = watch 分支已自行收口（fail-closed / 立即 respond / 挂等 deferred）——
      // watch 的应答键是 watchId 且多数路径晚于本次调用返回，不走常规 respond。
      if (result === null) return
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
   * watch 应答写回（boolean 传导，D7①）：true = 已写入发起方 pi pending 表。
   * respond 失败（client 缺失 / 写入失败）→ false 交回执循环转 orphaned + 计数。
   */
  private respondWatch(parentSid: string, watchId: string, payload: SessionManagerWatchRespondPayload): boolean {
    return this.opts.sendExtensionUiResponse(parentSid, watchId, JSON.stringify(payload), 'select') === true
  }

  /** 组合根共用的 respond 适配（settle/death/TTL 清扫腿把素材交给同一写回通道语义）。 */
  readonly watchRespond: WatchRespondFn = (parentSid, watchId, payload) =>
    this.respondWatch(parentSid, watchId, payload)

  /**
   * 从 session 服务读 session 文件路径（respond payload 的 optional sessionFilePath，D-transcript）：
   * 内存态优先（活跃 session），回退持久化摘要（扫描/删除前现场）；查不到不填（缺席整行省略）。
   */
  private resolveSessionFile(sessionId: string): string | undefined {
    return (
      this.opts.sessionService.getSummary(sessionId)?.sessionFile ??
      this.opts.sessionService.getSession(sessionId)?.sessionFilePath ??
      undefined
    )
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
      watch: {
        isParams: isSessionManagerWatchParams,
        run: (parentSessionId, params, requestId) => this.handleWatch(requestId, parentSessionId, params),
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
    requestId: string,
  ): Promise<SessionManagerDispatchResult | null> {
    const route: SessionManagerRoute<SessionManagerParams[K]> = this.routes[action]
    if (!route.isParams(params)) {
      throw new Error(`invalid params for session-manager action '${action}'`)
    }
    return route.run(parentSessionId, params, requestId)
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

  /**
   * create 分支：四步串行时序 + notify-once 受理点 arm（设计 D2/D5）。
   *
   * 债权面（U3 接线）：
   * - claim：仅 create 携 prompt 时可能产生——notifyId 缺省/畸形 → 不 arm + willNotify:false
   *   + once 日志（象限2 观测信号）；形态合法但同键重复 → throw（幂等不变量执行点，
   *   错误对象携 sessionId 走恢复路径）。
   * - lifetime：claims 在册时无条件 arm（与 claim 双键独立，杜绝撞幂等键），
   *   `lifetimeNotifyId` 恒随结果返回（claims 缺席 = 停用象限：仍返键但未入册，
   *   extension 开表将 fail-closed 静默收口）。
   * - 原子回滚（D2）：sendDirect throw → claim 与 lifetime 一并静默 disarm（会话存但
   *   extension 收到 error 不会开表，留记录必悬挂）。
   */
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
    //
    // notify-once D2 受理点：claim arm 先于 lifetime arm（claim 重复时早抛，不留
    // 未开表的 lifetime 悬挂）；sendDirect 受理回执（await 成功）即 markInjected
    //（create 路径直调无 envelope 载体，新 session 必 idle 无 settled 竞态——D2 两路径锚差异）。
    const claims = this.opts.claims
    const wantsClaim = prompt !== undefined && prompt !== ''
    const notifyId = params.notifyId
    let claimArmed = false
    if (wantsClaim) {
      if (!isSessionManagerNotifyId(notifyId)) {
        logNotifyIdAbsence('create')
      } else if (claims) {
        const armResult = claims.arm({ parentSid: parentSessionId, notifyId, kind: 'claim', sessionId: session.id })
        if (!armResult.ok) {
          throw Object.assign(new Error('duplicate notifyId — claim already armed for this agent session'), {
            sessionId: session.id,
          })
        }
        claimArmed = true
      }
    }
    const lifetimeNotifyId = `sm-${randomUUID()}`
    if (claims) {
      const lt = claims.arm({ parentSid: parentSessionId, notifyId: lifetimeNotifyId, kind: 'lifetime', sessionId: session.id })
      if (!lt.ok) {
        // uuid 碰撞理论不可达；防御性回滚已 arm 的 claim，不留下无主记录
        if (claimArmed && notifyId !== undefined) claims.disarmDeliveryFailed(parentSessionId, notifyId)
        throw Object.assign(new Error('duplicate lifetime notifyId'), { sessionId: session.id })
      }
    }

    if (wantsClaim && typeof prompt === 'string') {
      try {
        await this.opts.delivery.sendDirect(session.id, prompt)
        if (claims && claimArmed && notifyId !== undefined) {
          claims.markInjected(parentSessionId, notifyId)
        }
      } catch (e) {
        // 原子回滚（D2）：claim 与 lifetime 一并静默 disarm（E7 同族：无 respond、无 undelivered 计数）
        if (claims) {
          if (claimArmed && notifyId !== undefined) claims.disarmDeliveryFailed(parentSessionId, notifyId)
          claims.disarmDeliveryFailed(parentSessionId, lifetimeNotifyId)
        }
        throw Object.assign(new Error(toErrorMessage(e)), { sessionId: session.id })
      }
    }

    // 4. respond
    return {
      sessionId: session.id,
      status: 'created',
      modelId: session.modelId || undefined,
      willNotify: claimArmed,
      lifetimeNotifyId,
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
    const { sessionId, prompt, notifyId } = params
    if (!this.isOwnedBy(parentSessionId, sessionId)) {
      return { error: 'target session is not managed by this agent' }
    }
    // notify-once D2 受理点 arm：notifyId 缺省/畸形 → 不 arm + willNotify:false + once 日志；
    // 形态合法但同键重复 → isError 回包（幂等不变量的执行点）。arm 在投递前——
    // 投递失败腿（catch 同步 disarm）保证失败不留幽灵记录（E7：零通知零 undelivered 计数）。
    const claims = this.opts.claims
    const validNotifyId = isSessionManagerNotifyId(notifyId)
    if (!validNotifyId) {
      logNotifyIdAbsence('send')
    }
    let armedNotifyId: string | undefined
    if (validNotifyId && claims) {
      const armResult = claims.arm({ parentSid: parentSessionId, notifyId, kind: 'claim', sessionId })
      if (!armResult.ok) {
        return { error: 'duplicate notifyId — claim already armed for this agent session' }
      }
      armedNotifyId = notifyId
    }
    const armed = armedNotifyId !== undefined
    try {
      await this.opts.delivery
        .getOrCreateDelivery(sessionId)
        .sendChecked({
          payload: { kind: 'text', content: prompt },
          // notifyId 穿 envelope additive meta（D2）：delivery 内核 onSettled delivered
          // 回执读 meta 完成 armed→injected 受理锚定（P9 帧序保证先于 settled 帧）；
          // parentSid 同携（回执侧无须反查归属）。rejected 回执 → 投递失败腿 disarm。
          ...(armed ? { meta: { notifyId: armedNotifyId, parentSid: parentSessionId } } : {}),
        })
      return { queued: true, willNotify: armed }
    } catch (e) {
      // 投递失败腿（D2 状态机）：armed → 静默删除（主 agent 已同步收到工具 error）
      if (armedNotifyId !== undefined) claims?.disarmDeliveryFailed(parentSessionId, armedNotifyId)
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
      return { status: 'not_found', undeliveredResults: this.opts.claims?.undeliveredCount(sessionId) ?? 0 }
    }

    return {
      status: summary.status,
      modelId: summary.modelId || undefined,
      // D6 undeliveredResults 事实计数（按被管理子会话分桶；claims 停用象限恒 0）
      undeliveredResults: this.opts.claims?.undeliveredCount(sessionId) ?? 0,
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
      // D6：发起方名下全量在册数（对 filtered 各子会话分桶求和；claims 停用象限恒 0）
      undeliveredResults: filtered.reduce(
        (n, s) => n + (this.opts.claims?.undeliveredCount(s.id) ?? 0),
        0,
      ),
    }
  }

  /**
   * abort 分支 + notify-once D4 主 abort 抹除钉位：入口**同步** `abortClaims`（先于
   * `await sessionService.abort`——防 abort 诱发的 settled('stopped') 在 await 间隙
   * 抢先兑现，场景6 时序性假红）；已挂 watch 的 claim 立即 respond 'cancelled'
   *（静默收口，D3 例外1）+ onRespond 回执，无 watch 者当场删除。
   */
  private async handleAbort(parentSessionId: string, params: SessionManagerAbortParams): Promise<SessionManagerAbortResult> {
    const { sessionId } = params
    if (!this.isOwnedBy(parentSessionId, sessionId)) {
      throw new Error('target session is not managed by this agent')
    }
    const claims = this.opts.claims
    if (claims) {
      const batch = claims.abortClaims(sessionId)
      deliverRespondTargets(claims, batch.targets, this.watchRespond)
    }
    await this.opts.sessionService.abort(sessionId)
    return { success: true }
  }

  /**
   * watch 分支（notify-once D2 纯应答通道）：单键寻址 (调用方 parentSid, notifyId)，
   * parentSid 取自路由上下文（连接身份）不由 params 传入。三分支：
   * - fail-closed：查无 claim（含 claims 停用象限）→ 立即 respond cancelled（无 claim 可回带，
   *   不携 sessionId——D-4），防长挂 select 泄漏；
   * - wait：未兑现 → 挂等（单 watch 槽新覆盖旧，被覆盖的旧 watch 永不 respond，
   *   悬 promise 已知无害 P1）——本次调用零 respond，应答由 settle/death/abort/TTL 腿晚达；
   * - respond：已兑现/已终结 → 立即应答，**respond 前二次归属校验**（D6 两态）：
   *   session 已不在（getSummary 缺失）→ 'exited'（死亡通知不凭空消失，'deleted' 仅由删除
   *   编排点登记）；session 仍在但归属失效 → 'cancelled'（静默）；仍有效 → 快照应答。
   * 应答后一律 onRespond 回执（D7①：true 删记录 / false 转 orphaned）。
   */
  private async handleWatch(
    watchId: string,
    parentSessionId: string,
    params: SessionManagerWatchParams,
  ): Promise<null> {
    const claims = this.opts.claims
    if (!claims) {
      // 停用象限：无 claim 可寻址 → 与 fail-closed 同形（extension 静默 unregister 收口）
      this.respondWatch(parentSessionId, watchId, { reason: 'cancelled' })
      return null
    }
    const routing = claims.openWatch(parentSessionId, params.notifyId, watchId)
    switch (routing.action) {
      case 'fail-closed':
        this.respondWatch(parentSessionId, watchId, { reason: 'cancelled' })
        return null
      case 'wait':
        // deferred：无应答对象变更，promise 挂起至 settle/death/abort/TTL 腿晚达
        return null
      case 'respond': {
        const t = routing.target
        const summary = this.opts.sessionService.getSummary(t.sessionId)
        let payload: SessionManagerWatchRespondPayload
        if (!summary) {
          // 二次校验两态之一：session 已不在（getSummary 缺失）→ 按 'exited' 应答
          //（运行时无法区分 delete/exit，统一归 'deleted' 之外的 'exited'；'deleted' 仅由删除编排点显式登记）
          payload = { reason: 'exited', sessionId: t.sessionId }
        } else if (!this.isOwnedBy(parentSessionId, t.sessionId)) {
          // 二次校验两态之二：session 仍在但归属失效 → 'cancelled' 静默（防伪造死亡通知）
          payload = { reason: 'cancelled', sessionId: t.sessionId }
        } else {
          payload = toWatchRespondPayload(t.payload, t.sessionId, {
            sessionFilePath: this.resolveSessionFile(t.sessionId),
          })
        }
        const ok = this.respondWatch(parentSessionId, watchId, payload) === true
        claims.onRespond(t.parentSid, t.notifyId, ok)
        return null
      }
    }
  }
}
