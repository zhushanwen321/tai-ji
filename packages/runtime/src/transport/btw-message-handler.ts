/**
 * BtwMessageHandler —— btw.* 三帧控制面路由（btw-question 设计 D6，M2-b）。
 *
 * 结构对称 worktree-message-handler：handles 清单 + switch + 领域转发（BtwService）。
 *
 * 职责（M2-b 验收①）：
 * - `btw.create` → resolveMain（主会话 cwd + 主 turn 活跃信号）→ BtwService.createLine
 *   → reply `{ vid, mainSid, forkState }` + **publish 全量线列表**（state topic 'btw'，
 *   M2-a 登记的 publish/stateSnapshot 面——create/remove 成功后广播，list 纯 reply）。
 * - `btw.list` → BtwService.listLines → reply `{ mainSid, threads }`（RPC 拉取兜底通道；
 *   不 publish——state 快照由 create/remove 的广播维护，双通道同一 payload）。
 * - `btw.remove` → BtwService.closeLine(deleteSessionFile) → ack reply `{ vid }` +
 *   publish 全量线列表。
 *
 * 契约要点：
 * - **ack 必回**：三帧每分支必落 reply 或 error envelope（均带 msg.id），无悬挂 pending；
 *   未知分支不可达（handles 清单即路由面，server buildRoutes 只派发这三型）。
 * - **检查 success**：closeLine 返回 false（未知 vid 注册表竞态 / 并发双删）不回成功
 *   ack，走 `line_not_found` error envelope——与 M1-b BtwError 的 code 词汇表同源，
 *   renderer 可按同一张表分流恢复指引。
 * - **广播 best-effort**：publish 先于 reply 且自带 try/catch（bus.publish 零抛是 u4a
 *   设计不变量，此处防御 fake 注入与实现漂移）——广播失败 console.error 留痕、不吞 ack；
 *   线列表恢复由 btw.list RPC 拉取兜底（M2-a 双通道契约）。
 * - **消息通路零新增（D6）**：线内发送复用 `message.send`（sessionId = btw vid）、
 *   帧族复用 `message.*`——本 handler 不触碰 message.* 族（M2-b 验收③）。
 * - **P2 降级隔离**：领域错误经 sendHandlerError 收口（BtwError → code 原样透传；
 *   未知错误 → 兜底 'btw_failed'），单帧失败不影响主链路。
 *
 * 依赖注入（B2/B1 授权接线）：组合根（index.ts）构造 BtwService 后经
 * RuntimeServerOptionalServices.btw（BtwRoutingDeps）注入 server，装配点在
 * assembleOptionalHandlers；messageBus/nextPushId 由 server 提供（与 sessionHandler ctx
 * 同款时序——组合根在 setServices 前已 setMessageBus）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ServerMessageMap } from '@taiji/shared'
import { isBtwVirtualId } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import { sendHandlerError } from './handler-utils.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import { BtwError } from '../services/session/btw-service.js'
import type { BtwCreateResult, BtwService } from '../services/session/btw-service.js'

/**
 * forkState 具名类型经 ServerMessageMap 索引访问取形（shared 包出口是选择性 re-export、
 * 未挂 BtwForkState 具名——core transport domains/btw.ts 同款 indexed-access 惯例）。
 */
type BtwForkState = ServerMessageMap['btw.create']['forkState']

/**
 * handler 消费的 BtwService 窄面（四原语转发；结构化窄依赖 = 测试注入纯 fake 无 cast，
 * 组合根传完整 BtwService 结构性满足）。
 */
export type BtwServiceFace = Pick<BtwService, 'createLine' | 'listLines' | 'closeLine' | 'getLine'>

/**
 * 组合根注入的 btw routing 依赖（server RuntimeServerOptionalServices.btw 的形状）。
 * cwd/主 turn 信号的解析留组合根（活跃表 + 扫描面都在 SessionService）——transport 层
 * 不直连 sessions 内部状态。
 */
export interface BtwRoutingDeps {
  service: BtwServiceFace
  /**
   * 主会话解析（btw.create 用）：线 cwd = 主会话 cwd（D1/D2），mainTurnActive = 主 turn
   * 活跃信号（BtwCreateRequest 的可选增强——纯文本流式中文件级悬空 tool-call 不可判，
   * 分支③ pill 判定用）。undefined = 活跃表与扫描面皆无 → main_session_not_found。
   */
  resolveMain(mainSid: string): { cwd: string; mainTurnActive: boolean } | undefined
}

/** BtwMessageHandler 的 context（messaging 共享面 + btw 领域依赖）。 */
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

  /** 本 handler 认领的 ClientMessageType 清单（D6 三帧；无 btw.send / btw.close——被否项）。 */
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
          // publishThreadList 自带 best-effort 守卫，构造性不阻断 reply。
          this.publishThreadList(result.mainSid)
          return this.ctx.reply(ws, msg.id, 'btw.create', {
            vid: result.vid,
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
        // 纯 reply（不 publish）：注册表枚举是同步只读过滤（listLines 内无抛错面），
        // 异常兜底仍有 server handleMessage 的全局 catch → error envelope（ack 必回成立）。
        const threads = this.ctx.btwService.listLines(mainSid).map(line => ({ vid: line.vid }))
        return this.ctx.reply(ws, msg.id, 'btw.list', { mainSid, threads })
      }

      case 'btw.remove': {
        const { vid } = msg.payload
        if (typeof vid !== 'string' || !isBtwVirtualId(vid)) {
          return this.ctx.sendError(
            ws, 'btw_failed', 'btw.remove requires a btw thread vid (btw:<piSessionId>)', msg.id,
          )
        }
        const rec = this.ctx.btwService.getLine(vid)
        if (!rec) {
          return this.ctx.sendError(ws, 'line_not_found', `[btw] no such thread: ${vid}`, msg.id)
        }
        try {
          const closed = await this.ctx.btwService.closeLine(vid, { deleteSessionFile: true })
          if (!closed) {
            // 检查 success：注册表竞态（并发双删 / 与级联同拍）——不回成功 ack，
            // 走与 getLine 落空同款的 line_not_found（幂等语义：线已不在即视为删成）。
            return this.ctx.sendError(ws, 'line_not_found', `[btw] thread already closed: ${vid}`, msg.id)
          }
          this.publishThreadList(rec.mainSid)
          return this.ctx.reply(ws, msg.id, 'btw.remove', { vid })
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
    const threads = this.ctx.btwService.listLines(mainSid).map(line => ({ vid: line.vid }))
    try {
      bus.publish(mainSid, { type: 'btw.list', id: this.ctx.nextPushId(), payload: { mainSid, threads } })
    } catch (e) {
      // 广播 best-effort：console.error 留痕（可观测非静默）；失败不吞掉随后的 ack
      //（线列表恢复通道 = btw.list RPC 拉取兜底）。
      console.error(`[btw] thread-list broadcast failed (mainSid=${mainSid}) — pull fallback via btw.list RPC remains available:`, e)
    }
  }
}
