/**
 * CanvasMessageHandler —— problem-solve-canvas U3 transport 接线（marker 通道 + canvas.* RPC 面 + 回推派发）。
 *
 * 设计锚点：.tmp/tech-design/problem-solve-canvas.md §3.1(1)(2)(3) + §5-U3。
 *
 * 两条通道、一个 handler（对齐 SessionManagerHandler 先例）：
 * - marker 通道：pi extension 工具 execute 经 ctx.ui.select(CANVAS_MARKER, [{action, params}])
 *   挂起 → event-adapter 显式分支翻译为 canvas-ui kind → EventInterpreter fire-and-forget
 *   路由到 handle() → 调 CanvasService → 应答经 sendExtensionUiResponse 解挂（select value
 *   通道）。通道调用方恒为 agent 工具（review-append 例外按矩阵映射 actor=review）——
 *   「agent / review 的 mutate 不回推」由此构造性成立（防回环，设计 D5）。
 * - WS RPC 通道：canvas.list / canvas.get / canvas.mutate（GUI 操作链，payload.actor 恒 'user'）
 *   → 同一 CanvasService 唯一入口。
 *
 * 回推派发（设计 §3.1(1) 回推节）：WS mutate 成功且 actor='user' 时，对该画布活跃绑定集合
 * （CanvasService.getBoundSessions ∩ 存活 session）逐个 client.prompt(通知文本)。存活判定 =
 * 现成 client 存在且未退出（进程生死二态，ADR-0122）——**不经 ensureActive**（该入口带崩溃后
 * 懒重生语义，误用会把已关闭 session 的 pi 进程拉活并触发 turn，对用户会话表面的实质副作用）。
 * 逐事件一条通知，不做时间窗聚合（pi send 队列天然串行化，设计 D5）。
 *
 * 广播接线（broadcastUpdated，server.ts 装配注入 CanvasService.onUpdated）：mutate 成功后经
 * broker 全局广播 {type:'canvas.updated', payload:{canvasId, evType, eventId, summary}}——
 * 无 sessionId（画布是跨 session 共享资源；无 sid 全局消息走 broker.broadcast 非 bus topic
 * 表，rollingRestart 先例；`canvas.` 前缀不触发 broker 的 session-scoped 哨兵）。
 *
 * 失败语义（分级错误处理契约）：领域拒绝（不变量 / 状态机 / 矩阵 / 寻址）→ 结构化错误
 * （CanvasError：code + message + recover）沿原通道返回——marker 通道回 {ok:false, error}
 * select value、WS 通道回 reply 两态信封或 error envelope；基础设施失败（磁盘 IO）→ 上抛
 * 走 server 兜底。畸形 payload（JSON 解析失败 / 词表外 / params 非法）以结构化错误应答回
 * marker 通道，不降级用户可见对话框（内部服务类 marker 无降级语义，CANVAS_MARKER 契约注释）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ServerMessage } from '@taiji/shared'
import {
  CANVAS_EVENT_TYPES,
  CANVAS_MARKER_ACTIONS,
  canvasError,
  isCanvasMarkerRequest,
  type CanvasActor,
  type CanvasMarkerAction,
  type CanvasMarkerParams,
  type CanvasMutateReply,
  type CanvasMutateRequest,
} from '@zhushanwen/extension-protocol'
import { isCanvasDomainError } from '../services/canvas/canvas-domain.js'
import type { CanvasService, CanvasUpdatedBroadcast } from '../services/canvas/canvas-service.js'
import type { ISessionService } from '../interfaces.js'
import { toErrorMessage } from '../utils/errors.js'
import type { MessageHandlerContext } from './message-context.js'

/** marker 畸形哨兵（event-adapter 折叠非法 payload；SESSION_MANAGER 同款形态）。 */
type CanvasMarkerMalformed = '__malformed__'

/**
 * 回推通知文本（设计 §3.1(1)：领域事件的人类可读摘要 + 「画布事件通知，agent 必须响应；
 * 响应前先 canvas_read 取当前态」响应协议指引——摘要仅供定位与留痕，响应动作一律先
 * canvas_read 取当前态（拉为主对称落到 agent 侧，决策 D5 响应协议）。
 * 导出供测试锁定文案契约（A3 验收「通知与用户输入可区分」的「画布事件通知」标注锚点）。
 */
export function canvasNotifyText(summary: string, canvasId: string): string {
  return `[画布事件通知] ${summary}（画布事件通知：agent 必须响应；响应前先 canvas_read 取画布 ${canvasId} 当前态再行动）`
}

export interface CanvasHandlerContext extends MessageHandlerContext { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  sessionService: ISessionService
  canvasService: CanvasService
  /**
   * marker 应答写回通道：向发起方 pi 进程 stdin 发 extension_ui_response（requestId 只在其
   * pending 表有效，按 sessionId 直发不能遍历找 client——session-manager 装配同款约束）。
   * 返回 true = 已写入 pi stdin；void/undefined（client 缺失、测试替身）按失败计。
   */
  sendExtensionUiResponse: (sessionId: string, requestId: string, response: unknown, method?: string) => boolean | void
  /** canvas.updated 全局广播通道（broker.broadcast——无 sid 全局帧，rollingRestart 先例）。 */
  broadcast: (msg: ServerMessage) => void
  /** push 消息 id 生成器（广播帧 id）。 */
  nextPushId: () => string
}

/** 单个 marker action 的分发路由（params 已由 isCanvasMarkerRequest 守卫收窄）。 */
interface CanvasMarkerRoute<P> { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  run: (sessionId: string, params: P) => unknown
}

export class CanvasMessageHandler {
  /** 本 handler 认领的 WS 路由（canvas.* 三 RPC；marker 通道不走 WS 路由表）。 */
  readonly handles: ClientMessageType[] = ['canvas.list', 'canvas.get', 'canvas.mutate']

  constructor(private readonly ctx: CanvasHandlerContext) {}

  // ── WS RPC 面（canvas.list / canvas.get / canvas.mutate）──────────

  async handleCanvasMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'canvas.list':
        return this.handleCanvasList(msg, ws)
      case 'canvas.get':
        return this.handleCanvasGet(msg, ws)
      case 'canvas.mutate':
        return this.handleCanvasMutate(msg, ws)
    }
  }

  private handleCanvasList(msg: Extract<ClientMessage, { type: 'canvas.list' }>, ws: WsType): void {
    return this.ctx.reply(ws, msg.id, 'canvas.list', this.ctx.canvasService.listCanvases())
  }

  private handleCanvasGet(msg: Extract<ClientMessage, { type: 'canvas.get' }>, ws: WsType): void {
    // 领域拒绝（canvas_not_found / node_not_found）→ error envelope（code + hint 恢复动作）；
    // 基础设施失败（磁盘 IO）上抛走 server 兜底。
    try {
      const state = this.ctx.canvasService.readState(msg.payload.canvasId)
      // 绑定徽标数据源（设计 §3.1(3)）：活跃绑定数随全量视图附加（查询侧派生，不落盘——
      // CanvasState.activeBindings 契约注释；空集合 0 = 徽标明示「当前无 agent 在响应」）。
      return this.ctx.reply(ws, msg.id, 'canvas.get', {
        ...state,
        activeBindings: this.activeBoundClients(msg.payload.canvasId).length,
      })
    } catch (e: unknown) {
      if (isCanvasDomainError(e)) {
        // taste:allow-outbound-without-session-id — canvas.get 跨 session 画布查询，画布不属任何 session（与 canvas.updated 同一全局语义），错误帧无会话归属可关联
        return this.ctx.sendError(ws, e.detail.code, e.detail.message, msg.id, { hint: e.detail.recover })
      }
      throw e
    }
  }

  private handleCanvasMutate(msg: Extract<ClientMessage, { type: 'canvas.mutate' }>, ws: WsType): void {
    const { actor, ...request } = msg.payload
    // mutate 唯一入口：领域拒绝走 reply 失败腿（ok:false 结构化错误），不 throw；
    // 成功腿按 actor 判定回推——防回环（actor 维度）的构造点：marker 通道恒 agent/review
    // 不进本路径，WS 通道仅 actor='user' 回推（GUI 用户裁决驱动 agent 响应，设计 D5）。
    const result = this.ctx.canvasService.mutate(request, actor)
    if (result.ok && actor === 'user') {
      const canvasId = result.canvasId ?? (request.action !== 'create' ? request.params.canvasId : undefined)
      if (canvasId !== undefined) this.pushToBoundSessions(canvasId, result)
    }
    return this.ctx.reply(ws, msg.id, 'canvas.mutate', result)
  }

  // ── marker 通道（CANVAS_MARKER select 往返）───────────────────────

  /**
   * canvas marker 请求处理（EventInterpreter.onCanvasRequest fire-and-forget 调用，
   * server.handleCanvasRequest 委托）。
   *
   * @param requestId pi extension_ui_request id（select value 通道应答寻址键）
   * @param sessionId 发起方 session id（应答直发其 pi 进程 + create/enter 绑定登记载体）
   * @param action    marker 词表 action，或 event-adapter 折叠的 '__malformed__' 哨兵
   * @param params    action 参数（LLM 可控 JSON——dispatch 前经契约总守卫复检）
   * @returns 结构性不外抛（dispatch 全段 try-catch 兜底收口为结构化错误应答）——
   *          server 侧 fire-and-forget 调用免 catch。
   */
  async handle(requestId: string, sessionId: string, action: CanvasMarkerAction | CanvasMarkerMalformed, params: Record<string, unknown>): Promise<void> {
    // 畸形应答（结构化错误回 marker 通道，不降级对话框）：'__malformed__'（JSON 解析失败 /
    // 契约守卫不过）与词表外 action 统一 invalid_params + 恢复指引。
    const malformedReply: CanvasMutateReply = {
      ok: false,
      error: canvasError('invalid_params', `canvas 请求畸形：action「${String(action)}」或 params 不在 marker 契约内（CANVAS_MARKER_ACTIONS 词表 + 对应 params 形状）`),
    }
    if (action === '__malformed__' || !(CANVAS_MARKER_ACTIONS as readonly string[]).includes(action)) {
      return this.respond(sessionId, requestId, malformedReply)
    }
    // 信任边界守卫（params 来自 LLM 可控 JSON）：event-adapter 已守一道，此处复检同款防线
    // ——防翻译层回归静默放行畸形（session-manager 逐 action 守卫同纪律）。守卫通过后
    // params 在值域层即契约形状（correlated union，TS 不跨变量保持关联——以联合整体传入
    // dispatch，路由表内经泛型索引回到单 action 收窄）。
    const request: unknown = { action, params }
    if (!isCanvasMarkerRequest(request)) {
      return this.respond(sessionId, requestId, malformedReply)
    }
    try {
      const result = this.dispatch(request.action, sessionId, request.params)
      this.respond(sessionId, requestId, result)
    } catch (e: unknown) {
      // 领域拒绝（read/enter 的 canvas_not_found 等 CanvasDomainError）→ 结构化错误；
      // 基础设施失败 → error envelope 同通道 + error 日志（不打断 runtime 主循环）。
      if (isCanvasDomainError(e)) {
        return this.respond(sessionId, requestId, { ok: false, error: e.detail } satisfies CanvasMutateReply)
      }
      console.error(`[canvas] marker 请求处理失败（session=${sessionId} action=${action} requestId=${requestId}）：`, e)
      return this.respond(sessionId, requestId, { ok: false, error: canvasError('invalid_params', toErrorMessage(e)) } satisfies CanvasMutateReply)
    }
  }

  /**
   * marker action 路由表：mutate 词表 14 action 统一走 mutateFromMarker（actor 按矩阵唯一
   * 合法格推导）；read / list 直查；enter = 读全量 + 绑定登记（打开形态，非 mutation 不产事件）。
   * 新增 action 只加一行（session-manager routes 表同款收敛）。
   */
  private readonly markerRoutes: {
    readonly [K in CanvasMarkerAction]: CanvasMarkerRoute<CanvasMarkerParams[K]>
  } = {
      create: { run: (sid, params) => this.mutateFromMarker(sid, { action: 'create', params }) },
      grow: { run: (sid, params) => this.mutateFromMarker(sid, { action: 'grow', params }) },
      patch: { run: (sid, params) => this.mutateFromMarker(sid, { action: 'patch', params }) },
      'decide-direction': { run: (sid, params) => this.mutateFromMarker(sid, { action: 'decide-direction', params }) },
      select: { run: (sid, params) => this.mutateFromMarker(sid, { action: 'select', params }) },
      transition: { run: (sid, params) => this.mutateFromMarker(sid, { action: 'transition', params }) },
      comment: { run: (sid, params) => this.mutateFromMarker(sid, { action: 'comment', params }) },
      'comment-respond': { run: (sid, params) => this.mutateFromMarker(sid, { action: 'comment-respond', params }) },
      'review-request': { run: (sid, params) => this.mutateFromMarker(sid, { action: 'review-request', params }) },
      'review-append': { run: (sid, params) => this.mutateFromMarker(sid, { action: 'review-append', params }) },
      'review-resolve': { run: (sid, params) => this.mutateFromMarker(sid, { action: 'review-resolve', params }) },
      'converge-check': { run: (sid, params) => this.mutateFromMarker(sid, { action: 'converge-check', params }) },
      export: { run: (sid, params) => this.mutateFromMarker(sid, { action: 'export', params }) },
      dispatch: { run: (sid, params) => this.mutateFromMarker(sid, { action: 'dispatch', params }) },
      read: { run: (_sid, params) => this.ctx.canvasService.readState(params.canvasId, params.subtree) },
      list: { run: () => this.ctx.canvasService.listCanvases() },
      enter: {
        run: (sid, params) => {
        // 打开已有画布：读全量（点开即完整图，设计目标 1）+ 绑定登记（sessionId ↔ canvasId，
        // 回推路由建立——重开 session 不自动恢复回推，须重新 enter，设计回推节载体裁决）。
          const state = this.ctx.canvasService.readState(params.canvasId)
          this.ctx.canvasService.bindSession(sid, params.canvasId)
          return state
        },
      },
    }

  /**
   * marker 通道 mutate：actor 按矩阵唯一合法格推导——marker 通道调用方恒为 agent 工具，
   * 唯一例外 review-append（reviewer subagent 经 canvas_review 的报告写回，矩阵仅 review
   * 格为 true → actor='review'）。表外组合（如 marker 通道试图 decide-direction）由
   * CanvasService 矩阵校验拒为 actor_not_allowed——runtime 按通道放行、按矩阵校验，
   * 不按意图判定（矩阵注释同口径）。
   */
  private mutateFromMarker(sessionId: string, request: CanvasMutateRequest): CanvasMutateReply {
    const actor: CanvasActor = request.action === 'review-append' ? 'review' : 'agent'
    const result = this.ctx.canvasService.mutate(request, actor)
    // 创建形态的绑定登记（契约 marker.ts 两层词表注释：marker 通道 create 成功时一并登记；
    // GUI 托盘新建走 WS 通道、不登记绑定——画布创建者不是回推对象，回推对象 = enter 的 agent）。
    if (result.ok && request.action === 'create' && result.canvasId !== undefined) {
      this.ctx.canvasService.bindSession(sessionId, result.canvasId)
    }
    return result
  }

  /** 泛型索引分发（correlated union 标准写法，session-manager dispatch 同款）。 */
  private dispatch<K extends CanvasMarkerAction>(action: K, sessionId: string, params: CanvasMarkerParams[K]): unknown {
    const route: CanvasMarkerRoute<CanvasMarkerParams[K]> = this.markerRoutes[action]
    return route.run(sessionId, params)
  }

  /** marker 应答统一收口：select value 通道 JSON 应答；发送失败 warn 留痕（apply-then-respond
   * 契约——画布状态已落盘权威，不建重投补偿，agent 重试经幂等 upsert 安全，设计 §3.1(1)）。 */
  private respond(sessionId: string, requestId: string, data: unknown): void {
    const delivered = this.ctx.sendExtensionUiResponse(sessionId, requestId, JSON.stringify(data), 'select')
    if (delivered !== true) {
      console.warn(
        `[canvas] marker 应答未送达（session=${sessionId} requestId=${requestId}）— pi 进程不在或写入失败；` +
          '画布状态以 events.jsonl 为准，agent 侧重试经幂等 upsert 安全',
      )
    }
  }

  // ── 回推派发（WS mutate actor=user 成功腿）──────────────────────

  /**
   * 活跃绑定集合（设计 §3.1(1)：绑定记录 ∩ 存活 session）——回推派发与绑定徽标
   * （canvas.get 的 activeBindings 派生）共用的单一交集判定，返回 sid + 现成 client
   * 对。存活 = client 存在且未退出（进程生死二态，ADR-0122，不区分退出原因、不设宽限窗）；
   * 绑定在册但不存活的 session 排除并留痕（这正是徽标显示「无 agent 在响应」的原因
   * 留痕——绑定不随 pi 崩溃解绑，session 重开即恢复回推）。
   */
  private activeBoundClients(canvasId: string): Array<{ sid: string; client: NonNullable<ReturnType<ISessionService['getRpcClient']>> }> {
    const out: Array<{ sid: string; client: NonNullable<ReturnType<ISessionService['getRpcClient']>> }> = []
    for (const sid of this.ctx.canvasService.getBoundSessions(canvasId)) {
      const client = this.ctx.sessionService.getRpcClient(sid)
      if (!client || client.exited) {
        console.info(`[canvas] 绑定 session 不存活，活跃交集排除（canvasId=${canvasId} session=${sid}）——绑定不随 pi 崩溃解绑，session 重开即恢复回推`)
        continue
      }
      out.push({ sid, client })
    }
    return out
  }

  /**
   * 对画布活跃绑定集合逐个回推（现成 client 直取，不经 ensureActive——防拉活已关 session
   * 的 pi，见类头注释）。prompt fire-and-forget：失败 warn（首败显式上报，不重试——
   * ADR-0122 手动恢复口径）。streamingBehavior='followUp' 显式排队：pi 1.0.0 契约 = 占线
   * 且缺省该参数直接 throw「Agent is already processing」（D3-A3 v6 实证：用户连续裁决
   * 的高频路径下回推静默丢失），followUp 让连续裁决逐条排队、agent 完成当前响应后依次
   * 消化——不打断进行中的 turn（steer 会中断，通知场景语义不符）。
   */
  private pushToBoundSessions(canvasId: string, reply: Extract<CanvasMutateReply, { ok: true }>): void {
    const text = canvasNotifyText(reply.summary, canvasId)
    for (const { sid, client } of this.activeBoundClients(canvasId)) {
      void client.prompt(text, undefined, 'followUp').catch((e: unknown) => {
        console.warn(`[canvas] 回推 prompt 失败（canvasId=${canvasId} session=${sid}）：${toErrorMessage(e)}`)
      })
    }
  }

  // ── 广播接线（CanvasService.onUpdated → broker 全局通道）────────

  /**
   * canvas.updated 全局广播帧封装（server.ts 装配注入 CanvasService.onUpdated）。
   * payload 无 sessionId（broker.broadcast 契约：`canvas.` 前缀合法全局帧，rollingRestart
   * 先例）；广播只是失效提示（renderer 收到后重新 canvas.get 拉取收敛，ADR-0097 拉为主）。
   */
  broadcastUpdated(update: CanvasUpdatedBroadcast): void {
    // evType 收窄守卫：service 层广播回调的 evType 是 string（服务层宽化），wire 契约是
    // CanvasEventType 封闭词表——值源自 ACTION_EVENT_MAP 表内映射，越界即内部回归，
    // 拒发 + error 留痕（不广播词表外假值污染消费方 evType 分流）。
    if (!(CANVAS_EVENT_TYPES as readonly string[]).includes(update.evType)) {
      console.error(`[canvas] canvas.updated evType「${update.evType}」越界（CANVAS_EVENT_TYPES 词表外）——跳过广播`)
      return
    }
    this.ctx.broadcast({
      type: 'canvas.updated',
      id: this.ctx.nextPushId(),
      payload: {
        canvasId: update.canvasId,
        evType: update.evType,
        eventId: update.eventId,
        summary: update.summary,
      },
    })
  }
}
