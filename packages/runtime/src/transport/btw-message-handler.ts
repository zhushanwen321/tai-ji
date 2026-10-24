/**
 * BtwMessageHandler —— btw.* 三帧控制范围路由（btw-question 设计 D6，M2-b）。
 *
 * 结构对称 worktree-message-handler：handles 清单 + switch + 领域转发（BtwService）。
 *
 * 职责（M2-b 验收①）：
 * - `btw.create` → resolveMain（主会话 cwd + 主 turn 活跃信号）→ BtwService.createLine
 *   → reply `{ sessionId, mainSid, forkState }` + **publish 全量线列表**（state topic 'btw'，
 *   M2-a 登记的 publish/stateSnapshot 面——create/remove 成功后广播，list 纯 reply）。
 * - `btw.list` → BtwService.listLines → reply `{ mainSid, threads }`（RPC 拉取兜底通道；
 *   不 publish——state 快照由 create/remove 的广播维护，双通道同一 payload）。
 * - `btw.remove` → BtwService.closeLine(deleteSessionFile) → ack reply `{ sessionId }` +
 *   publish 全量线列表。
 *
 * 契约要点：
 * - **ack 必回**：三帧每分支必落 reply 或 error envelope（均带 msg.id），无悬挂 pending；
 *   未知分支不可达（handles 清单即路由面，server buildRoutes 只派发这三型）。
 * - **检查 success**：closeLine 返回 false（未知线注册表竞态 / 并发双删）不回成功
 *   ack，走 `line_not_found` error envelope——与 M1-b BtwError 的 code 词汇表同源，
 *   renderer 可按同一张表分流恢复指引。
 * - **广播 best-effort**：publish 先于 reply 且自带 try/catch（bus.publish 零抛是 u4a
 *   设计不变量，此处防御 fake 注入与实现漂移）——广播失败 console.error 留痕、不吞 ack；
 *   线列表恢复由 btw.list RPC 拉取兜底（M2-a 双通道契约）。
 * - **消息通路零新增（D6）**：线内发送复用 `message.send`（sessionId = 线 pi 真实会话 id）、
 *   帧族复用 `message.*`——本 handler 不触碰 message.* 族（M2-b 验收③）。
 * - **P2 降级隔离**：领域错误经 sendHandlerError 收尾（BtwError → code 原样透传；
 *   未知错误 → 兜底 'btw_failed'），单帧失败不影响主链路。
 *
 * 依赖注入（B2/B1 授权接线）：组合根（index.ts）构造 BtwService 后经
 * RuntimeServerOptionalServices.btw（BtwRoutingDeps）注入 server，装配点在
 * assembleOptionalHandlers；messageBus/nextPushId 由 server 提供（与 sessionHandler ctx
 * 同款时序——组合根在 setServices 前已 setMessageBus）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ServerMessageMap } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import { sendHandlerError } from './handler-utils.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import { BtwError } from '../services/session/btw-service.js'
import type { BtwCreateResult, BtwService } from '../services/session/btw-service.js'
import { unbindCanvasOnSessionDeleted } from '../services/canvas/canvas-service.js'

/**
 * forkState 具名类型经 ServerMessageMap 索引访问取形（shared 包出口是选择性 re-export、
 * 未挂 BtwForkState 具名——core transport domains/btw.ts 同款 indexed-access 惯例）。
 */
type BtwForkState = ServerMessageMap['btw.create']['forkState']

/**
 * handler 消费的 BtwService 窄接口（四原语转发；结构化窄依赖 = 测试注入纯 fake 无 cast，
 * 组合根传完整 BtwService 结构性满足）。
 */
export type BtwServiceFace = Pick<BtwService, 'createLine' | 'listLines' | 'closeLine' | 'getLine'>

/**
 * BtwThreadInfo 具名类型经 ServerMessageMap 索引访问取形（同上 BtwForkState 惯例）。
 */
export type BtwThreadInfo = ServerMessageMap['btw.list']['threads'][number]

/**
 * `btw.list` 载荷构造（M2-a 双通道同 payload 不变量的单一实现）：reply / publish 广播
 * 两处共用，防映射漂移。
 * W4a 键统一：条目字段 vid → sessionId（线 pi 真实会话 id）。
 * W5：闲置回收机制残留删除（ADR-0122 清查收尾）——`reclaimImminent` 字段与
 * onWillReclaim 挂点已删，载荷不再携带该字段（协议字段 BtwThreadInfo.reclaimImminent
 * 的删除归协议收缩单元）。
 */
export function buildBtwThreadListPayload(
  service: Pick<BtwServiceFace, 'listLines'>,
  mainSid: string,
): { mainSid: string; threads: BtwThreadInfo[] } {
  return {
    mainSid,
    threads: service.listLines(mainSid).map(line => ({ sessionId: line.piSessionId })),
  }
}

/**
 * 组合根注入的 btw routing 依赖（server RuntimeServerOptionalServices.btw 的形状）。
 * cwd/主 turn 信号的解析留组合根（活跃表 + 扫描范围都在 SessionService）——transport 层
 * 不直连 sessions 内部状态。
 */
export interface BtwRoutingDeps {
  service: BtwServiceFace
  /**
   * 主会话解析（btw.create 用）：线 cwd = 主会话 cwd（D1/D2），mainTurnActive = 主 turn
   * 活跃信号（BtwCreateRequest 的可选增强——纯文本流式中文件级悬空 tool-call 不可判，
   * 分支③ pill 判定用）。undefined = 活跃表与扫描范围皆无 → main_session_not_found。
   */
  resolveMain(mainSid: string): { cwd: string; mainTurnActive: boolean } | undefined
}

/** BtwMessageHandler 的 context（messaging 共享依赖 + btw 领域依赖）。 */
export interface BtwHandlerContext extends MessageHandlerContext {
  btwService: BtwServiceFace
  resolveMain: BtwRoutingDeps['resolveMain']
  /**
   * 线列表状态广播通道（state topic 'btw'，publish 于 mainSid bus——M2-a 契约）。
   * 未注入 = 防御/测试形态，跳过广播（reply 面不受影响）。
   */
  messageBus?: IMessageBus | undefined
  /** push 帧 id 生成（组合根接 broker.nextPushId，与 sessionHandler ctx 同款）。 */
  nextPushId(): string
}

/**
 * D3 源状态三分支 → 协议 forkState（btw.create reply 的创建期 pill 数据源）。
 * `unknown` 是启动重建态（快照元信息不持久化），不可能出现在 create 结果中。
 */
function toForkState(kind: BtwCreateResult['snapshotKind']): BtwForkState {
  switch (kind) {
    case 'forked': return 'full'
    case 'truncated': return 'truncated'
    case 'no-source': return 'none'
  }
}

export class BtwMessageHandler {
  constructor(private ctx: BtwHandlerContext) {}

  /** 本 handler 认领的 ClientMessageType 清单（D6 三帧；无 btw.send / btw.close——不采用项）。 */
  readonly handles: ClientMessageType[] = ['btw.create', 'btw.list', 'btw.remove']

  async handleBtwMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'btw.create': {
        const { mainSid } = msg.payload
        if (typeof mainSid !== 'string' || !mainSid) {
          return this.ctx.sendError(ws, 'btw_failed', 'btw.create requires a non-empty mainSid', msg.id)
        }
        const main = this.ctx.resolveMain(mainSid)
        if (!main) {
          return this.ctx.sendError(
            ws, 'main_session_not_found',
            `Main session ${mainSid} cannot be resolved — open it first, then create the btw line`,
            msg.id, { sessionId: mainSid },
          )
        }
        try {
          const result = await this.ctx.btwService.createLine({
            mainSid,
            cwd: main.cwd,
            mainTurnActive: main.mainTurnActive,
          })
          // 成功后广播全量线列表（state topic 'btw'，publish 于 mainSid）——先广播后 ack：
          // publishThreadList 自带 best-effort 检查，构造性不阻断 reply。
          this.publishThreadList(result.mainSid)
          return this.ctx.reply(ws, msg.id, 'btw.create', {
            sessionId: result.sessionId,
            mainSid: result.mainSid,
            forkState: toForkState(result.snapshotKind),
          })
        } catch (e) {
          return sendHandlerError(this.ctx, ws, BtwError, 'btw_failed', e, msg.id, { sessionId: mainSid })
        }
      }

      case 'btw.list': {
        const { mainSid } = msg.payload
        if (typeof mainSid !== 'string' || !mainSid) {
          return this.ctx.sendError(ws, 'btw_failed', 'btw.list requires a non-empty mainSid', msg.id)
        }
        // 纯 reply（不 publish）：注册表枚举是同步只读过滤（listLines 内无抛错路径），
        // 异常兜底仍有 server handleMessage 的全局 catch → error envelope（ack 必回成立）。
        return this.ctx.reply(ws, msg.id, 'btw.list', buildBtwThreadListPayload(this.ctx.btwService, mainSid))
      }

      case 'btw.remove': {
        // W4a 键统一：入参 vid → sessionId（线 pi 真实会话 id）。存在性校验 = registry
        // 成员查询（btwService.getLine）——**不得**保留 `btw:` 前缀判别（isBtwVirtualId），
        // 否则 W4a 后留下全仓唯一一处按前缀判别的点，直接违反 I1 与验收项 9
        // （设计 §3.3.6 迁移表）。该切换随 payload 改名同批：旧判别器对 piId 形态恒 false，
        // 中间态会拒掉全部合法请求。
        const { sessionId } = msg.payload
        if (typeof sessionId !== 'string' || !sessionId) {
          return this.ctx.sendError(
            ws, 'btw_failed', 'btw.remove requires a non-empty thread sessionId', msg.id,
          )
        }
        const rec = this.ctx.btwService.getLine(sessionId)
        if (!rec) {
          return this.ctx.sendError(ws, 'line_not_found', `[btw] no such thread: ${sessionId}`, msg.id)
        }
        try {
          const closed = await this.ctx.btwService.closeLine(sessionId, { deleteSessionFile: true })
          if (!closed) {
            // 检查 success：注册表竞态（并发双删 / 与级联同拍）——不回成功 ack，
            // 走与 getLine 落空同款的 line_not_found（幂等语义：线已不在即视为删成）。
            // details 带 sessionId（rec 此前已取得）——与 catch 路径 sendHandlerError 的
            // details 形态对齐（关键规则 #7：错误帧关联会话，renderer 可路由归属）。
            return this.ctx.sendError(ws, 'line_not_found', `[btw] thread already closed: ${sessionId}`, msg.id, { sessionId: rec.mainSid })
          }
          // 画布绑定解绑（problem-solve-canvas，解绑规则唯一化「解绑 = 仅 session 真删除」）：
          // btw.remove = 用户显式删除线 session（closeLine deleteSessionFile）——与
          // SessionLifecycle.delete 的 btw 直删分支是同一条真实删除路径的两个入口，解绑
          // 不因入口不同而漏（F1-11 同族补齐：漏解的绑定滞留内存 Map 至 runtime 重启）。
          unbindCanvasOnSessionDeleted(sessionId)
          this.publishThreadList(rec.mainSid)
          return this.ctx.reply(ws, msg.id, 'btw.remove', { sessionId })
        } catch (e) {
          return sendHandlerError(this.ctx, ws, BtwError, 'btw_failed', e, msg.id, { sessionId: rec.mainSid })
        }
      }
    }
  }

  /**
   * 全量线列表状态广播（M2-a 登记的 btw.list publish/stateSnapshot 面）：state topic
   * typeKey 'btw'，publish 于 **mainSid** 会话 bus——重连/切回主会话经 stateSnapshot('btw')
   * 构造性恢复 drawer 线列表与 badge 聚合；实时面由本帧驱动。
   *
   * best-effort：广播失败留痕不抛（失败不吞 ack；恢复通道 = btw.list RPC 拉取兜底，
   * 双通道同一 payload——C6「需立即消费的状态必须可拉取」）。
   */
  private publishThreadList(mainSid: string): void {
    const bus = this.ctx.messageBus
    if (!bus) return
    try {
      bus.publish(mainSid, { type: 'btw.list', id: this.ctx.nextPushId(), payload: buildBtwThreadListPayload(this.ctx.btwService, mainSid) })
    } catch (e) {
      // 广播 best-effort：console.error 留痕（可观测非静默）；失败不吞掉随后的 ack
      //（线列表恢复通道 = btw.list RPC 拉取兜底）。
      console.error(`[btw] thread-list broadcast failed (mainSid=${mainSid}) — pull fallback via btw.list RPC remains available:`, e)
    }
  }
}
