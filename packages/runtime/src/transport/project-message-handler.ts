/**
 * Project message handler for project.* message types（D14，2026-08-04；
 * 命令通道 connection-datasync-ssot §6.6）。
 *
 * 结构对称 workspace-message-handler：handles 清单 + switch 内编译期类型收窄。
 * transport handler 零业务（只 ctx.reply / sendError / 广播），业务逻辑在 ProjectStore。
 *
 * 写通道唯一入口 = 命令通道（§6.6）：createProject / renameProject / removeProject /
 * setActiveProject（ProjectStore 串行队列 + revision 校验），成功回执
 * ProjectCommandReply（reply type 与 request 同名，preset.create 同款 payload 消费型
 * 同名模式）并广播 project.changed（失效信号——各窗口据此重拉，拉为主、推补充
 * ADR-0097）；拒绝（revision 失配 / 语义校验失败）走统一 error envelope，renderer
 * 保持命令前状态。legacy 整表写端点已随命令化拆除（§6.6③）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ProjectCommandReply } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { ProjectStore } from '../services/project/project-store.js'
import { ProjectCommandError } from '../services/project/project-store.js'

/** 命令通道四命令的 ClientMessageType（reply type 与 request 同名，见 runCommand）。 */
type ProjectCommandType = Extract<
  ClientMessageType,
  'project.createProject' | 'project.renameProject' | 'project.removeProject' | 'project.setActiveProject'
>

/** Project handler 的上下文（extends 共享发消息契约 + 领域依赖） */
export interface ProjectHandlerContext extends MessageHandlerContext {
  projectStore: ProjectStore
  /** 命令执行成功后的 project.changed 广播（空负载失效信号，不带数据——§6.6）。 */
  broadcastProjectChanged: () => void
}

export class ProjectMessageHandler {
  constructor(private ctx: ProjectHandlerContext) {}

  /** 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = [
    'project.load',
    'project.createProject',
    'project.renameProject',
    'project.removeProject',
    'project.setActiveProject',
  ]

  async handleProjectMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'project.load':
        return this.ctx.reply(ws, msg.id, 'project.loaded', this.loadReply())
      case 'project.createProject':
        return this.runCommand(ws, msg.id, msg.type, () =>
          this.ctx.projectStore.createProject(msg.payload.name, msg.payload.revision),
        )
      case 'project.renameProject':
        return this.runCommand(ws, msg.id, msg.type, () =>
          this.ctx.projectStore.renameProject(msg.payload.projectId, msg.payload.name, msg.payload.revision),
        )
      case 'project.removeProject':
        return this.runCommand(ws, msg.id, msg.type, () =>
          this.ctx.projectStore.removeProject(msg.payload.projectId, msg.payload.revision),
        )
      case 'project.setActiveProject':
        return this.runCommand(ws, msg.id, msg.type, () =>
          this.ctx.projectStore.setActiveProject(msg.payload.projectId, msg.payload.revision),
        )
    }
  }

  /**
   * 命令执行编排（§6.6）：拒绝（ProjectCommandError）→ error envelope（renderer pending
   * reject + 保持命令前状态）；成功 → 广播 project.changed 失效信号 + 回执完整新状态
   * 与 revision 新值（reply type 与 request 同名）。意外异常不在此吞（上层 handler_error
   * 兜底，connection-manager）。
   */
  private async runCommand(
    ws: WsType,
    msgId: string | undefined,
    replyType: ProjectCommandType,
    op: () => Promise<ProjectCommandReply>,
  ): Promise<void> {
    let reply: ProjectCommandReply
    try {
      reply = await op()
    } catch (e) {
      if (e instanceof ProjectCommandError) {
        this.ctx.sendError(ws, e.code, e.message, msgId)
        return
      }
      throw e
    }
    this.ctx.broadcastProjectChanged()
    return this.ctx.reply(ws, msgId, replyType, reply)
  }

  /** project.loaded 回执载荷：状态整表（归一化视图）+ 当前 revision 水位。 */
  private loadReply() {
    return {
      ...this.ctx.projectStore.load(),
      revision: this.ctx.projectStore.getRevision(),
    }
  }
}
