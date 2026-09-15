/**
 * File message handler —— 路由 file.* 消息（issues.md #2/#7/#14 / code-architecture §3.7）。
 *
 * 结构对称 git-message-handler：handles 清单 + switch 内编译期类型收窄 + 领域逻辑委托 FileService。
 *
 * 路由：
 * - file.tree        → fileService.listTree      → reply 'file.tree:result' {sessionId, tree}
 * - file.tree.expand → fileService.expandDir     → reply 'file.tree.expand:result' {sessionId, children}
 * - file.search.cwd  → fileService.searchFilesInCwd → reply 'file.search.cwd:result' {files, truncated}
 *   （landing cwd 路：composer $ 候选按 cwd 全量递归，reply 契约无 sessionId 字段；
 *    truncated = DoS 上限 5000 截止，D7；cwd 无效 → FileError('not_found') 结构化失败，
 *    设计 D6 准入边界：不做目录白名单）
 * - file.read        → fileService.readFile      → reply 'file.read:result' {content, truncated, path}
 *   （file.read 从 server.ts 内联下沉到 FileService，解三层违纪 AC-2b；W2 扩展 BC-3 白名单）
 * - file.write.create/rename/delete → fileService 骨架 → reply 'file.write.*.result' {implemented:false}
 *   （#14 D-018 实现延后；AC-14.4 结构化响应——catch FileError('not_implemented') 转 result 而非 error envelope）
 *
 * 错误：FileError → error envelope（D10/P0-B）。code 取自 FileError.code；
 * sessionId 透传 details。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { IFileService } from '../interfaces.js'
import { FileError } from '../services/file-error.js'
import { sendHandlerError } from './handler-utils.js'

/** File handler 的上下文（extends 共享发消息契约 + 领域依赖） */
export interface FileHandlerContext extends MessageHandlerContext {
  fileService: IFileService
}

export class FileMessageHandler {
  constructor(private ctx: FileHandlerContext) {}

  /**
   * D1: 本 handler 认领的 ClientMessageType 清单。
   * file.read 已从 server.ts 内联迁入（W2，解三层违纪 AC-2b）：走 FileService.readFileFromWhitelist
   * （BC-3 三目录白名单：~/.agents/skills、piAgentDir/skills、piAgentDir/npm）。
   */
  readonly handles: ClientMessageType[] = [
    'file.tree',
    'file.tree.expand',
    'file.search',
    'file.search.cwd',
    'file.read',
    'file.write.create',
    'file.write.rename',
    'file.write.delete',
  ]

  /**
   * 路由分发（复杂度债清偿 U07）：switch 保留提供编译期类型收窄，每个 case 体提为
   * 私有方法（msg 以 Extract 收窄后传入，语义与原 switch 内联收窄一致）。
   */
  async handleFileMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'file.tree':
        return this.handleTree(msg as Extract<ClientMessage, { type: 'file.tree' }>, ws)
      case 'file.tree.expand':
        return this.handleTreeExpand(msg as Extract<ClientMessage, { type: 'file.tree.expand' }>, ws)
      case 'file.search':
        return this.handleSearch(msg as Extract<ClientMessage, { type: 'file.search' }>, ws)
      case 'file.search.cwd':
        return this.handleSearchCwd(msg as Extract<ClientMessage, { type: 'file.search.cwd' }>, ws)
      case 'file.read':
        return this.handleRead(msg as Extract<ClientMessage, { type: 'file.read' }>, ws)
      case 'file.write.create':
        return this.handleWriteCreate(msg as Extract<ClientMessage, { type: 'file.write.create' }>, ws)
      case 'file.write.rename':
        return this.handleWriteRename(msg as Extract<ClientMessage, { type: 'file.write.rename' }>, ws)
      case 'file.write.delete':
        return this.handleWriteDelete(msg as Extract<ClientMessage, { type: 'file.write.delete' }>, ws)
    }
  }

  private async handleTree(msg: Extract<ClientMessage, { type: 'file.tree' }>, ws: WsType): Promise<void> {
    const { sessionId } = msg.payload
    try {
      const tree = await this.ctx.fileService.listTree(sessionId)
      return this.ctx.reply(ws, msg.id, 'file.tree:result', { sessionId, tree })
    } catch (e) {
      return this.sendFileError(ws, msg.id, sessionId, e)
    }
  }

  private async handleTreeExpand(msg: Extract<ClientMessage, { type: 'file.tree.expand' }>, ws: WsType): Promise<void> {
    const { sessionId, path } = msg.payload
    try {
      const children = await this.ctx.fileService.expandDir(sessionId, path)
      return this.ctx.reply(ws, msg.id, 'file.tree.expand:result', { sessionId, children })
    } catch (e) {
      return this.sendFileError(ws, msg.id, sessionId, e)
    }
  }

  private async handleSearch(msg: Extract<ClientMessage, { type: 'file.search' }>, ws: WsType): Promise<void> {
    // composer # 文件候选：全量递归当前 cwd（受 ignore + 深度上限 + 结果数上限）。
    // searchFiles 内部 per-dir 容错（单子目录错误跳过不中断），仅 session_not_found 抛出。
    const { sessionId, showIgnored } = msg.payload
    try {
      const files = await this.ctx.fileService.searchFiles(sessionId, showIgnored)
      return this.ctx.reply(ws, msg.id, 'file.search:result', { sessionId, files })
    } catch (e) {
      return this.sendFileError(ws, msg.id, sessionId, e)
    }
  }

  private async handleSearchCwd(msg: Extract<ClientMessage, { type: 'file.search.cwd' }>, ws: WsType): Promise<void> {
    // landing 态 composer $ 文件候选：按 cwd 全量递归（扫描约束与 file.search 同源——
    // 共用 searchFilesInCwd 核心）。reply 契约无 sessionId 字段（协议定义如此）；
    // truncated = DoS 上限 5000 截止（D7：截断事实来自 runtime，前端条件提示）；
    // cwd 无效 → FileError('not_found') → error envelope（D6 准入边界）。
    const { cwd } = msg.payload
    try {
      const { files, truncated } = await this.ctx.fileService.searchFilesInCwd(cwd)
      return this.ctx.reply(ws, msg.id, 'file.search.cwd:result', { files, truncated })
    } catch (e) {
      // cwd 路无 sessionId 上下文，传空串 → sendFileError 省略 details
      return this.sendFileError(ws, msg.id, '', e)
    }
  }

  private async handleRead(msg: Extract<ClientMessage, { type: 'file.read' }>, ws: WsType): Promise<void> {
    // file.read 分流（#7 BC-3 扩展）：有 sessionId → readFile(sessionId, path) cwd 守门（文件树预览）；
    // 无 sessionId → readFileFromWhitelist（BC-3 三目录白名单：skill 文件预览，向后兼容）。
    const { path, sessionId } = msg.payload
    try {
      const result = sessionId
        ? await this.ctx.fileService.readFile(sessionId, path)
        : await this.ctx.fileService.readFileFromWhitelist(path)
      return this.ctx.reply(ws, msg.id, 'file.read:result', { content: result.content, truncated: result.truncated, path })
    } catch (e) {
      return this.sendFileError(ws, msg.id, sessionId ?? '', e)
    }
  }

  private async handleWriteCreate(msg: Extract<ClientMessage, { type: 'file.write.create' }>, ws: WsType): Promise<void> {
    const { sessionId, path, content } = msg.payload
    try {
      await this.ctx.fileService.createFile(sessionId, path, content)
      // createFile 抛 not_implemented，正常不会走到这里（骨架永不 resolve）
      return this.ctx.reply(ws, msg.id, 'file.write.create:result', { sessionId, path, implemented: false })
    } catch (e) {
      // AC-14.4：file.write 骨架的 not_implemented 转结构化 result（非 error envelope）
      if (e instanceof FileError && e.code === 'not_implemented') {
        return this.ctx.reply(ws, msg.id, 'file.write.create:result', { sessionId, path, implemented: false })
      }
      return this.sendFileError(ws, msg.id, sessionId, e)
    }
  }

  private async handleWriteRename(msg: Extract<ClientMessage, { type: 'file.write.rename' }>, ws: WsType): Promise<void> {
    const { sessionId, oldPath, newPath } = msg.payload
    try {
      await this.ctx.fileService.renameFile(sessionId, oldPath, newPath)
      return this.ctx.reply(ws, msg.id, 'file.write.rename:result', { sessionId, newPath, implemented: false })
    } catch (e) {
      if (e instanceof FileError && e.code === 'not_implemented') {
        return this.ctx.reply(ws, msg.id, 'file.write.rename:result', { sessionId, newPath, implemented: false })
      }
      return this.sendFileError(ws, msg.id, sessionId, e)
    }
  }

  private async handleWriteDelete(msg: Extract<ClientMessage, { type: 'file.write.delete' }>, ws: WsType): Promise<void> {
    const { sessionId, path } = msg.payload
    try {
      await this.ctx.fileService.deleteFile(sessionId, path)
      return this.ctx.reply(ws, msg.id, 'file.write.delete:result', { sessionId, path, implemented: false })
    } catch (e) {
      if (e instanceof FileError && e.code === 'not_implemented') {
        return this.ctx.reply(ws, msg.id, 'file.write.delete:result', { sessionId, path, implemented: false })
      }
      return this.sendFileError(ws, msg.id, sessionId, e)
    }
  }

  /**
   * 统一 file 错误回复（D10/P0-B）。
   * - FileError → 取其 code（session_not_found / permission_denied / out_of_cwd / timeout / not_found / read_failed）
   * - 其它 → 'file_failed' + toErrorMessage
   * 注意：not_implemented 不走此方法（file.write 骨架在上游 catch 转结构化 result）。
   * sessionId 为空串时省略 details（保持既有行为）。
   */
  private sendFileError(ws: WsType, id: string | undefined, sessionId: string, e: unknown): void {
    sendHandlerError(this.ctx, ws, FileError, 'file_failed', e, id, sessionId ? { sessionId } : undefined)
  }
}
