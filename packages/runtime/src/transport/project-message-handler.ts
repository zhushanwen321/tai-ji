/**
 * Project message handler for project.* message types（D14，2026-08-04）。
 *
 * 结构对称 workspace-message-handler：handles 清单 + switch 内编译期类型收窄。
 * transport handler 零业务（只 ctx.reply），业务逻辑在 ProjectStore。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ProjectStoreState } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { ProjectStore } from '../services/project/project-store.js'

/** Project handler 的上下文（extends 共享发消息契约 + 领域依赖） */
export interface ProjectHandlerContext extends MessageHandlerContext {
  projectStore: ProjectStore
}

export class ProjectMessageHandler {
  constructor(private ctx: ProjectHandlerContext) {}

  /** 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['project.load', 'project.save']

  async handleProjectMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'project.load':
        return this.ctx.reply(ws, msg.id, 'project.loaded', this.ctx.projectStore.load())
      case 'project.save': {
        // 校验失败仍必须 reply，否则前端 pending Promise 永不 resolve（破坏 RPC 契约）。
        // 结构校验：projects 必须是数组（元素级校验在 store 内兜底）。
        const state = msg.payload as ProjectStoreState
        if (!state || !Array.isArray(state.projects)) {
          this.ctx.reply(ws, msg.id, 'project.loaded', this.ctx.projectStore.load())
          return
        }
        this.ctx.projectStore.save(state)
        return this.ctx.reply(ws, msg.id, 'project.loaded', this.ctx.projectStore.load())
      }
    }
  }
}
