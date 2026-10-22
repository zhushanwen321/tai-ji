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
import type { IWorktreeService } from '../services/ports/worktree-service.js'

/** Workspace handler 的上下文（extends 共享发消息契约 + 领域依赖） */
export interface WorkspaceHandlerContext extends MessageHandlerContext {
  workspaceService: WorkspaceService
  /**
   * worktree 域服务（可选）：workspace.record 时后台 prefetch 默认远端。server 注入；
   * 未注入（防御/测试）跳过，record 主流程不受影响。
   */
  worktreeService?: IWorktreeService | null
}

export class WorkspaceMessageHandler {
  constructor(private ctx: WorkspaceHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = [
    'workspace.listRecent',
    'workspace.record',
    'workspace.setPinned',
    'workspace.defaultSessionDir',
  ]

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
        // RT-1#2：降级不静默——warn 留痕 + reply 附 degraded。
        if (typeof cwd !== 'string' || cwd.trim() === '') {
          console.warn(`[workspace-handler] workspace.record degraded: invalid cwd payload (cwd=${JSON.stringify(cwd)})`)
          this.ctx.reply(ws, msg.id, 'workspace.recentList', { records: this.ctx.workspaceService.list(), degraded: true })
          return
        }
        this.ctx.workspaceService.record(cwd)
        // 打开仓库预热：后台刷新默认远端的 remote-tracking ref（默认 base 推导的数据源）。
        // fire-and-forget——prefetch 内部吞全部错误且不阻塞本 reply；fetch 是网络命令，
        // 同 repo 并发由 git fetch 锁消解。
        void this.ctx.worktreeService?.prefetchDefaultRemote(cwd)
        return this.ctx.reply(ws, msg.id, 'workspace.recentList', {
          records: this.ctx.workspaceService.list(),
        })
      }
      case 'workspace.setPinned': {
        // pin/unpin 后回传最新列表（与 record 同款一次往返热更新）。超 pin 上限 /
        // 入参非法 → 列表不变 + degraded 标记（reply 恒发，不破坏 RPC 契约）。
        const { cwd, pinned } = msg.payload
        if (typeof cwd !== 'string' || cwd.trim() === '' || typeof pinned !== 'boolean') {
          console.warn(`[workspace-handler] workspace.setPinned degraded: invalid payload (cwd=${JSON.stringify(cwd)}, pinned=${JSON.stringify(pinned)})`)
          this.ctx.reply(ws, msg.id, 'workspace.recentList', { records: this.ctx.workspaceService.list(), degraded: true })
          return
        }
        const applied = this.ctx.workspaceService.setPinned(cwd, pinned)
        return this.ctx.reply(ws, msg.id, 'workspace.recentList', {
          records: this.ctx.workspaceService.list(),
          degraded: !applied,
        })
      }
      case 'workspace.defaultSessionDir':
        // 幂等 ensureDir 后返回路径（启动序列已 ensure 一次，此处自愈兜底）；
        // ensure 失败 = dir 空串（前端隐藏「默认会话」入口）。
        return this.ctx.reply(ws, msg.id, 'workspace.defaultSessionDir:result', {
          dir: this.ctx.workspaceService.defaultSessionDir(),
        })
    }
  }
}
