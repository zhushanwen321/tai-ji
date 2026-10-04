/**
 * Workspace message handler for workspace.* message types.
 *
 * 结构对称 session-message-handler：handles 清单 + switch 内编译期类型收窄。
 * transport handler 零业务（只 ctx.reply），业务逻辑在 WorkspaceService。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

/** Workspace handler 的上下文（extends 共享发消息契约 + 领域依赖） */
export interface WorkspaceHandlerContext extends MessageHandlerContext {
  workspaceService: WorkspaceService
}

export class WorkspaceMessageHandler {
  constructor(private ctx: WorkspaceHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['workspace.listRecent', 'workspace.record', 'workspace.detectBare']

  async handleWorkspaceMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'workspace.listRecent':
        return this.ctx.reply(ws, msg.id, 'workspace.recentList', {
          records: this.ctx.workspaceService.list(),
        })
      case 'workspace.record': {
        // 选目录后热更新：record 写入最新工作区，随即返回刷新后的列表，
        // 前端据 reply 直接更新 store（一次往返完成写入+刷新，无 reload 时序竞争）。
        const { cwd } = msg.payload
        // 校验失败仍必须 reply，否则前端 pending Promise 永不 resolve（破坏 RPC 契约）。
        // RT-1#2：降级不静默——warn 留痕 + reply 附 degraded（三径同族，见 detectBare 注释）。
        if (typeof cwd !== 'string' || cwd.trim() === '') {
          console.warn(`[workspace-handler] workspace.record degraded: invalid cwd payload (cwd=${JSON.stringify(cwd)})`)
          this.ctx.reply(ws, msg.id, 'workspace.recentList', { records: this.ctx.workspaceService.list(), degraded: true })
          return
        }
        this.ctx.workspaceService.record(cwd)
        return this.ctx.reply(ws, msg.id, 'workspace.recentList', {
          records: this.ctx.workspaceService.list(),
        })
      }
      case 'workspace.detectBare': {
        // service 返 detector 原始结构 {isBareMode, wsRoot, barePath}，此处映射 isBareMode→isBare
        // 对齐 workspace.bareDetected 协议 payload（landing 态 isBare 由 pendingCwd 驱动，W2）。
        const { cwd } = msg.payload
        // 校验失败仍必须 reply，否则前端 pending Promise 永不 resolve（破坏 RPC 契约）。
        // RT-1#2：三条降级路径（record 无效 cwd / detectBare 无效 cwd / detector 抛错）此前
        // 全部回 success 形态零日志——isBare:false 兜底值与真实探测结果不可区分。现在 warn
        // 留痕 + reply 附 degraded:true（hint 给恢复指引），前端可区分「非 bare」与「没测出来」。
        if (typeof cwd !== 'string' || cwd.trim() === '') {
          console.warn(`[workspace-handler] workspace.detectBare degraded: invalid cwd payload (cwd=${JSON.stringify(cwd)})`)
          this.ctx.reply(ws, msg.id, 'workspace.bareDetected', { isBare: false, wsRoot: '', barePath: '', degraded: true, hint: '目录参数无效，未执行 bare 检测；请确认所选目录后重试。' })
          return
        }
        try {
          const { isBareMode, wsRoot, barePath } = await this.ctx.workspaceService.detectBare(cwd)
          return this.ctx.reply(ws, msg.id, 'workspace.bareDetected', { isBare: isBareMode, wsRoot, barePath })
        } catch (e) {
          // detector 理论上不抛（ENOENT 已内部兜底），但防御性 catch 保证 RPC 契约：拋错也 reply isBare:false
          console.warn(`[workspace-handler] workspace.detectBare degraded: detector threw for cwd=${cwd}:`, e)
          return this.ctx.reply(ws, msg.id, 'workspace.bareDetected', { isBare: false, wsRoot: '', barePath: '', degraded: true, hint: 'bare 检测执行失败，返回的是兜底值（isBare:false）而非探测结果；请查看 runtime 日志后重试。' })
        }
      }
    }
  }
}
