/**
 * Git message handler —— 路由 git.* 消息。
 *
 * 结构对称 extension-message-handler：handles 清单 + switch 内编译期类型收窄 + 领域逻辑。
 *
 * 路由：
 * - git.status  → gitService.getStatus → reply 'git.status:result'
 * - git.stage   → gitService.stage     → reply 'message.status' {status:'staged'}    （ack 复用 message.status）
 * - git.unstage → gitService.unstage   → reply 'message.status' {status:'unstaged'}
 * - git.commit  → gitService.commit    → reply 'message.status' {status:'committed'}
 * - git.checkout → gitService.checkout → reply 'message.status' {status:'switched'}  （#6 选分支 popover）
 * - git.createBranch → gitService.createBranch → reply 'message.status' {status:'branch_created'} （#7 创建分支 modal）
 *
 * 写操作失效（perf W17，03 D4-3）：6 个写操作成功后、reply 前调 gitService.invalidateStatusCache
 * （stage/unstage/commit/createBranch 按 sessionId；checkout 与 checkoutCwd 按 cwd——checkout 改变
 * 整个 worktree HEAD，对共享该 cwd 的所有 session 可见，W17 审查 Fix-2）——下次 getStatus 不命中旧缓存。
 *
 * 错误：GitError → error envelope（D10/P0-B）。code 取自 GitError.code；
 * sessionId 透传 details。GitExecutorError 已在 GitService.execSafe 中转为 GitError。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { ISessionService, IGitService } from '../interfaces.js'
import { GitError } from '../services/git-service.js'
import { sendHandlerError } from './handler-utils.js'

/** Interface for server methods needed by this handler */
export interface GitHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  gitService: IGitService
  /**
   * 广播 changeSet 失效通知（ADR-0024 D5 重构）。commit 成功后工作区 diff 已重置，
   * 旧的 changeSet 卡片成为过期数据。server 注入此方法向所有订阅该 session 的前端广播。
   */
  broadcastChangeSetInvalidated: (sessionId: string, reason: 'committed') => void
}

export class GitMessageHandler {
  constructor(private ctx: GitHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['git.status', 'git.diff', 'git.stage', 'git.unstage', 'git.commit', 'git.checkout', 'git.checkoutCwd', 'git.createBranch']

  /**
   * 路由分发（复杂度债清偿 U07）：switch 保留提供编译期类型收窄，每个 case 体提为
   * 私有方法（msg 以 Extract 收窄后传入）。reply / invalidateStatusCache / 广播的
   * 相对时序逐行保持。
   */
  async handleGitMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'git.status':
        return this.handleStatus(msg as Extract<ClientMessage, { type: 'git.status' }>, ws)
      case 'git.diff':
        return this.handleDiff(msg as Extract<ClientMessage, { type: 'git.diff' }>, ws)
      case 'git.stage':
        return this.handleStage(msg as Extract<ClientMessage, { type: 'git.stage' }>, ws)
      case 'git.unstage':
        return this.handleUnstage(msg as Extract<ClientMessage, { type: 'git.unstage' }>, ws)
      case 'git.commit':
        return this.handleCommit(msg as Extract<ClientMessage, { type: 'git.commit' }>, ws)
      case 'git.checkout':
        return this.handleCheckout(msg as Extract<ClientMessage, { type: 'git.checkout' }>, ws)
      case 'git.checkoutCwd':
        return this.handleCheckoutCwd(msg as Extract<ClientMessage, { type: 'git.checkoutCwd' }>, ws)
      case 'git.createBranch':
        return this.handleCreateBranch(msg as Extract<ClientMessage, { type: 'git.createBranch' }>, ws)
    }
  }

  private async handleStatus(msg: Extract<ClientMessage, { type: 'git.status' }>, ws: WsType): Promise<void> {
    const { sessionId } = msg.payload
    try {
      const result = await this.ctx.gitService.getStatus(sessionId)
      return this.ctx.reply(ws, msg.id, 'git.status:result', result)
    } catch (e) {
      return this.sendGitError(ws, msg.id, sessionId, e)
    }
  }

  private async handleDiff(msg: Extract<ClientMessage, { type: 'git.diff' }>, ws: WsType): Promise<void> {
    const { sessionId, path } = msg.payload
    try {
      const result = await this.ctx.gitService.getFileDiff(sessionId, path)
      return this.ctx.reply(ws, msg.id, 'git.diff:result', { sessionId, patch: result.patch, binary: result.binary })
    } catch (e) {
      return this.sendGitError(ws, msg.id, sessionId, e)
    }
  }

  private async handleStage(msg: Extract<ClientMessage, { type: 'git.stage' }>, ws: WsType): Promise<void> {
    const { sessionId, filePaths } = msg.payload
    try {
      await this.ctx.gitService.stage(sessionId, filePaths)
      // perf W17：写操作成功后失效状态缓存（下次 getStatus 拿新状态，无 2s 陈旧窗口）。
      // 必须在 reply 之前——前端收到 ack 后可能立即刷新 git zone。
      this.ctx.gitService.invalidateStatusCache({ sessionId })
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'staged' })
    } catch (e) {
      return this.sendGitError(ws, msg.id, sessionId, e)
    }
  }

  private async handleUnstage(msg: Extract<ClientMessage, { type: 'git.unstage' }>, ws: WsType): Promise<void> {
    const { sessionId, filePaths } = msg.payload
    try {
      await this.ctx.gitService.unstage(sessionId, filePaths)
      this.ctx.gitService.invalidateStatusCache({ sessionId })
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'unstaged' })
    } catch (e) {
      return this.sendGitError(ws, msg.id, sessionId, e)
    }
  }

  private async handleCommit(msg: Extract<ClientMessage, { type: 'git.commit' }>, ws: WsType): Promise<void> {
    const { sessionId, message } = msg.payload
    try {
      await this.ctx.gitService.commit(sessionId, message)
      // commit 成功后工作区 diff 已重置，通知前端旧 changeSet 失效（ADR-0024 D5 重构）。
      // 必须在 reply 之前广播——前端收到 status:'committed' 后可能立即刷新 git zone，
      // changeSetInvalidated 先到可避免卡片短暂停留在 ready 态。
      this.ctx.broadcastChangeSetInvalidated(sessionId, 'committed')
      this.ctx.gitService.invalidateStatusCache({ sessionId })
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'committed' })
    } catch (e) {
      return this.sendGitError(ws, msg.id, sessionId, e)
    }
  }

  private async handleCheckout(msg: Extract<ClientMessage, { type: 'git.checkout' }>, ws: WsType): Promise<void> {
    const { sessionId, name } = msg.payload
    try {
      await this.ctx.gitService.checkout(sessionId, name)
      // W17 审查 Fix-2：checkout 改变整个 worktree 的 HEAD，对共享该 cwd 的所有 session 可见
      // （与 checkoutCwd 是同一物理操作）→ 必须按 cwd 失效才与 checkoutCwd 对称；sessionId 兜底
      // （getSummary 竞态返回空时至少保住旧行为；checkout 成功 ⇒ session 必有 cwd，兜底仅防御）
      const cwd = this.ctx.sessionService.getSummary(sessionId)?.cwd
      this.ctx.gitService.invalidateStatusCache(cwd ? { sessionId, cwd } : { sessionId })
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'switched' })
    } catch (e) {
      return this.sendGitError(ws, msg.id, sessionId, e)
    }
  }

  private async handleCheckoutCwd(msg: Extract<ClientMessage, { type: 'git.checkoutCwd' }>, ws: WsType): Promise<void> {
    const { cwd, name } = msg.payload
    try {
      await this.ctx.gitService.checkoutByCwd(cwd, name)
      // session-less 写操作按 cwd 失效（覆盖共享该 cwd 的所有 session 缓存）
      this.ctx.gitService.invalidateStatusCache({ cwd })
      return this.ctx.reply(ws, msg.id, 'message.status', { status: 'switched' })
    } catch (e) {
      // 无 session 的 cwd-based checkout，error 不带 sessionId（landing 态无绑定 session）
      return this.sendGitError(ws, msg.id, undefined, e)
    }
  }

  private async handleCreateBranch(msg: Extract<ClientMessage, { type: 'git.createBranch' }>, ws: WsType): Promise<void> {
    const { sessionId, name } = msg.payload
    try {
      await this.ctx.gitService.createBranch(sessionId, name)
      this.ctx.gitService.invalidateStatusCache({ sessionId })
      return this.ctx.reply(ws, msg.id, 'message.status', { sessionId, status: 'branch_created' })
    } catch (e) {
      return this.sendGitError(ws, msg.id, sessionId, e)
    }
  }

  /**
   * 统一 git 错误回复（D10/P0-B）。
   * - GitError → 取其 code（session_not_found / path_not_allowed / git_conflict / commit_message_required / *_failed / invalid_branch_name / git_unavailable / git_failed）
   * - 其它 → 'git_failed' + toErrorMessage
   * sessionId 透传 details（matched 与 fallback 两分支都带）。
   */
  private sendGitError(ws: WsType, id: string | undefined, sessionId: string | undefined, e: unknown): void {
    sendHandlerError(this.ctx, ws, GitError, 'git_failed', e, id, sessionId ? { sessionId } : undefined)
  }
}
